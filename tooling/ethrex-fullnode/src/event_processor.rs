/// Event processor — replays L1 events on the L2 ethrex chain.
///
/// For each L2ExecutionPerformed event:
/// 1. Fetch the L1 transaction to determine the function type
/// 2. For executeL2TX: broadcast the raw L2 transaction
/// 3. For cross-chain calls: deploy proxy if needed, then execute the call
/// 4. Mine a single L2 block (Rule 1 of state transition spec)
/// 5. Verify the L2 state root matches the expected value
use alloy_primitives::{Address, B256, U256};
use eyre::Result;
use tracing::{error, info, warn};

use crate::engine::EngineClient;
use crate::l1_watcher::{L1Event, L1Watcher};
use crate::rpc_client::RpcClient;
use crate::tx_signer::TxSigner;
use crate::types::{ActionType, fn_selectors};

pub struct EventProcessor {
    l1_watcher: L1Watcher,
    l2_client: RpcClient,
    engine: EngineClient,
    tx_signer: TxSigner,
    rollups_address: Address,
    rollup_id: u64,
    l2_chain_id: u64,
    tracked_state_root: B256,
}

impl EventProcessor {
    pub fn new(
        l1_watcher: L1Watcher,
        l2_client: RpcClient,
        engine: EngineClient,
        tx_signer: TxSigner,
        rollups_address: Address,
        rollup_id: u64,
        l2_chain_id: u64,
        initial_state_root: B256,
    ) -> Self {
        Self {
            l1_watcher,
            l2_client,
            engine,
            tx_signer,
            rollups_address,
            rollup_id,
            l2_chain_id,
            tracked_state_root: initial_state_root,
        }
    }

    /// Process one poll cycle. Returns true if any events were processed.
    pub async fn process_cycle(&mut self) -> Result<bool> {
        let events = self.l1_watcher.poll().await?;
        if events.is_empty() {
            return Ok(false);
        }

        // Group consecutive L2Execution events from the same L1 tx for batch replay
        let mut i = 0;
        while i < events.len() {
            match &events[i] {
                L1Event::L2Execution { performed, consumed: _ } => {
                    // Collect all L2Execution events from the same L1 block
                    let l1_block = performed.l1_block_number;
                    let mut batch: Vec<usize> = vec![i];
                    while i + batch.len() < events.len() {
                        if let L1Event::L2Execution { performed: next_p, .. } = &events[i + batch.len()] {
                            if next_p.l1_block_number == l1_block {
                                batch.push(i + batch.len());
                                continue;
                            }
                        }
                        break;
                    }

                    if batch.len() > 1 {
                        // Filter out L1-only accounting events (currentState == newState)
                        // These don't produce L2 blocks and should not be included in batch replay
                        let all_events: Vec<_> = batch.iter().map(|&idx| {
                            if let L1Event::L2Execution { performed, consumed } = &events[idx] {
                                (performed.clone(), consumed.clone())
                            } else {
                                unreachable!()
                            }
                        }).collect();

                        let replay_events: Vec<_> = all_events.iter()
                            .filter(|(p, _)| p.current_state != p.new_state)
                            .cloned()
                            .collect();

                        if replay_events.len() > 1 {
                            // True batch: multiple events need L2 replay
                            info!("Batch of {} L2TXs from same L1 block", replay_events.len());

                            if let Err(e) = self.replay_batch_execution(&replay_events).await {
                                error!("Failed to replay batch: {e}");
                            }

                            let final_replay_state = replay_events.last().unwrap().0.new_state;
                            let actual_state = self.get_actual_state_root().await?;
                            if actual_state != final_replay_state {
                                warn!(
                                    "Batch state mismatch! Expected: 0x{}..., Got: 0x{}...",
                                    &hex::encode(&final_replay_state.0)[..8],
                                    &hex::encode(&actual_state.0)[..8],
                                );
                            }
                            self.tracked_state_root = final_replay_state;
                            info!(
                                "Batch state updated to: 0x{}...",
                                &hex::encode(&final_replay_state.0)[..8],
                            );

                            // Process L1-only accounting events
                            for (perf, _consumed) in &all_events {
                                if perf.current_state == perf.new_state {
                                    info!("L1-only accounting event (currentState == newState), no L2 replay needed");
                                    self.tracked_state_root = perf.new_state;
                                }
                            }

                            i += batch.len();
                            continue;
                        }

                        // 0-1 events need L2 replay — don't batch, fall through to
                        // process each event individually via the normal single-event path
                    }

                    // Single event processing (original logic)
                    let performed = performed.clone();
                    let consumed = if let L1Event::L2Execution { consumed, .. } = &events[i] {
                        consumed.clone()
                    } else {
                        None
                    };

                    info!(
                        "L2ExecutionPerformed at L1 block {}: {} -> {}",
                        performed.l1_block_number,
                        &format!("0x{}", hex::encode(&performed.current_state.0))[..12],
                        &format!("0x{}", hex::encode(&performed.new_state.0))[..12],
                    );

                    // When currentState == newState, this is an L1-only accounting event
                    // (e.g., ether delta from an L2→L1 withdrawal continuation).
                    // No L2 state change, no L2 block to mine.
                    if performed.current_state == performed.new_state {
                        info!("L1-only accounting event (currentState == newState), no L2 replay needed");
                        self.tracked_state_root = performed.new_state;
                        i += 1;
                        continue;
                    }

                    // Check if L2 state already matches (pre-executed on builder)
                    let actual_state = self.get_actual_state_root().await?;
                    if actual_state == performed.new_state {
                        info!("L2 state already matches (pre-executed), skipping replay");
                        self.tracked_state_root = performed.new_state;
                        i += 1;
                        continue;
                    }

                    // Replay the execution
                    if let Err(e) = self.replay_execution(&performed, &consumed).await {
                        error!("Failed to replay execution: {e}");
                    }

                    // Verify state root
                    let actual_state = self.get_actual_state_root().await?;
                    if actual_state != performed.new_state {
                        warn!(
                            "State mismatch! Expected: 0x{}..., Got: 0x{}...",
                            &hex::encode(&performed.new_state.0)[..8],
                            &hex::encode(&actual_state.0)[..8],
                        );
                    }

                    self.tracked_state_root = performed.new_state;
                    info!(
                        "State updated to: 0x{}...",
                        &hex::encode(&performed.new_state.0)[..8],
                    );
                }
                L1Event::StateUpdated(state_update) => {
                    info!(
                        "StateUpdated (owner bypass): 0x{}...",
                        &hex::encode(&state_update.new_state_root.0)[..8],
                    );
                    self.tracked_state_root = state_update.new_state_root;
                }
            }
            i += 1;
        }

        Ok(true)
    }

