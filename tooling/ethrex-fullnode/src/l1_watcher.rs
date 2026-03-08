/// L1 Watcher — monitors the Rollups contract for L2-relevant events.
///
/// Watches for:
/// - L2ExecutionPerformed: triggers L2 block production
/// - ExecutionConsumed: provides action details for replay
/// - StateUpdated: owner-bypass state updates (no L2 replay)
use alloy_primitives::{Address, B256, U256};
use eyre::Result;
use serde_json::Value;
use tracing::{debug, warn};

use crate::rpc_client::RpcClient;
use crate::types::{
    Action, ActionType, ExecutionConsumed, L2ExecutionPerformed, StateUpdated, event_sigs,
};

pub struct L1Watcher {
    client: RpcClient,
    rollups_address: Address,
    rollup_id: u64,
    last_processed_block: u64,
}

impl L1Watcher {
    pub fn new(l1_rpc_url: &str, rollups_address: Address, rollup_id: u64, start_block: u64) -> Self {
        Self {
            client: RpcClient::new(l1_rpc_url),
            rollups_address,
            rollup_id,
            last_processed_block: start_block.saturating_sub(1),
        }
    }

    /// Poll for new L1 events. Returns a list of L2-relevant events to process.
    pub async fn poll(&mut self) -> Result<Vec<L1Event>> {
        let current_block = self.client.get_block_number().await?;
        if current_block <= self.last_processed_block {
            return Ok(vec![]);
        }

        let from_block = self.last_processed_block + 1;
        let to_block = current_block;

        debug!("Scanning L1 blocks {from_block}..{to_block}");

        let events = self.get_events(from_block, to_block).await?;
        self.last_processed_block = to_block;

        Ok(events)
    }

