/**
 * Execution Planner for sync-rollups builder
 * Computes all execution paths for a transaction
 */

import { JsonRpcProvider, keccak256, AbiCoder } from "ethers";
import {
  Action,
  ExecutionEntry,
  ExecutionPlan,
  StateDelta,
  SimulationResult,
  ACTION_TUPLE_TYPE,
  createL2TXAction,
  createCallAction,
  createResultAction,
  actionToJson,
  actionFromJson,
  stateDeltaFromJson,
  executionEntryToJson,
} from "../fullnode/types.js";

export interface ExecutionPlannerConfig {
  rollupId: bigint;
  fullnodeRpcUrl: string;
  l1RpcUrl: string;
}

export class ExecutionPlanner {
  private config: ExecutionPlannerConfig;
  private fullnodeProvider: JsonRpcProvider;
  private l1Provider: JsonRpcProvider;
  private abiCoder: AbiCoder;

  constructor(config: ExecutionPlannerConfig) {
    this.config = config;
    this.fullnodeProvider = new JsonRpcProvider(config.fullnodeRpcUrl);
    this.l1Provider = new JsonRpcProvider(config.l1RpcUrl);
    this.abiCoder = AbiCoder.defaultAbiCoder();
  }

  /**
   * Compute action hash matching Rollups.sol
   */
  computeActionHash(action: Action): string {
    const encoded = this.abiCoder.encode([ACTION_TUPLE_TYPE], [
      [
        action.actionType,
        action.rollupId,
        action.destination,
        action.value,
        action.data,
        action.failed,
        action.sourceAddress,
        action.sourceRollup,
        action.scope,
      ],
    ]);
    return keccak256(encoded);
  }

  /**
   * Plan an L2 transaction
   * Returns all executions needed to process the transaction
   */
  async planL2Transaction(rlpEncodedTx: string, timestamp?: number): Promise<ExecutionPlan> {
    const entries: ExecutionEntry[] = [];

    // Get current state from L1 directly (this is what the contract will check)
    const states = await this.getStates();
    const currentState = states.l1State.stateRoot;
    console.log(`[Planner] Current L1 state: ${currentState.slice(0, 18)}...`);

    // Build L2TX action
    const l2txAction = createL2TXAction(this.config.rollupId, rlpEncodedTx);
    const rootActionHash = this.computeActionHash(l2txAction);
    console.log(`[Planner] Action hash: ${rootActionHash.slice(0, 18)}...`);

    // Simulate the transaction (with optional timestamp for deterministic state roots)
    const simulation = await this.simulateAction(l2txAction, timestamp);
    console.log(`[Planner] Simulation success: ${simulation.success}, stateDeltas: ${simulation.stateDeltas.length}`);

    if (!simulation.success) {
      throw new Error(`L2TX simulation failed: ${simulation.error || "unknown error"}`);
    }

    // Build RESULT action
    const resultAction = createResultAction(
      this.config.rollupId,
      simulation.nextAction.data,
      simulation.nextAction.failed
    );

    const newState = simulation.stateDeltas[0].newState;

    console.log(`[Planner] New state: ${newState.slice(0, 18)}...`);

    // Create execution for L2TX -> RESULT
    const execution: ExecutionEntry = {
      stateDeltas: [
        {
          rollupId: this.config.rollupId,
          currentState,
          newState,
          etherDelta: 0n,
        },
      ],
      actionHash: rootActionHash,
      nextAction: resultAction,
    };

    entries.push(execution);

    return {
      entries,
      rootActionHash,
      rootActions: [l2txAction],
      proof: "", // Will be filled by proofer
    };
  }

