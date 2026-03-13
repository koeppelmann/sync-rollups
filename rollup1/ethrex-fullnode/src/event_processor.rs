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
use crate::types::{ActionType, ExecutionConsumed, fn_selectors};

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
                L1Event::L2Execution { performed, consumed: _, l2_to_l1_result: _ } => {
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
                            if let L1Event::L2Execution { performed, consumed, l2_to_l1_result } = &events[idx] {
                                (performed.clone(), consumed.clone(), l2_to_l1_result.clone())
                            } else {
                                unreachable!()
                            }
                        }).collect();

                        let replay_events: Vec<_> = all_events.iter()
                            .filter(|(p, _, _)| p.current_state != p.new_state)
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
                            for (perf, _consumed, _l2_to_l1) in &all_events {
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
                    let (consumed, l2_to_l1_result) = if let L1Event::L2Execution { consumed, l2_to_l1_result, .. } = &events[i] {
                        (consumed.clone(), l2_to_l1_result.clone())
                    } else {
                        (None, None)
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
                    if let Err(e) = self.replay_execution(&performed, &consumed, &l2_to_l1_result).await {
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
        l2_to_l1_result: &Option<crate::types::ExecutionConsumed>,
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

                let next_base_fee = self.get_next_base_fee().await?;

                // Route all L1→L2 calls through loadExecutionTable + executeIncomingCrossChainCall
                // (now payable, so value transfers work too).

                // Step 1: Dry-run to predict return data from the destination call.
                let target_hex = format!("{:?}", l2_target);
                let value_hex = format!("0x{:x}", value);
                let data_hex = format!("0x{}", hex::encode(call_data));
                let operator_hex = format!("{:?}", self.tx_signer.address);
                let (raw_return_data, call_success) = self.l2_client.eth_call_full(
                    &operator_hex, &target_hex, &value_hex, &data_hex
                ).await?;
                info!(
                    "Dry-run eth_call: success={}, return_data={}",
                    call_success,
                    &raw_return_data[..std::cmp::min(raw_return_data.len(), 70)]
                );
                let raw_return_bytes = hex::decode(
                    raw_return_data.strip_prefix("0x").unwrap_or(&raw_return_data)
                ).unwrap_or_default();

                // Step 2: Use raw return data as-is to match what _processCallAtScope captures.
                // CrossChainProxy.executeOnBehalf uses assembly return, so the caller's .call()
                // gets the raw bytes from the destination — NOT ABI-wrapped.
                let proxy_return_data = raw_return_bytes.clone();

                // Step 3: Build the RESULT action
                let rollup_id = U256::from(self.rollup_id);
                let result_action_encoded = abi_encode_action(
                    1, rollup_id, Address::ZERO, U256::ZERO,
                    &proxy_return_data, !call_success,
                    Address::ZERO, U256::ZERO, &[],
                );

                // Step 4: Hash it — abi.encode(action) wraps dynamic tuple with 0x20 offset
                let mut abi_encoded = Vec::new();
                abi_encoded.extend_from_slice(&encode_u256(0x20));
                abi_encoded.extend_from_slice(&result_action_encoded);
                let result_hash = keccak256_bytes(&abi_encoded);
                info!(
                    "RESULT action: rollupId={}, failed={}, data_len={}, proxy_data_len={}, hash=0x{}",
                    self.rollup_id,
                    !call_success,
                    raw_return_bytes.len(),
                    proxy_return_data.len(),
                    hex::encode(&result_hash.0),
                );

                // Step 5: Build loadExecutionTable calldata
                let load_calldata = build_load_execution_table_calldata(&result_hash);

                // Step 6: Send loadExecutionTable as system tx
                let load_tx = self.tx_signer.sign_tx(
                    &self.rollups_address, &load_calldata,
                    U256::ZERO, 10_000_000, next_base_fee,
                )?;
                self.l2_client.send_raw_transaction(&load_tx).await?;

                // Step 7: Send executeIncomingCrossChainCall (payable — value forwarded)
                let exec_calldata = build_execute_incoming_calldata(
                    &l2_target, value, call_data, &source_address,
                    consumed.action.source_rollup,
                );
                let exec_tx = self.tx_signer.sign_tx(
                    &self.rollups_address, &exec_calldata,
                    value, 10_000_000, next_base_fee,
                )?;
                self.l2_client.send_raw_transaction(&exec_tx).await?;

                // Step 8: Mine one block with both txs
                let (block_hash, _state_root) = self.engine.mine_block(&self.l2_client, None, Some(performed.l1_block_timestamp)).await?;
                info!("L1→L2 call executed via loadExecutionTable + executeIncomingCrossChainCall in block {block_hash}");
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

                // L2→L1 call: pre-load execution entry before broadcasting
                if let Some(result_consumed) = l2_to_l1_result {
                    info!("L2→L1 call detected (2 ExecutionConsumed events)");

                    // Look up proxy info from L2 state
                    let parsed_tx = rlp_decode_tx_minimal(&rlp_encoded_tx)?;
                    if let Some(proxy_addr) = &parsed_tx.to {
                        let proxy_info = self.l2_client.call_authorized_proxies(
                            &format!("{:?}", self.rollups_address),
                            &format!("0x{}", hex::encode(proxy_addr)),
                        ).await?;

                        // Build CALL action the proxy will construct
                        let call_action_encoded = abi_encode_action(
                            0, // CALL
                            proxy_info.original_rollup_id,
                            proxy_info.original_address,
                            parsed_tx.value,
                            &parsed_tx.data,
                            false,
                            parsed_tx.from,
                            U256::from(self.rollup_id),
                            &[],
                        );

                        // Hash the CALL action
                        let mut abi_encoded = Vec::new();
                        abi_encoded.extend_from_slice(&encode_u256(0x20));
                        abi_encoded.extend_from_slice(&call_action_encoded);
                        let call_hash = keccak256_bytes(&abi_encoded);

                        // Build RESULT nextAction from the L1 execution result
                        let result_data = &result_consumed.action.data;
                        let result_failed = result_consumed.action.failed;

                        let load_calldata = build_l2_to_l1_load_calldata(
                            &call_hash, result_data, result_failed,
                        );

                        let next_base_fee = self.get_next_base_fee().await?;
                        let load_tx = self.tx_signer.sign_tx(
                            &self.rollups_address, &load_calldata,
                            U256::ZERO, 10_000_000, next_base_fee,
                        )?;
                        self.l2_client.send_raw_transaction(&load_tx).await?;
                        info!("L2→L1: pre-loaded execution entry (callHash=0x{}...)", &hex::encode(&call_hash.0)[..12]);
                    }

                    // Block N: mine system preload separately (ethrex orders by
                    // gas price, so co-mining would let user tx run first)
                    let (preload_hash, _) = self.engine.mine_block(&self.l2_client, None, Some(performed.l1_block_timestamp)).await?;
                    info!("L2→L1: preload mined in block {preload_hash}");

                    // Block N+1: mine user's tx
                    self.l2_client.send_raw_transaction(&rlp_hex).await?;
                    let user_timestamp = performed.l1_block_timestamp + 1;
                    let (block_hash, _) = self.engine.mine_block(&self.l2_client, None, Some(user_timestamp)).await?;
                    info!("L2→L1 user tx mined in block {block_hash}");
                    return Ok(());
                }

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
    /// For L2→L1 batches, splits into 2 blocks matching builder structure:
    ///   Block 1 (timestamp=T): proxy deploys + other txs
    ///   Block 2 (timestamp=T+1): system preload txs + L2→L1 user txs
    async fn replay_batch_execution(
        &mut self,
        batch: &[(crate::types::L2ExecutionPerformed, Option<crate::types::ExecutionConsumed>, Option<ExecutionConsumed>)],
    ) -> Result<()> {
        let batch_timestamp = batch[0].0.l1_block_timestamp;

        // Pass 1: Decode all L2TXs and detect proxy deploys
        struct DecodedTx {
            rlp_hex: String,
            rlp_bytes: Vec<u8>,
            is_proxy_deploy: bool,
            has_l2_to_l1: bool,
            l2_to_l1_result: Option<ExecutionConsumed>,
            /// For proxy deploys: (originalAddress, originalRollupId) decoded from calldata
            proxy_deploy_info: Option<(Address, U256)>,
        }

        let create_proxy_selector = fn_selectors::create_cross_chain_proxy();
        let mut decoded_txs: Vec<DecodedTx> = Vec::new();
        let rollups_addr_lower = format!("{:?}", self.rollups_address).to_lowercase();

        for (performed, _consumed, l2_to_l1_result) in batch {
            let l1_tx = self.l1_watcher.get_transaction(performed.l1_tx_hash).await?;
            let tx_input = l1_tx["input"].as_str().unwrap_or("0x");
            let tx_input_bytes = hex::decode(tx_input.strip_prefix("0x").unwrap_or(tx_input))?;

            if tx_input_bytes.len() < 4 {
                continue;
            }
            let selector: [u8; 4] = tx_input_bytes[0..4].try_into()?;
            if selector != fn_selectors::execute_l2tx() {
                warn!("Non-executeL2TX call in batch, skipping");
                continue;
            }

            let rlp_encoded_tx = decode_bytes_param(&tx_input_bytes, 1)?;
            let rlp_hex = format!("0x{}", hex::encode(&rlp_encoded_tx));
            let parsed = rlp_decode_tx_minimal(&rlp_encoded_tx)?;

            let is_proxy_deploy = if let Some(to) = &parsed.to {
                let to_hex = format!("0x{}", hex::encode(to)).to_lowercase();
                to_hex == rollups_addr_lower && parsed.data.len() >= 4 && parsed.data[0..4] == create_proxy_selector
            } else {
                false
            };

            let proxy_deploy_info = if is_proxy_deploy && parsed.data.len() >= 68 {
                // createCrossChainProxy(address originalAddress, uint256 originalRollupId)
                let orig_addr = Address::from_slice(&parsed.data[16..36]);
                let orig_rollup = U256::from_be_bytes::<32>(parsed.data[36..68].try_into()?);
                Some((orig_addr, orig_rollup))
            } else {
                None
            };

            decoded_txs.push(DecodedTx {
                rlp_hex,
                rlp_bytes: rlp_encoded_tx,
                is_proxy_deploy,
                has_l2_to_l1: l2_to_l1_result.is_some(),
                l2_to_l1_result: l2_to_l1_result.clone(),
                proxy_deploy_info,
            });
        }

        if decoded_txs.is_empty() {
            eyre::bail!("No executeL2TX transactions decoded from batch events");
        }

        let has_l2_to_l1 = decoded_txs.iter().any(|t| t.has_l2_to_l1);

        if has_l2_to_l1 {
            // Compute proxy addresses for any proxy deploys in this batch
            let mut proxy_map: std::collections::HashMap<Vec<u8>, (Address, U256)> = std::collections::HashMap::new();
            for tx in &decoded_txs {
                if let Some((orig_addr, orig_rollup)) = &tx.proxy_deploy_info {
                    let proxy_addr = self.l2_client.compute_cross_chain_proxy_address(
                        &format!("{:?}", self.rollups_address),
                        orig_addr,
                        *orig_rollup,
                        U256::from(self.l2_chain_id),
                    ).await?;
                    proxy_map.insert(proxy_addr.as_slice().to_vec(), (*orig_addr, *orig_rollup));
                    info!("Proxy deploy in batch: {:?} → {:?} (rollupId={})", proxy_addr, orig_addr, orig_rollup);
                }
            }

            // Block 1: proxy deploys + other non-L2→L1 txs
            let mut block1_count = 0u64;
            for tx in &decoded_txs {
                if tx.is_proxy_deploy || !tx.has_l2_to_l1 {
                    match self.l2_client.send_raw_transaction(&tx.rlp_hex).await {
                        Ok(_) => block1_count += 1,
                        Err(e) => warn!("Failed to send batch tx: {e}"),
                    }
                }
            }
            if block1_count > 0 {
                let (block_hash, _) = self.engine.mine_block(&self.l2_client, None, Some(batch_timestamp)).await?;
                info!("L2→L1 batch block 1: {} txs (proxy deploys + other) in {block_hash}", block1_count);
            }

            // Block 2: system preloads + L2→L1 user txs
            let next_base_fee = self.get_next_base_fee().await?;
            for tx in &decoded_txs {
                if !tx.has_l2_to_l1 {
                    continue;
                }
                let result_consumed = tx.l2_to_l1_result.as_ref().unwrap();
                let parsed = rlp_decode_tx_minimal(&tx.rlp_bytes)?;
                let to_bytes = match &parsed.to {
                    Some(b) => b.clone(),
                    None => continue,
                };

                // Look up proxy info from batch map or L2 state
                let (orig_addr, orig_rollup) = if let Some(info) = proxy_map.get(&to_bytes) {
                    *info
                } else {
                    let proxy_hex = format!("0x{}", hex::encode(&to_bytes));
                    let info = self.l2_client.call_authorized_proxies(
                        &format!("{:?}", self.rollups_address),
                        &proxy_hex,
                    ).await?;
                    (info.original_address, info.original_rollup_id)
                };

                // Build CALL action hash
                let call_action_encoded = abi_encode_action(
                    0, orig_rollup, orig_addr, parsed.value,
                    &parsed.data, false, parsed.from,
                    U256::from(self.rollup_id), &[],
                );
                let mut abi_encoded = Vec::new();
                abi_encoded.extend_from_slice(&encode_u256(0x20));
                abi_encoded.extend_from_slice(&call_action_encoded);
                let call_hash = keccak256_bytes(&abi_encoded);

                // Build loadExecutionTable with RESULT nextAction
                let load_calldata = build_l2_to_l1_load_calldata(
                    &call_hash, &result_consumed.action.data, result_consumed.action.failed,
                );
                let load_tx = self.tx_signer.sign_tx(
                    &self.rollups_address, &load_calldata,
                    U256::ZERO, 10_000_000, next_base_fee,
                )?;
                self.l2_client.send_raw_transaction(&load_tx).await?;
                info!("L2→L1 batch: pre-loaded entry (callHash=0x{}...)", &hex::encode(&call_hash.0)[..12]);
            }

            // Block 2: mine system preloads separately
            let block2_timestamp = batch_timestamp + 1;
            let (block_hash, _) = self.engine.mine_block(&self.l2_client, None, Some(block2_timestamp)).await?;
            info!("L2→L1 batch block 2: system preloads in {block_hash} (timestamp={})", block2_timestamp);

            // Block 3: L2→L1 user txs
            let mut l2_to_l1_count = 0u64;
            for tx in &decoded_txs {
                if tx.has_l2_to_l1 {
                    match self.l2_client.send_raw_transaction(&tx.rlp_hex).await {
                        Ok(_) => l2_to_l1_count += 1,
                        Err(e) => warn!("Failed to send L2→L1 tx: {e}"),
                    }
                }
            }
            let block3_timestamp = batch_timestamp + 2;
            let (block_hash, _) = self.engine.mine_block(&self.l2_client, None, Some(block3_timestamp)).await?;
            info!("L2→L1 batch block 3: {} user txs in {block_hash} (timestamp={})", l2_to_l1_count, block3_timestamp);
        } else {
            // Standard batch: all txs in one block
            let mut sent_count = 0u64;
            for tx in &decoded_txs {
                match self.l2_client.send_raw_transaction(&tx.rlp_hex).await {
                    Ok(_) => sent_count += 1,
                    Err(e) => warn!("Failed to send batch tx: {e}"),
                }
            }
            let (block_hash, _) = self.engine.mine_block(&self.l2_client, None, Some(batch_timestamp)).await?;
            info!("Batch of {} L2TXs mined in block {} (timestamp={})", sent_count, block_hash, batch_timestamp);
        }

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

/// keccak256 of a byte slice
fn keccak256_bytes(data: &[u8]) -> B256 {
    use tiny_keccak::{Hasher, Keccak};
    let mut hasher = Keccak::v256();
    hasher.update(data);
    let mut output = [0u8; 32];
    hasher.finalize(&mut output);
    B256::from(output)
}

/// Pad data to a 32-byte boundary
fn pad_to_32(data: &[u8]) -> Vec<u8> {
    let mut result = data.to_vec();
    let rem = result.len() % 32;
    if rem != 0 {
        result.extend_from_slice(&vec![0u8; 32 - rem]);
    }
    result
}

/// Encode a uint256 value as a 32-byte big-endian word
fn encode_u256(val: usize) -> [u8; 32] {
    let mut bytes = [0u8; 32];
    bytes[24..32].copy_from_slice(&(val as u64).to_be_bytes());
    bytes
}

/// ABI-encode `bytes` type: offset(0x20) + length + data padded to 32 bytes
fn abi_encode_bytes(data: &[u8]) -> Vec<u8> {
    let mut result = Vec::new();
    // offset = 0x20
    result.extend_from_slice(&encode_u256(0x20));
    // length
    result.extend_from_slice(&encode_u256(data.len()));
    // data padded
    result.extend_from_slice(&pad_to_32(data));
    result
}

/// ABI-encode an Action struct matching Solidity's abi.encode(Action).
/// The Action tuple is:
///   (uint8, uint256, address, uint256, bytes, bool, address, uint256, uint256[])
/// Static head: 9 words (288 bytes), with offsets for bytes(data) and uint256[](scope).
fn abi_encode_action(
    action_type: u8,
    rollup_id: U256,
    destination: Address,
    value: U256,
    data: &[u8],
    failed: bool,
    source_address: Address,
    source_rollup: U256,
    scope: &[U256],
) -> Vec<u8> {
    let mut result = Vec::new();

    // Word 0: actionType (uint8 → padded to 32 bytes)
    let mut w = [0u8; 32];
    w[31] = action_type;
    result.extend_from_slice(&w);

    // Word 1: rollupId (uint256)
    result.extend_from_slice(&rollup_id.to_be_bytes::<32>());

    // Word 2: destination (address)
    result.extend_from_slice(&[0u8; 12]);
    result.extend_from_slice(destination.as_slice());

    // Word 3: value (uint256)
    result.extend_from_slice(&value.to_be_bytes::<32>());

    // Word 4: offset to data (bytes) — dynamic
    // Head has 9 words = 288 bytes. data starts at offset 288 = 0x120
    result.extend_from_slice(&encode_u256(9 * 32));

    // Word 5: failed (bool)
    let mut w = [0u8; 32];
    w[31] = if failed { 1 } else { 0 };
    result.extend_from_slice(&w);

    // Word 6: sourceAddress (address)
    result.extend_from_slice(&[0u8; 12]);
    result.extend_from_slice(source_address.as_slice());

    // Word 7: sourceRollup (uint256)
    result.extend_from_slice(&source_rollup.to_be_bytes::<32>());

    // Word 8: offset to scope (uint256[]) — dynamic, after data
    let data_padded_len = if data.is_empty() { 0 } else { ((data.len() + 31) / 32) * 32 };
    let scope_offset = 9 * 32 + 32 + data_padded_len; // head + data_length_word + data_padded
    result.extend_from_slice(&encode_u256(scope_offset));

    // Dynamic section 1: data (bytes) — length + padded content
    result.extend_from_slice(&encode_u256(data.len()));
    if !data.is_empty() {
        result.extend_from_slice(&pad_to_32(data));
    }

    // Dynamic section 2: scope (uint256[]) — length + elements
    result.extend_from_slice(&encode_u256(scope.len()));
    for s in scope {
        result.extend_from_slice(&s.to_be_bytes::<32>());
    }

    result
}

/// Build calldata for loadExecutionTable with a single entry containing:
/// - stateDeltas: empty array
/// - actionHash: result_hash
/// - nextAction: terminal RESULT (rollupId=0, data=empty, failed=false)
fn build_load_execution_table_calldata(result_hash: &B256) -> Vec<u8> {
    let selector = fn_selectors::load_execution_table();
    let mut calldata = Vec::from(selector);

    // The function signature is: loadExecutionTable(ExecutionEntry[] entries)
    // ExecutionEntry[] is a dynamic type, so the head has an offset pointer.

    // Word 0: offset to entries array = 0x20
    calldata.extend_from_slice(&encode_u256(0x20));

    // entries array: length = 1
    calldata.extend_from_slice(&encode_u256(1));

    // entries[0] is a tuple (dynamic), so we have an offset pointer
    // offset to entries[0] = 0x20 (from start of array data)
    calldata.extend_from_slice(&encode_u256(0x20));

    // entries[0]: ExecutionEntry = (StateDelta[] stateDeltas, bytes32 actionHash, Action nextAction)
    // This is a tuple with dynamic members (stateDeltas is dynamic array, nextAction has dynamic bytes/uint256[])
    // Head: 3 words (offsets/values)
    //   - stateDeltas offset (dynamic)
    //   - actionHash (static bytes32)
    //   - nextAction offset (dynamic)

    // Word 0: offset to stateDeltas — dynamic, starts after head (3 * 32 = 96 = 0x60)
    calldata.extend_from_slice(&encode_u256(0x60));

    // Word 1: actionHash (bytes32) — static
    calldata.extend_from_slice(result_hash.as_slice());

    // Word 2: offset to nextAction — dynamic, starts after stateDeltas
    // stateDeltas is an empty array: just 1 word (length = 0)
    // nextAction offset = 0x60 + 32 = 0x80
    calldata.extend_from_slice(&encode_u256(0x80));

    // stateDeltas array: length = 0
    calldata.extend_from_slice(&encode_u256(0));

    // nextAction: terminal RESULT action
    // Action tuple: (uint8, uint256, address, uint256, bytes, bool, address, uint256, uint256[])
    // All zeros except actionType = 1 (RESULT)
    let terminal_action = abi_encode_action(
        1, // RESULT
        U256::ZERO,
        Address::ZERO,
        U256::ZERO,
        &[],   // empty data
        false, // not failed
        Address::ZERO,
        U256::ZERO,
        &[], // empty scope
    );
    calldata.extend_from_slice(&terminal_action);

    calldata
}

/// Build calldata for executeIncomingCrossChainCall(address,uint256,bytes,address,uint256,uint256[])
fn build_execute_incoming_calldata(
    destination: &Address,
    value: U256,
    call_data: &[u8],
    source_address: &Address,
    source_rollup: U256,
) -> Vec<u8> {
    let selector = fn_selectors::execute_incoming_cross_chain_call();
    let mut calldata = Vec::from(selector);

    // destination (address)
    calldata.extend_from_slice(&[0u8; 12]);
    calldata.extend_from_slice(destination.as_slice());
    // value (uint256)
    calldata.extend_from_slice(&value.to_be_bytes::<32>());
    // data offset = 6 * 32 = 0xC0
    calldata.extend_from_slice(&encode_u256(0xC0));
    // sourceAddress (address)
    calldata.extend_from_slice(&[0u8; 12]);
    calldata.extend_from_slice(source_address.as_slice());
    // sourceRollup (uint256)
    calldata.extend_from_slice(&source_rollup.to_be_bytes::<32>());
    // scope offset: after data section
    let call_data_padded_len = if call_data.is_empty() { 0 } else { ((call_data.len() + 31) / 32) * 32 };
    let scope_offset = 0xC0 + 32 + call_data_padded_len;
    calldata.extend_from_slice(&encode_u256(scope_offset));
    // data (bytes): length + content padded
    calldata.extend_from_slice(&encode_u256(call_data.len()));
    if !call_data.is_empty() {
        calldata.extend_from_slice(call_data);
        let padding = call_data_padded_len - call_data.len();
        calldata.extend_from_slice(&vec![0u8; padding]);
    }
    // scope (uint256[]): empty
    calldata.extend_from_slice(&encode_u256(0));

    calldata
}

/// Build loadExecutionTable calldata for L2→L1 call.
/// Entry maps: actionHash = call_hash → nextAction = RESULT (with L1 return data).
fn build_l2_to_l1_load_calldata(
    call_hash: &B256,
    result_data: &[u8],
    result_failed: bool,
) -> Vec<u8> {
    let selector = fn_selectors::load_execution_table();
    let mut calldata = Vec::from(selector);

    // offset to entries array = 0x20
    calldata.extend_from_slice(&encode_u256(0x20));
    // entries array: length = 1
    calldata.extend_from_slice(&encode_u256(1));
    // offset to entries[0] = 0x20
    calldata.extend_from_slice(&encode_u256(0x20));

    // ExecutionEntry head: stateDeltas offset, actionHash, nextAction offset
    calldata.extend_from_slice(&encode_u256(0x60)); // stateDeltas offset
    calldata.extend_from_slice(call_hash.as_slice()); // actionHash = CALL hash
    calldata.extend_from_slice(&encode_u256(0x80)); // nextAction offset (after empty stateDeltas)

    // stateDeltas: empty array
    calldata.extend_from_slice(&encode_u256(0));

    // nextAction: RESULT with L1 return data
    let result_action = abi_encode_action(
        1, // RESULT
        U256::ZERO,
        Address::ZERO,
        U256::ZERO,
        result_data,
        result_failed,
        Address::ZERO,
        U256::ZERO,
        &[],
    );
    calldata.extend_from_slice(&result_action);

    calldata
}

/// Minimal parsed transaction data from RLP-encoded tx
struct ParsedTxMinimal {
    to: Option<Vec<u8>>, // 20-byte address, None for contract creation
    from: Address,
    data: Vec<u8>,
    value: U256,
}

/// Decode an RLP-encoded EIP-1559 (type 2) or legacy transaction to extract basic fields.
/// This is a minimal decoder — it only extracts to, data, value, and recovers from.
fn rlp_decode_tx_minimal(rlp_bytes: &[u8]) -> Result<ParsedTxMinimal> {
    if rlp_bytes.is_empty() {
        eyre::bail!("Empty RLP bytes");
    }

    // EIP-1559 (type 2) tx: first byte is 0x02, followed by RLP list
    // Legacy tx: first byte is RLP list prefix (0xc0..0xf7 or 0xf8..0xff)
    let (is_eip1559, payload) = if rlp_bytes[0] == 0x02 {
        (true, &rlp_bytes[1..])
    } else {
        (false, rlp_bytes)
    };

    // Decode the outer RLP list
    let (list_items, _) = decode_rlp_list(payload)?;

    if is_eip1559 {
        // EIP-1559: [chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit, to, value, data, accessList, v, r, s]
        if list_items.len() < 12 {
            eyre::bail!("EIP-1559 tx too few fields: {}", list_items.len());
        }
        let to = if list_items[5].is_empty() { None } else { Some(list_items[5].to_vec()) };
        let value = rlp_bytes_to_u256(&list_items[6]);
        let data = list_items[7].to_vec();
        let chain_id = rlp_bytes_to_u64(&list_items[0]);

        // Recover sender from signature
        let v = rlp_bytes_to_u64(&list_items[9]);
        let r = &list_items[10];
        let s = &list_items[11];
        let from = recover_eip1559_sender(rlp_bytes, chain_id, v, r, s)?;

        Ok(ParsedTxMinimal { to, from, data, value })
    } else {
        // Legacy: [nonce, gasPrice, gasLimit, to, value, data, v, r, s]
        if list_items.len() < 9 {
            eyre::bail!("Legacy tx too few fields: {}", list_items.len());
        }
        let to = if list_items[3].is_empty() { None } else { Some(list_items[3].to_vec()) };
        let value = rlp_bytes_to_u256(&list_items[4]);
        let data = list_items[5].to_vec();
        let v_raw = rlp_bytes_to_u64(&list_items[6]);
        let r = &list_items[7];
        let s = &list_items[8];

        // EIP-155: chainId = (v - 35) / 2
        let chain_id = if v_raw >= 35 { (v_raw - 35) / 2 } else { 0 };
        let v = if v_raw >= 35 { v_raw - chain_id * 2 - 35 } else { v_raw - 27 };

        let from = recover_legacy_sender(rlp_bytes, chain_id, v, r, s)?;

        Ok(ParsedTxMinimal { to, from, data, value })
    }
}

/// Decode an RLP list, returning the items as byte slices
fn decode_rlp_list(data: &[u8]) -> Result<(Vec<&[u8]>, usize)> {
    if data.is_empty() {
        eyre::bail!("Empty RLP data");
    }

    let (payload, total_len) = decode_rlp_length(data)?;
    let mut items = Vec::new();
    let mut pos = 0;

    while pos < payload.len() {
        let (item, item_total) = decode_rlp_item(&payload[pos..])?;
        items.push(item);
        pos += item_total;
    }

    Ok((items, total_len))
}

/// Decode RLP length prefix, returning (payload, total_consumed_bytes)
fn decode_rlp_length(data: &[u8]) -> Result<(&[u8], usize)> {
    let prefix = data[0];
    if prefix <= 0x7f {
        // Single byte
        Ok((&data[0..1], 1))
    } else if prefix <= 0xb7 {
        // Short string: 0-55 bytes
        let len = (prefix - 0x80) as usize;
        Ok((&data[1..1 + len], 1 + len))
    } else if prefix <= 0xbf {
        // Long string
        let len_bytes = (prefix - 0xb7) as usize;
        let mut len = 0usize;
        for i in 0..len_bytes {
            len = (len << 8) | data[1 + i] as usize;
        }
        let start = 1 + len_bytes;
        Ok((&data[start..start + len], start + len))
    } else if prefix <= 0xf7 {
        // Short list: 0-55 bytes payload
        let len = (prefix - 0xc0) as usize;
        Ok((&data[1..1 + len], 1 + len))
    } else {
        // Long list
        let len_bytes = (prefix - 0xf7) as usize;
        let mut len = 0usize;
        for i in 0..len_bytes {
            len = (len << 8) | data[1 + i] as usize;
        }
        let start = 1 + len_bytes;
        Ok((&data[start..start + len], start + len))
    }
}

/// Decode a single RLP item, returning (payload_bytes, total_consumed)
fn decode_rlp_item(data: &[u8]) -> Result<(&[u8], usize)> {
    decode_rlp_length(data)
}

/// Convert RLP-decoded bytes to U256
fn rlp_bytes_to_u256(bytes: &[u8]) -> U256 {
    if bytes.is_empty() {
        return U256::ZERO;
    }
    let mut padded = [0u8; 32];
    let start = 32 - bytes.len().min(32);
    padded[start..start + bytes.len().min(32)].copy_from_slice(&bytes[..bytes.len().min(32)]);
    U256::from_be_bytes(padded)
}

/// Convert RLP-decoded bytes to u64
fn rlp_bytes_to_u64(bytes: &[u8]) -> u64 {
    if bytes.is_empty() {
        return 0;
    }
    let mut val = 0u64;
    for &b in bytes {
        val = (val << 8) | b as u64;
    }
    val
}

/// Recover sender for EIP-1559 transaction
fn recover_eip1559_sender(
    raw_tx: &[u8],
    _chain_id: u64,
    v: u64,
    r: &[u8],
    s: &[u8],
) -> Result<Address> {
    // For EIP-1559, the signing payload is: keccak256(0x02 || rlp([chainId, nonce, ..., accessList]))
    // The raw_tx is: 0x02 || rlp([..., v, r, s])
    // We need to rebuild the RLP list with only the first 9 fields (without v, r, s).
    //
    // IMPORTANT: We must preserve the raw RLP encoding of each field (including
    // list prefixes like 0xc0 for empty access list). Decoding and re-encoding
    // is lossy (lists become strings), so instead we extract raw RLP item spans.

    let rlp_data = &raw_tx[1..]; // skip 0x02 type byte
    // Skip the outer list header to get the payload
    let (payload, _) = decode_rlp_length(rlp_data)?;
    let payload_offset = rlp_data.len() - payload.len(); // bytes consumed by the list header

    // Walk the payload to find the byte boundaries of each raw RLP item
    let mut raw_items: Vec<&[u8]> = Vec::new();
    let mut pos = 0;
    while pos < payload.len() {
        let (_item_payload, item_total) = decode_rlp_item(&payload[pos..])?;
        raw_items.push(&payload[pos..pos + item_total]); // raw RLP bytes including prefix
        pos += item_total;
    }

    if raw_items.len() < 12 {
        eyre::bail!("EIP-1559 tx too few fields for sender recovery: {}", raw_items.len());
    }

    // Concatenate raw RLP bytes of first 9 fields, then wrap in a list
    let mut unsigned_payload = Vec::new();
    for item in &raw_items[..9] {
        unsigned_payload.extend_from_slice(item);
    }
    let mut unsigned_rlp = Vec::new();
    encode_rlp_length(unsigned_payload.len(), 0xc0, &mut unsigned_rlp);
    unsigned_rlp.extend_from_slice(&unsigned_payload);

    // Signing hash = keccak256(0x02 || unsigned_rlp)
    let mut to_hash = vec![0x02u8];
    to_hash.extend_from_slice(&unsigned_rlp);
    let msg_hash = keccak256_bytes(&to_hash);

    recover_from_signature(&msg_hash, v, r, s)
}

/// Recover sender for legacy transaction
fn recover_legacy_sender(
    raw_tx: &[u8],
    chain_id: u64,
    v: u64,
    r: &[u8],
    s: &[u8],
) -> Result<Address> {
    // Extract raw RLP item spans (preserving prefixes)
    let (payload, _) = decode_rlp_length(raw_tx)?;
    let mut raw_items: Vec<&[u8]> = Vec::new();
    let mut pos = 0;
    while pos < payload.len() {
        let (_item_payload, item_total) = decode_rlp_item(&payload[pos..])?;
        raw_items.push(&payload[pos..pos + item_total]);
        pos += item_total;
    }

    if raw_items.len() < 9 {
        eyre::bail!("Legacy tx too few fields for sender recovery: {}", raw_items.len());
    }

    // EIP-155: sign over [nonce, gasPrice, gasLimit, to, value, data, chainId, 0, 0]
    // Non-EIP-155: sign over [nonce, gasPrice, gasLimit, to, value, data]
    let mut unsigned_payload = Vec::new();
    for item in &raw_items[..6] {
        unsigned_payload.extend_from_slice(item);
    }
    if chain_id > 0 {
        let chain_bytes = u64_to_be_bytes_trimmed(chain_id);
        rlp_encode_item(&chain_bytes, &mut unsigned_payload);
        rlp_encode_item(&[], &mut unsigned_payload); // 0
        rlp_encode_item(&[], &mut unsigned_payload); // 0
    }

    let mut unsigned_rlp = Vec::new();
    encode_rlp_length(unsigned_payload.len(), 0xc0, &mut unsigned_rlp);
    unsigned_rlp.extend_from_slice(&unsigned_payload);

    let msg_hash = keccak256_bytes(&unsigned_rlp);
    recover_from_signature(&msg_hash, v, r, s)
}


/// RLP-encode a single item
fn rlp_encode_item(data: &[u8], out: &mut Vec<u8>) {
    if data.len() == 1 && data[0] <= 0x7f {
        out.push(data[0]);
    } else if data.is_empty() {
        out.push(0x80);
    } else {
        encode_rlp_length(data.len(), 0x80, out);
        out.extend_from_slice(data);
    }
}

/// Encode RLP length prefix
fn encode_rlp_length(len: usize, offset: u8, out: &mut Vec<u8>) {
    if len <= 55 {
        out.push(offset + len as u8);
    } else {
        let len_bytes = u64_to_be_bytes_trimmed(len as u64);
        out.push(offset + 55 + len_bytes.len() as u8);
        out.extend_from_slice(&len_bytes);
    }
}

/// Convert u64 to big-endian bytes, trimming leading zeros
fn u64_to_be_bytes_trimmed(val: u64) -> Vec<u8> {
    if val == 0 {
        return vec![];
    }
    let bytes = val.to_be_bytes();
    let start = bytes.iter().position(|&b| b != 0).unwrap_or(7);
    bytes[start..].to_vec()
}

/// Recover address from ECDSA signature
fn recover_from_signature(msg_hash: &B256, v: u64, r: &[u8], s: &[u8]) -> Result<Address> {
    use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};

    let mut r_padded = [0u8; 32];
    let r_start = 32 - r.len().min(32);
    r_padded[r_start..].copy_from_slice(&r[..r.len().min(32)]);

    let mut s_padded = [0u8; 32];
    let s_start = 32 - s.len().min(32);
    s_padded[s_start..].copy_from_slice(&s[..s.len().min(32)]);

    let signature = Signature::from_scalars(r_padded, s_padded)
        .map_err(|e| eyre::eyre!("Invalid signature: {e}"))?;

    let recovery_id = RecoveryId::new(v & 1 != 0, false);

    let verifying_key = VerifyingKey::recover_from_prehash(msg_hash.as_slice(), &signature, recovery_id)
        .map_err(|e| eyre::eyre!("Recovery failed: {e}"))?;

    // Public key → keccak256 → last 20 bytes = address
    let pubkey_bytes = verifying_key.to_encoded_point(false);
    let pubkey_uncompressed = &pubkey_bytes.as_bytes()[1..]; // skip 0x04 prefix
    let addr_hash = keccak256_bytes(pubkey_uncompressed);
    Ok(Address::from_slice(&addr_hash.as_slice()[12..]))
}
