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

        for event in events {
            match event {
                L1Event::L2Execution { performed, consumed } => {
                    info!(
                        "L2ExecutionPerformed at L1 block {}: {} -> {}",
                        performed.l1_block_number,
                        &format!("0x{}", hex::encode(&performed.current_state.0))[..12],
                        &format!("0x{}", hex::encode(&performed.new_state.0))[..12],
                    );

                    // Check if L2 state already matches (pre-executed on builder)
                    let actual_state = self.get_actual_state_root().await?;
                    if actual_state == performed.new_state && performed.current_state != performed.new_state {
                        info!("L2 state already matches (pre-executed), skipping replay");
                        self.tracked_state_root = performed.new_state;
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

                // Ensure proxy is deployed (preparation tx)
                self.ensure_proxy_deployed(&source_address).await?;

                // Send the main call as operator system tx
                let raw_tx = self.tx_signer.sign_tx(
                    &l2_target,
                    call_data,
                    value,
                    10_000_000,
                )?;
                self.l2_client.send_raw_transaction(&raw_tx).await?;

                // Mine ONE block with all pending txs (proxy deploy + main call)
                let (block_hash, _state_root) = self.engine.mine_block(&self.l2_client, None, None).await?;
                info!("L1→L2 call mined in block {block_hash}");
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

                let (block_hash, _state_root) = self.engine.mine_block(&self.l2_client, None, None).await?;
                info!("L2TX mined in block {block_hash}");
                return Ok(());
            }
        }

        warn!("Could not determine execution type for L1 tx 0x{}...", &hex::encode(&performed.l1_tx_hash.0)[..8]);
        Ok(())
    }

    /// Ensure a CrossChainProxy is deployed on L2 for the given address.
    /// If not deployed, sends a deployment tx to the txpool (no mining).
    async fn ensure_proxy_deployed(&mut self, original_address: &Address) -> Result<()> {
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