  /**
   * Plan a batch of L2 transactions to be included in a single L2 block.
   * Simulates all txs together in one block on the builder's fullnode.
   */
  async planL2Batch(signedTxs: string[], timestamp?: number): Promise<ExecutionPlan> {
    const entries: ExecutionEntry[] = [];

    // Get current state from L1
    const states = await this.getStates();
    const currentState = states.l1State.stateRoot;
    console.log(`[Planner] Batch of ${signedTxs.length} txs, initial state: ${currentState.slice(0, 18)}...`);

    // Simulate all txs in a single block on the builder's fullnode
    const simResult = await this.fullnodeProvider.send("syncrollups_simulateBatch", [signedTxs, timestamp]);
    if (!simResult.success) {
      throw new Error(`L2TX batch simulation failed: ${simResult.error || "unknown"}`);
    }

    const newState = simResult.newState;
    console.log(`[Planner] Batch simulated, new state: ${newState.slice(0, 18)}...`);

    // Create one entry per tx (each with the same overall state transition)
    // The L1 contract processes entries individually, so we need N entries.
    // The first entry carries the state transition, the rest are no-ops.
    for (let i = 0; i < signedTxs.length; i++) {
      const l2txAction = createL2TXAction(this.config.rollupId, signedTxs[i]);
      const actionHash = this.computeActionHash(l2txAction);

      // Build RESULT action (we don't have individual return data, use empty)
      const resultAction = createResultAction(this.config.rollupId, "0x", false);

      if (i === 0) {
        // First entry: carries the full state transition
        entries.push({
          stateDeltas: [{
            rollupId: this.config.rollupId,
            currentState,
            newState,
            etherDelta: 0n,
          }],
          actionHash,
          nextAction: resultAction,
        });
      } else {
        // Subsequent entries: identity state transition (newState→newState)
        entries.push({
          stateDeltas: [{
            rollupId: this.config.rollupId,
            currentState: newState,
            newState: newState,
            etherDelta: 0n,
          }],
          actionHash,
          nextAction: resultAction,
        });
      }
    }

    console.log(`[Planner] Batch complete, final state: ${newState.slice(0, 18)}...`);

    // Root actions: one L2TX action per signed tx
    const rootActions = signedTxs.map((tx) =>
      createL2TXAction(this.config.rollupId, tx)
    );

    return {
      entries,
      rootActionHash: entries.length > 0 ? entries[0].actionHash : "0x" + "00".repeat(32),
      rootActions,
      proof: "",
    };
  }

  /**
   * Plan an L2→L1 contract call.
   * The signed L2 tx is the root action; its continuation is a CALL action on L1.
   */
  async planL2ToL1Call(
    rlpEncodedTx: string,
    l1Target: string,
    l2CallData: string,
    l2CallValue: bigint,
    l2Sender: string,
    sourceProxyOnL1: string,
    timestamp?: number
  ): Promise<ExecutionPlan> {
    const entries: ExecutionEntry[] = [];

    // Root action: L2TX
    const states = await this.getStates();
    const currentState = states.l1State.stateRoot;
    const l2txAction = createL2TXAction(this.config.rollupId, rlpEncodedTx);
    const rootActionHash = this.computeActionHash(l2txAction);

    // Simulate root L2TX on fullnode to obtain the post-tx L2 state root.
    const l2txSimulation = await this.simulateAction(l2txAction, timestamp);
    if (!l2txSimulation.success) {
      throw new Error(
        `L2 transaction simulation failed for L2→L1 planning: ${l2txSimulation.error || "unknown error"}`
      );
    }

    const postL2State =
      l2txSimulation.stateDeltas.length > 0
        ? l2txSimulation.stateDeltas[0].newState
        : this.computeNewState(currentState, rootActionHash);

    // Continuation action: CALL on L1 from the L2 sender's deterministic L1 proxy.
    const callAction = createCallAction(
      this.config.rollupId,
      l1Target,
      l2CallValue,
      l2CallData,
      l2Sender,
      this.config.rollupId,
      []
    );

    // Simulate the L1 call return data.
    // For value-only transfers (empty calldata) to EOAs, the call always succeeds
    // on L1 because the Rollups contract provides the ETH via executeOnBehalf.
    // We can't reliably simulate this via eth_call (the source proxy may not have
    // ETH in simulation), so we short-circuit for plain value transfers.
    let l1CallResult: { returnData: string; failed: boolean };
    const isPlainTransfer = !l2CallData || l2CallData === "0x" || l2CallData === "0x00";
    const targetCode = await this.l1Provider.getCode(l1Target);
    if (isPlainTransfer && targetCode === "0x") {
      // EOA value transfer — always succeeds. The return data from
      // _processCallAtScope is ABI-encoded: executeOnBehalf returns
      // bytes memory, which ABI-encodes the inner call's empty return.
      // abi.encode(bytes("")) = offset(0x20) + length(0x00)
      const abiEncodedEmptyBytes =
        "0x" +
        "0000000000000000000000000000000000000000000000000000000000000020" +
        "0000000000000000000000000000000000000000000000000000000000000000";
      l1CallResult = { returnData: abiEncodedEmptyBytes, failed: false };
    } else {
      l1CallResult = await this.simulateL1Call(
        sourceProxyOnL1,
        l1Target,
        l2CallData,
        l2CallValue
      );
    }

    // Execution #1: L2TX -> CALL(L1)
    const rootExecutionEntry: ExecutionEntry = {
      stateDeltas:
        l2txSimulation.stateDeltas.length > 0
          ? l2txSimulation.stateDeltas
          : [
              {
                rollupId: this.config.rollupId,
                currentState,
                newState: postL2State,
                etherDelta: 0n,
              },
            ],
      actionHash: rootActionHash,
      nextAction: callAction,
    };
    entries.push(rootExecutionEntry);

    // Result action hash is what Rollups._processCallAtScope computes after CALL.
    const callResultAction = createResultAction(
      this.config.rollupId,
      l1CallResult.returnData,
      l1CallResult.failed
    );
    const callResultHash = this.computeActionHash(callResultAction);

    // Execution #2: RESULT(call) -> final RESULT.
    // When the CALL sends ETH on L1 (L2→L1 withdrawal), _etherDelta becomes
    // negative. The continuation's stateDeltas must carry a matching negative
    // etherDelta so the Rollups contract's ether accounting check passes.
    // The rollup's L1 etherBalance decreases by the withdrawn amount.
    const continuationStateDeltas: StateDelta[] = l2CallValue > 0n
      ? [{
          rollupId: this.config.rollupId,
          currentState: postL2State,
          newState: postL2State,  // No further L2 state change, just L1 ether accounting
          etherDelta: -l2CallValue,
        }]
      : [];
    const continuationExecutionEntry: ExecutionEntry = {
      stateDeltas: continuationStateDeltas,
      actionHash: callResultHash,
      nextAction: createResultAction(
        this.config.rollupId,
        l1CallResult.returnData,
        l1CallResult.failed
      ),
    };
    entries.push(continuationExecutionEntry);

    return {
      entries,
      rootActionHash,
      rootActions: [l2txAction, callResultAction],
      proof: "",
    };
  }