    /// Replay an L2 execution based on the L1 transaction
    async fn replay_execution(
        &mut self,
        performed: &crate::types::L2ExecutionPerformed,
        consumed: &Option<crate::types::ExecutionConsumed>,
    ) -> Result<()> {
        // Check if there's an ExecutionConsumed event with a Call action (cross-chain calls, bridge deposits)
        if let Some(consumed) = consumed {
            if consumed.action.action_type == ActionType::Call {
                let l2_target = consumed.action.destination;
                let source_address = consumed.action.source_address;
                let call_data = &consumed.action.data;
                let value = consumed.action.value;

                info!(
                    "L1→L2 call: target={:?}, source={:?}, value={}",
                    l2_target, source_address, value
                );

                // Compute base fee for system tx determinism
                let next_base_fee = self.get_next_base_fee().await?;

                // Ensure proxy is deployed (preparation tx)
                self.ensure_proxy_deployed(&source_address, next_base_fee).await?;

                // Send the main call as operator system tx
                let raw_tx = self.tx_signer.sign_tx(
                    &l2_target,
                    call_data,
                    value,
                    10_000_000,
                    next_base_fee,
                )?;
                self.l2_client.send_raw_transaction(&raw_tx).await?;

                // Mine ONE block with all pending txs (proxy deploy + main call)
                // Use L1 block timestamp for deterministic state roots
                let (block_hash, _state_root) = self.engine.mine_block(&self.l2_client, None, Some(performed.l1_block_timestamp)).await?;
                info!("L1→L2 call mined in block {block_hash} (timestamp={})", performed.l1_block_timestamp);
                return Ok(());
            }
            // For L2TX and other action types, fall through to L1 tx decoding
        }

        // No ExecutionConsumed — try to decode from L1 transaction (executeL2TX)
        let l1_tx = self.l1_watcher.get_transaction(performed.l1_tx_hash).await?;
        let tx_input = l1_tx["input"].as_str().unwrap_or("0x");
        let tx_input_bytes = hex::decode(tx_input.strip_prefix("0x").unwrap_or(tx_input))?;

        if tx_input_bytes.len() >= 4 {
            let selector: [u8; 4] = tx_input_bytes[0..4].try_into()?;

            if selector == fn_selectors::execute_l2tx() {
                // executeL2TX(uint256 rollupId, bytes rlpEncodedTx)
                let rlp_encoded_tx = decode_bytes_param(&tx_input_bytes, 1)?;
                let rlp_hex = format!("0x{}", hex::encode(&rlp_encoded_tx));

                info!("L2TX: broadcasting raw transaction");

                let tx_hash = self.l2_client.send_raw_transaction(&rlp_hex).await?;
                info!("L2TX sent: {tx_hash}");

                let (block_hash, _state_root) = self.engine.mine_block(&self.l2_client, None, Some(performed.l1_block_timestamp)).await?;
                info!("L2TX mined in block {block_hash} (timestamp={})", performed.l1_block_timestamp);
                return Ok(());
            }
        }

        warn!("Could not determine execution type for L1 tx 0x{}...", &hex::encode(&performed.l1_tx_hash.0)[..8]);
        Ok(())
    }