    /// Fetch and decode events from the L1 contract
    async fn get_events(&self, from_block: u64, to_block: u64) -> Result<Vec<L1Event>> {
        let address_hex = format!("{:?}", self.rollups_address);

        // Fetch all relevant logs in one call
        let logs = self.client.get_logs(
            from_block,
            to_block,
            &address_hex,
            &[],  // all topics — we filter locally
        ).await?;

        let mut events = Vec::new();

        // Group logs by transaction hash for correlated event processing
        let l2_exec_sig = event_sigs::l2_execution_performed();
        let exec_consumed_sig = event_sigs::execution_consumed();
        let state_updated_sig = event_sigs::state_updated();

        // First pass: collect L2ExecutionPerformed events
        let mut exec_performed_by_tx: std::collections::HashMap<B256, Vec<L2ExecutionPerformed>> =
            std::collections::HashMap::new();

        for log in &logs {
            let empty_vec = vec![];
            let topics = log["topics"].as_array().unwrap_or(&empty_vec);
            if topics.is_empty() {
                continue;
            }

            let topic0 = parse_b256(topics[0].as_str().unwrap_or_default());

            if topic0 == l2_exec_sig {
                // L2ExecutionPerformed(uint256 indexed rollupId, bytes32 currentState, bytes32 newState)
                if topics.len() < 2 {
                    continue;
                }
                let rollup_id = U256::from_be_bytes(
                    parse_b256(topics[1].as_str().unwrap_or_default()).0,
                );

                if rollup_id != U256::from(self.rollup_id) {
                    continue;
                }

                let data = hex_decode(log["data"].as_str().unwrap_or("0x"));
                if data.len() < 64 {
                    continue;
                }

                let current_state = B256::from_slice(&data[0..32]);
                let new_state = B256::from_slice(&data[32..64]);
                let block_number = parse_u64_hex(log["blockNumber"].as_str().unwrap_or("0x0"));
                let tx_hash = parse_b256(log["transactionHash"].as_str().unwrap_or_default());

                let event = L2ExecutionPerformed {
                    rollup_id,
                    current_state,
                    new_state,
                    l1_block_number: block_number,
                    l1_tx_hash: tx_hash,
                };

                exec_performed_by_tx
                    .entry(tx_hash)
                    .or_default()
                    .push(event);
            } else if topic0 == state_updated_sig {
                // StateUpdated(uint256 indexed rollupId, bytes32 newStateRoot)
                if topics.len() < 2 {
                    continue;
                }
                let rollup_id = U256::from_be_bytes(
                    parse_b256(topics[1].as_str().unwrap_or_default()).0,
                );
                if rollup_id != U256::from(self.rollup_id) {
                    continue;
                }

                let data = hex_decode(log["data"].as_str().unwrap_or("0x"));
                if data.len() < 32 {
                    continue;
                }
                let new_state_root = B256::from_slice(&data[0..32]);

                events.push(L1Event::StateUpdated(StateUpdated {
                    rollup_id,
                    new_state_root,
                }));
            }
        }

        // Second pass: collect ExecutionConsumed events and pair with L2ExecutionPerformed
        let mut consumed_by_tx: std::collections::HashMap<B256, Vec<ExecutionConsumed>> =
            std::collections::HashMap::new();

        for log in &logs {
            let empty_vec2 = vec![];
            let topics = log["topics"].as_array().unwrap_or(&empty_vec2);
            if topics.is_empty() {
                continue;
            }

            let topic0 = parse_b256(topics[0].as_str().unwrap_or_default());

            if topic0 == exec_consumed_sig {
                let tx_hash = parse_b256(log["transactionHash"].as_str().unwrap_or_default());
                let data = hex_decode(log["data"].as_str().unwrap_or("0x"));
                // actionHash is indexed (topics[1])
                let action_hash = if topics.len() > 1 {
                    parse_b256(topics[1].as_str().unwrap_or_default())
                } else {
                    B256::ZERO
                };

                match decode_execution_consumed(&data, action_hash) {
                    Ok(consumed) => {
                        consumed_by_tx
                            .entry(tx_hash)
                            .or_default()
                            .push(consumed);
                    }
                    Err(e) => {
                        warn!("Failed to decode ExecutionConsumed: {e}");
                    }
                }
            }
        }

        // Build L2Execution events by pairing L2ExecutionPerformed with ExecutionConsumed
        // Sort by block number for deterministic ordering
        let mut exec_events: Vec<(u64, B256, L2ExecutionPerformed, Option<ExecutionConsumed>)> = Vec::new();
        for (tx_hash, performed_list) in &exec_performed_by_tx {
            let consumed_list = consumed_by_tx.get(tx_hash);
            for (i, performed) in performed_list.iter().enumerate() {
                let consumed = consumed_list.and_then(|list| list.get(i)).cloned();
                exec_events.push((
                    performed.l1_block_number,
                    *tx_hash,
                    performed.clone(),
                    consumed,
                ));
            }
        }

        // Sort by L1 block number, then by tx index
        exec_events.sort_by_key(|(block, tx_hash, _, _)| (*block, *tx_hash));

        for (_, _, performed, consumed) in exec_events {
            events.push(L1Event::L2Execution {
                performed,
                consumed,
            });
        }

        Ok(events)
    }

    /// Get the full L1 transaction by hash (for decoding function calls)
    pub async fn get_transaction(&self, tx_hash: B256) -> Result<Value> {
        self.client.get_transaction_by_hash(tx_hash).await
    }

    /// Get the L1 block by number
    pub async fn get_block(&self, block_number: u64) -> Result<Value> {
        self.client.get_block_by_number(block_number).await
    }

    pub fn last_processed_block(&self) -> u64 {
        self.last_processed_block
    }
}

/// L1 events relevant to the L2 fullnode
#[derive(Debug)]
pub enum L1Event {
    /// An L2 execution was performed — requires L2 block production
    L2Execution {
        performed: L2ExecutionPerformed,
        consumed: Option<ExecutionConsumed>,
    },
    /// State was updated by the rollup owner (no L2 replay needed)
    StateUpdated(StateUpdated),
}