  /**
   * Compute a deterministic new state based on current state and action
   * This is a placeholder - real implementation would execute on L2 EVM
   */
  private computeNewState(currentState: string, actionHash: string): string {
    return keccak256(this.abiCoder.encode(["bytes32", "bytes32"], [currentState, actionHash]));
  }

  /**
   * Plan an L1-to-L2 call (old method - kept for compatibility)
   * This is called when an L1 contract calls an L2Proxy
   */
  async planL1ToL2Call(
    l2Target: string,
    callData: string,
    value: bigint,
    sourceAddress: string
  ): Promise<ExecutionPlan> {
    const entries: ExecutionEntry[] = [];

    // Get current state from fullnode
    const currentState = await this.getFullnodeState();

    // Build CALL action
    const callAction = createCallAction(
      this.config.rollupId,
      l2Target,
      value,
      callData,
      sourceAddress,
      this.config.rollupId, // Source rollup is same in single-rollup mode
      [] // Empty scope for root call
    );
    const rootActionHash = this.computeActionHash(callAction);

    // Simulate the call
    const simulation = await this.simulateAction(callAction);

    // Check for outgoing L1 calls (in single-rollup mode, we reject these)
    // In a full implementation, we would detect calls to L1SenderProxyL2 contracts

    // Build RESULT action
    const resultAction = createResultAction(
      this.config.rollupId,
      simulation.nextAction.data,
      simulation.nextAction.failed
    );

    // Create execution for CALL -> RESULT
    const execution: ExecutionEntry = {
      stateDeltas:
        simulation.stateDeltas.length > 0
          ? simulation.stateDeltas
          : [
              {
                rollupId: this.config.rollupId,
                currentState,
                newState: currentState, // No state change if call doesn't modify state
                etherDelta: 0n,
              },
            ],
      actionHash: rootActionHash,
      nextAction: resultAction,
    };

    entries.push(execution);

    return {
      entries,
      rootActionHash,
      rootActions: [callAction],
      proof: "", // Will be filled by proofer
    };
  }