    /// Replay a batch of L2TX events from the same L1 block as a single L2 block.
    async fn replay_batch_execution(
        &mut self,
        batch: &[(crate::types::L2ExecutionPerformed, Option<crate::types::ExecutionConsumed>)],
    ) -> Result<()> {
        // Each event has its own L1 tx hash (separate executeL2TX calls in same L1 block).
        // Decode the L2TX from each event's L1 transaction.
        let mut sent_count = 0u64;
        for (performed, _consumed) in batch {
            let l1_tx = self.l1_watcher.get_transaction(performed.l1_tx_hash).await?;
            let tx_input = l1_tx["input"].as_str().unwrap_or("0x");
            let tx_input_bytes = hex::decode(tx_input.strip_prefix("0x").unwrap_or(tx_input))?;

            if tx_input_bytes.len() >= 4 {
                let selector: [u8; 4] = tx_input_bytes[0..4].try_into()?;
                if selector == fn_selectors::execute_l2tx() {
                    let rlp_encoded_tx = decode_bytes_param(&tx_input_bytes, 1)?;
                    let rlp_hex = format!("0x{}", hex::encode(&rlp_encoded_tx));

                    // Send to txpool without mining
                    match self.l2_client.send_raw_transaction(&rlp_hex).await {
                        Ok(_) => sent_count += 1,
                        Err(e) => warn!("Failed to send batch tx to txpool: {e}"),
                    }
                } else {
                    warn!("Non-executeL2TX call in batch, skipping");
                }
            }
        }

        if sent_count == 0 {
            eyre::bail!("No executeL2TX transactions decoded from batch events");
        }

        // Mine ONE L2 block containing all the transactions
        // Use L1 block timestamp for deterministic state roots
        let batch_timestamp = batch[0].0.l1_block_timestamp;
        let (block_hash, _state_root) = self.engine.mine_block(&self.l2_client, None, Some(batch_timestamp)).await?;
        info!("Batch of {} L2TXs mined in block {} (timestamp={})", sent_count, block_hash, batch_timestamp);

        Ok(())
    }

    /// Ensure a CrossChainProxy is deployed on L2 for the given address.
    /// If not deployed, sends a deployment tx to the txpool (no mining).
    async fn ensure_proxy_deployed(&mut self, original_address: &Address, max_fee_per_gas: u64) -> Result<()> {
        let rollups_hex = format!("{:?}", self.rollups_address);

        // Compute expected proxy address via eth_call to computeCrossChainProxyAddress
        let selector = fn_selectors::compute_cross_chain_proxy_address();
        let mut calldata = Vec::from(selector);
        // address originalAddress (padded to 32 bytes)
        calldata.extend_from_slice(&[0u8; 12]);
        calldata.extend_from_slice(original_address.as_slice());
        // uint256 originalRollupId
        let mut rollup_bytes = [0u8; 32];
        rollup_bytes[24..32].copy_from_slice(&self.rollup_id.to_be_bytes());
        calldata.extend_from_slice(&rollup_bytes);
        // uint256 domain (L2 chain ID)
        let mut domain_bytes = [0u8; 32];
        domain_bytes[24..32].copy_from_slice(&self.l2_chain_id.to_be_bytes());
        calldata.extend_from_slice(&domain_bytes);

        let calldata_hex = format!("0x{}", hex::encode(&calldata));
        let result = self.l2_client.eth_call(&rollups_hex, &calldata_hex).await?;

        // Extract address from result (last 20 bytes of 32-byte response)
        let result_bytes = hex::decode(result.strip_prefix("0x").unwrap_or(&result))?;
        if result_bytes.len() < 32 {
            eyre::bail!("computeCrossChainProxyAddress returned invalid data");
        }
        let proxy_address = Address::from_slice(&result_bytes[12..32]);
        let proxy_hex = format!("{:?}", proxy_address);

        // Check if proxy already has code
        let code = self.l2_client.get_code(&proxy_hex).await?;
        if code != "0x" && code != "0x0" {
            return Ok(()); // Already deployed
        }

        info!("Deploying CrossChainProxy for {:?} at {:?}", original_address, proxy_address);

        // Deploy via createCrossChainProxy(address, uint256)
        let deploy_selector = fn_selectors::create_cross_chain_proxy();
        let mut deploy_data = Vec::from(deploy_selector);
        deploy_data.extend_from_slice(&[0u8; 12]);
        deploy_data.extend_from_slice(original_address.as_slice());
        deploy_data.extend_from_slice(&rollup_bytes);

        let raw_tx = self.tx_signer.sign_tx(
            &self.rollups_address,
            &deploy_data,
            U256::ZERO,
            10_000_000,
            max_fee_per_gas,
        )?;

        // Send to txpool (no mining — will be included in the next mineBlock)
        self.l2_client.send_raw_transaction(&raw_tx).await?;
        info!("CrossChainProxy deployment tx sent");

        Ok(())
    }