/// Decode ExecutionConsumed event data.
/// actionHash is indexed (in topics[1]), so data contains only the Action tuple.
/// The Action tuple is dynamic (contains bytes, uint256[]), so data starts with
/// an offset pointer to the actual tuple data.
fn decode_execution_consumed(data: &[u8], action_hash: B256) -> Result<ExecutionConsumed> {
    if data.len() < 32 {
        eyre::bail!("ExecutionConsumed data too short: {} bytes", data.len());
    }

    // Data contains ABI-encoded Action tuple (dynamic type)
    // First word is offset pointer to the tuple start
    let tuple_offset = U256::from_be_bytes::<32>(data[0..32].try_into()?).to::<usize>();
    let action_start = tuple_offset;

    if data.len() < action_start + 9 * 32 {
        eyre::bail!("ExecutionConsumed action data too short");
    }

    let action = decode_action(&data[action_start..])?;

    Ok(ExecutionConsumed {
        action_hash,
        action,
    })
}

/// Decode an ABI-encoded Action tuple
fn decode_action(data: &[u8]) -> Result<Action> {
    // Action is: (uint8, uint256, address, uint256, bytes, bool, address, uint256, uint256[])
    // Fixed fields are at known offsets (each 32 bytes)
    if data.len() < 9 * 32 {
        eyre::bail!("Action data too short: {} bytes", data.len());
    }

    let action_type = ActionType::from(data[31]); // uint8 at end of first 32-byte word
    let rollup_id = U256::from_be_bytes::<32>(data[32..64].try_into()?);
    let destination = Address::from_slice(&data[76..96]); // address at end of third word
    let value = U256::from_be_bytes::<32>(data[96..128].try_into()?);

    // bytes data — dynamic, offset at word 4
    let data_offset = U256::from_be_bytes::<32>(data[128..160].try_into()?).to::<usize>();
    let action_data = if data_offset > 0 && data.len() > data_offset {
        decode_bytes(&data[data_offset..])?
    } else {
        vec![]
    };

    let failed = data[191] != 0; // bool at end of word 5
    let source_address = Address::from_slice(&data[204..224]); // address at end of word 6
    let source_rollup = U256::from_be_bytes::<32>(data[224..256].try_into()?);

    // scope — dynamic array, offset at word 8
    let scope_offset = U256::from_be_bytes::<32>(data[256..288].try_into()?).to::<usize>();
    let scope = if scope_offset > 0 && data.len() > scope_offset {
        decode_uint256_array(&data[scope_offset..])?
    } else {
        vec![]
    };

    Ok(Action {
        action_type,
        rollup_id,
        destination,
        value,
        data: action_data,
        failed,
        source_address,
        source_rollup,
        scope,
    })
}

/// Decode ABI-encoded bytes
fn decode_bytes(data: &[u8]) -> Result<Vec<u8>> {
    if data.len() < 32 {
        return Ok(vec![]);
    }
    let len = U256::from_be_bytes::<32>(data[0..32].try_into()?).to::<usize>();
    if data.len() < 32 + len {
        eyre::bail!("bytes data too short");
    }
    Ok(data[32..32 + len].to_vec())
}

/// Decode ABI-encoded uint256[]
fn decode_uint256_array(data: &[u8]) -> Result<Vec<U256>> {
    if data.len() < 32 {
        return Ok(vec![]);
    }
    let len = U256::from_be_bytes::<32>(data[0..32].try_into()?).to::<usize>();
    let mut result = Vec::with_capacity(len);
    for i in 0..len {
        let offset = 32 + i * 32;
        if data.len() < offset + 32 {
            break;
        }
        result.push(U256::from_be_bytes::<32>(data[offset..offset + 32].try_into()?));
    }
    Ok(result)
}

/// Parse a hex string to B256
fn parse_b256(s: &str) -> B256 {
    let s = s.strip_prefix("0x").unwrap_or(s);
    if s.is_empty() {
        return B256::ZERO;
    }
    let padded = format!("{:0>64}", s);
    let bytes = hex::decode(&padded).unwrap_or_else(|_| vec![0u8; 32]);
    B256::from_slice(&bytes)
}

/// Parse hex string to u64
fn parse_u64_hex(s: &str) -> u64 {
    let s = s.strip_prefix("0x").unwrap_or(s);
    u64::from_str_radix(s, 16).unwrap_or(0)
}

/// Decode hex string to bytes
fn hex_decode(s: &str) -> Vec<u8> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    hex::decode(s).unwrap_or_default()
}