  /**
   * Plan an L1-to-L2 call with proper proxy context
   * This is used by the /prepare-l1-call endpoint
   *
   * IMPORTANT: The action hash must match exactly what L2Proxy.fallback() produces:
   * - rollupId: _getOriginalRollupId() (the target rollup)
   * - destination: _getOriginalAddress() (the L2 target)
   * - sourceAddress: address(this) (the target proxy address on L1)
   * - sourceRollup: rollupId (same as target rollup, NOT L1 chain ID)
   *
   * For local L2 execution we intentionally use the caller-derived source proxy
   * as tx.from, so contracts observe msg.sender as the L2 representation of the
   * original L1 caller (not the target proxy).
   */
  async planL1ToL2CallWithProxy(
    l2Target: string,
    callData: string,
    value: bigint,
    targetProxyAddress: string, // L1 proxy representing the L2 target
    sourceProxyAddress: string, // L2 proxy representing the original L1 caller
    originalSender: string,     // Original L1 sender address (for L2 proxy deployment)
    timestamp?: number          // L1 block timestamp for deterministic state roots
  ): Promise<ExecutionPlan> {
    const entries: ExecutionEntry[] = [];

    // Get current state from L1 (this is what the contract will check)
    const states = await this.getStates();
    const currentState = states.l1State.stateRoot;
    console.log(`[Planner] Current L1 state: ${currentState.slice(0, 18)}...`);

    // Build CALL action matching Rollups.executeCrossChainCall:
    // - sourceAddress = msg.sender passed by proxy = the original L1 caller
    // - sourceRollup = MAINNET_ROLLUP_ID = 0
    const callAction = createCallAction(
      this.config.rollupId,  // rollupId = proxyInfo.originalRollupId
      l2Target,              // destination = proxyInfo.originalAddress
      value,                 // msg.value
      callData,              // callData from proxy fallback
      originalSender,        // sourceAddress = msg.sender (user who called proxy)
      0n,                    // sourceRollup = MAINNET_ROLLUP_ID = 0
      []                     // scope = empty
    );
    const rootActionHash = this.computeActionHash(callAction);
    console.log(`[Planner] Action hash: ${rootActionHash.slice(0, 18)}...`);

    // Simulate (actually pre-execute) the L1→L2 call on the builder's L2
    const simulation = await this.simulateL1ToL2Call(
      l2Target,
      callData,
      value,
      sourceProxyAddress,
      originalSender,
      timestamp
    );
    console.log(`[Planner] Simulation success: ${simulation.success}, returnData: ${simulation.returnData.slice(0, 18)}...`);

    // Build RESULT action
    const resultAction = createResultAction(
      this.config.rollupId,
      simulation.returnData,
      simulation.failed
    );

    // etherDelta must match the actual ETH flow tracked by the Rollups contract.
    // When the user sends ETH to the proxy, _etherDelta += msg.value.
    // The execution entry's stateDeltas.etherDelta must sum to the same value.
    const etherDelta = value;

    const stateDeltas: StateDelta[] = simulation.stateDeltas.length > 0
      ? simulation.stateDeltas.map(sd => ({ ...sd, etherDelta }))
      : [
          {
            rollupId: this.config.rollupId,
            currentState,
            newState: simulation.newState || this.computeNewState(currentState, rootActionHash),
            etherDelta,
          },
        ];

    // Create execution for CALL -> RESULT
    const execution: ExecutionEntry = {
      stateDeltas,
      actionHash: rootActionHash,
      nextAction: resultAction,
    };

    entries.push(execution);
    console.log(`[Planner] Created execution with etherDelta: ${etherDelta}`);

    return {
      entries,
      rootActionHash,
      rootActions: [callAction],
      proof: "", // Will be filled by proofer
    };
  }

  /**
   * Simulate an L1→L2 call on the fullnode
   */
  private async simulateL1ToL2Call(
    destination: string,
    data: string,
    value: bigint,
    fromProxy: string,
    originalSender: string,
    timestamp?: number
  ): Promise<{
    returnData: string;
    failed: boolean;
    stateDeltas: StateDelta[];
    newState?: string;
    success: boolean;
  }> {
    try {
      const result = await this.fullnodeProvider.send("syncrollups_simulateL1Call", [{
        from: fromProxy,
        to: destination,
        value: "0x" + value.toString(16),
        data: data,
        originalSender: originalSender,
      }, timestamp]);

      return {
        returnData: result.returnData || "0x",
        failed: result.failed || false,
        stateDeltas: result.stateDeltas ? result.stateDeltas.map(stateDeltaFromJson) : [],
        newState: result.newState,
        success: !result.failed,
      };
    } catch (error: any) {
      console.error("[Planner] L1→L2 simulation error:", error.message);
      // Return a failed result with empty data
      return {
        returnData: "0x",
        failed: true,
        stateDeltas: [],
        success: false,
      };
    }
  }