    /// Get the actual L2 state root from ethrex
    async fn get_actual_state_root(&self) -> Result<B256> {
        let block = self.l2_client.get_latest_block().await?;
        let state_root_hex = block["stateRoot"].as_str().unwrap_or("0x");
        let bytes = hex::decode(state_root_hex.strip_prefix("0x").unwrap_or(state_root_hex))?;
        if bytes.len() == 32 {
            Ok(B256::from_slice(&bytes))
        } else {
            Ok(B256::ZERO)
        }
    }

    /// Compute the expected base fee for the next L2 block (EIP-1559 formula).
    /// Used to set maxFeePerGas on system transactions for determinism.
    async fn get_next_base_fee(&self) -> Result<u64> {
        let block = self.l2_client.get_latest_block().await?;
        let base_fee = parse_u64_hex_str(block["baseFeePerGas"].as_str().unwrap_or("0x0"));
        let gas_used = parse_u64_hex_str(block["gasUsed"].as_str().unwrap_or("0x0"));
        let gas_limit = parse_u64_hex_str(block["gasLimit"].as_str().unwrap_or("0x1c9c380"));
        Ok(compute_next_base_fee(base_fee, gas_used, gas_limit))
    }

    pub fn tracked_state_root(&self) -> B256 {
        self.tracked_state_root
    }

    pub fn last_processed_l1_block(&self) -> u64 {
        self.l1_watcher.last_processed_block()
    }
}

/// Decode a dynamic bytes parameter from ABI-encoded calldata.
/// `param_index` is the 0-based index of the parameter (after the 4-byte selector).
fn decode_bytes_param(calldata: &[u8], param_index: usize) -> Result<Vec<u8>> {
    let base = 4; // skip function selector
    let offset_pos = base + param_index * 32;

    if calldata.len() < offset_pos + 32 {
        eyre::bail!("Calldata too short for param {param_index}");
    }

    let offset = U256::from_be_bytes::<32>(
        calldata[offset_pos..offset_pos + 32].try_into()?,
    ).to::<usize>();

    let data_start = base + offset;
    if calldata.len() < data_start + 32 {
        eyre::bail!("Calldata too short for bytes data");
    }

    let length = U256::from_be_bytes::<32>(
        calldata[data_start..data_start + 32].try_into()?,
    ).to::<usize>();

    let bytes_start = data_start + 32;
    if calldata.len() < bytes_start + length {
        eyre::bail!("Calldata too short for bytes content");
    }

    Ok(calldata[bytes_start..bytes_start + length].to_vec())
}

/// Parse hex string to u64 (for block header fields)
fn parse_u64_hex_str(s: &str) -> u64 {
    let s = s.strip_prefix("0x").unwrap_or(s);
    u64::from_str_radix(s, 16).unwrap_or(0)
}

/// Compute the next block's base fee using the EIP-1559 formula.
/// Must match the TypeScript implementation exactly for determinism.
fn compute_next_base_fee(parent_base_fee: u64, parent_gas_used: u64, parent_gas_limit: u64) -> u64 {
    let gas_target = parent_gas_limit / 2;
    if gas_target == 0 {
        return parent_base_fee;
    }

    if parent_gas_used == gas_target {
        parent_base_fee
    } else if parent_gas_used > gas_target {
        let delta = parent_base_fee as u128 * (parent_gas_used - gas_target) as u128
            / gas_target as u128
            / 8;
        let delta = if delta > 0 { delta } else { 1 };
        (parent_base_fee as u128 + delta) as u64
    } else {
        let delta = parent_base_fee as u128 * (gas_target - parent_gas_used) as u128
            / gas_target as u128
            / 8;
        let new_base_fee = parent_base_fee as u128 - delta;
        if new_base_fee > 0 { new_base_fee as u64 } else { 0 }
    }
}