  /**
   * Simulate an L1 contract call as if sent from a deterministic source proxy.
   */
  private async simulateL1Call(
    from: string,
    to: string,
    data: string,
    value: bigint
  ): Promise<{
    returnData: string;
    failed: boolean;
  }> {
    try {
      const returnData = await this.l1Provider.call({
        from,
        to,
        data,
        value,
      });
      return { returnData, failed: false };
    } catch (error: any) {
      const returnData =
        typeof error?.data === "string"
          ? error.data
          : typeof error?.error?.data === "string"
          ? error.error.data
          : "0x";
      return { returnData, failed: true };
    }
  }

  /**
   * Get current state root from fullnode
   */
  private async getFullnodeState(): Promise<string> {
    return await this.fullnodeProvider.send("syncrollups_getStateRoot", []);
  }

  /**
   * Simulate an action on the fullnode
   */
  private async simulateAction(action: Action, timestamp?: number): Promise<SimulationResult> {
    // Convert to JSON-safe format for RPC
    const actionJson = actionToJson(action);
    const resultJson = await this.fullnodeProvider.send("syncrollups_simulateAction", [
      actionJson,
      timestamp,
    ]);

    // Convert response back to native types
    return {
      nextAction: actionFromJson(resultJson.nextAction),
      stateDeltas: resultJson.stateDeltas.map(stateDeltaFromJson),
      success: resultJson.success,
      error: resultJson.error,
    };
  }

  /**
   * Take a snapshot of fullnode state
   */
  async takeSnapshot(): Promise<string> {
    return await this.fullnodeProvider.send("syncrollups_takeSnapshot", []);
  }

  /**
   * Revert to a snapshot
   */
  async revertToSnapshot(snapshotId: string): Promise<void> {
    await this.fullnodeProvider.send("syncrollups_revertToSnapshot", [
      snapshotId,
    ]);
  }

  /**
   * Notify fullnode of executions to cache
   */
  async notifyExecutions(entries: ExecutionEntry[]): Promise<void> {
    // Convert to JSON-safe format
    const entriesJson = entries.map(executionEntryToJson);
    await this.fullnodeProvider.send("syncrollups_loadExecutions", [
      entriesJson,
    ]);
  }

  /**
   * Check if fullnode is synced (comprehensive — includes EVM state check).
   * Use isTrackedStateSynced() for builder operations that only need to know
   * whether the fullnode has processed all L1 events.
   */
  async isFullnodeSynced(): Promise<boolean> {
    return await this.fullnodeProvider.send("syncrollups_isSynced", []);
  }

  /**
   * Check if the fullnode's tracked state matches L1 (does NOT check actual EVM state).
   *
   * The builder's L2 EVM may be temporarily ahead of L1 during L1→L2 call
   * preparation (simulateL1ToL2Call pre-executes on the builder's L2 to obtain
   * the correct post-execution state root). This divergence is self-healing:
   * once the user's L1 tx is mined and the fullnode replays the event, the
   * event processor detects "L2 state already matches" and converges.
   *
   * For builder operations, we only need to know that the fullnode has processed
   * all L1 events — not that the EVM state matches. Using the comprehensive
   * isSynced() would block builder operations during the preparation window.
   */
  async isTrackedStateSynced(): Promise<boolean> {
    const [trackedState, l1State] = await Promise.all([
      this.fullnodeProvider.send("syncrollups_getStateRoot", []),
      this.fullnodeProvider.send("syncrollups_getL1State", []),
    ]);
    return trackedState === l1State.stateRoot;
  }

  /**
   * Get chain ID of the builder fullnode L2 RPC.
   */
  async getL2ChainId(): Promise<bigint> {
    const chainIdHex = await this.fullnodeProvider.send("eth_chainId", []);
    return BigInt(chainIdHex);
  }

  /**
   * Get fullnode and L1 states for comparison
   */
  async getStates(): Promise<{
    fullnodeState: string;
    l1State: { stateRoot: string; etherBalance: string };
  }> {
    const fullnodeState = await this.fullnodeProvider.send("syncrollups_getActualStateRoot", []);
    const l1State = await this.fullnodeProvider.send("syncrollups_getL1State", []);
    return { fullnodeState, l1State };
  }
}
