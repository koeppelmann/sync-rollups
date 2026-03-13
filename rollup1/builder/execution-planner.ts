/**
 * Execution Planner for sync-rollups builder
 * Computes all execution paths for a transaction
 */

import { JsonRpcProvider, keccak256, AbiCoder, Interface } from "ethers";
import {
  Action,
  ActionType,
  ExecutionEntry,
  ExecutionPlan,
  StateDelta,
  SimulationResult,
  ACTION_TUPLE_TYPE,
  EXECUTION_ENTRY_TUPLE_TYPE,
  createL2TXAction,
  createCallAction,
  createResultAction,
  actionToJson,
  actionFromJson,
  stateDeltaFromJson,
  executionEntryToJson,
} from "../reth-fullnode/types.js";

export interface ExecutionPlannerConfig {
  rollupId: bigint;
  fullnodeRpcUrl: string;
  l1RpcUrl: string;
  rollupsAddress: string; // CrossChainManagerL2 address on L2 (same as L1 Rollups address)
}

export class ExecutionPlanner {
  private config: ExecutionPlannerConfig;
  private fullnodeProvider: JsonRpcProvider;
  private l1Provider: JsonRpcProvider;
  private abiCoder: AbiCoder;

  constructor(config: ExecutionPlannerConfig) {
    this.config = config;
    this.fullnodeProvider = new JsonRpcProvider(config.fullnodeRpcUrl);
    this.l1Provider = new JsonRpcProvider(config.l1RpcUrl, undefined, { batchMaxCount: 1 });
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
  async planL2Transaction(rlpEncodedTx: string, timestamp?: number, overrideCurrentState?: string): Promise<ExecutionPlan> {
    const entries: ExecutionEntry[] = [];

    // Get current state from L1 directly (this is what the contract will check)
    // If overrideCurrentState is provided (state correction pending), use that instead
    const states = await this.getStates();
    const currentState = overrideCurrentState || states.l1State.stateRoot;
    console.log(`[Planner] Current L1 state: ${currentState.slice(0, 18)}...${overrideCurrentState ? " (corrected)" : ""}`);

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
   * If proxyDeploySignedTx is provided, a proxy deployment entry is added first.
   * The user's L2TX is the next entry; its continuation is a CALL action on L1.
   */
  async planL2ToL1Call(
    rlpEncodedTx: string,
    l1Target: string,
    l2CallData: string,
    l2CallValue: bigint,
    l2Sender: string,
    sourceProxyOnL1: string,
    timestamp?: number,
    overrideCurrentState?: string,
    proxyDeploySignedTx?: string
  ): Promise<ExecutionPlan> {
    const entries: ExecutionEntry[] = [];
    const rootActions: Action[] = [];

    const states = await this.getStates();
    let currentState = overrideCurrentState || states.l1State.stateRoot;

    // ── Entry 0 (optional): proxy deployment L2TX ──────────────────────
    if (proxyDeploySignedTx) {
      const deployAction = createL2TXAction(this.config.rollupId, proxyDeploySignedTx);
      const deployActionHash = this.computeActionHash(deployAction);

      // Simulate the proxy deployment tx (mines one L2 block)
      const deploySim = await this.simulateAction(deployAction, timestamp);
      if (!deploySim.success) {
        throw new Error(
          `Proxy deploy simulation failed: ${deploySim.error || "unknown error"}`
        );
      }

      const postDeployState = deploySim.stateDeltas[0].newState;
      const deployResultAction = createResultAction(this.config.rollupId, "0x", false);

      entries.push({
        stateDeltas: [{
          rollupId: this.config.rollupId,
          currentState,
          newState: postDeployState,
          etherDelta: 0n,
        }],
        actionHash: deployActionHash,
        nextAction: deployResultAction,
      });
      rootActions.push(deployAction);

      // Advance currentState for the next entry
      currentState = postDeployState;
      console.log(`[Planner] Proxy deploy: ${currentState.slice(0, 18)}... → ${postDeployState.slice(0, 18)}...`);
    }

    // ── Entry 1: user's L2TX → CALL(L1) ────────────────────────────────
    const l2txAction = createL2TXAction(this.config.rollupId, rlpEncodedTx);
    const l2txActionHash = this.computeActionHash(l2txAction);

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

    // Simulate the L1 call return data BEFORE simulating the L2TX.
    // We need it to pre-load the execution entry so the L2 proxy call succeeds.
    let l1CallResult: { returnData: string; failed: boolean };
    const isPlainTransfer = !l2CallData || l2CallData === "0x" || l2CallData === "0x00";
    const targetCode = await this.l1Provider.getCode(l1Target);
    if (isPlainTransfer && targetCode === "0x") {
      l1CallResult = { returnData: "0x", failed: false };
    } else {
      l1CallResult = await this.simulateL1Call(
        sourceProxyOnL1,
        l1Target,
        l2CallData,
        l2CallValue
      );
    }

    // Pre-load execution entry into CrossChainManagerL2 so the proxy call
    // can consume it during simulation. The proxy's executeCrossChainCall builds
    // a CALL action and looks it up in the execution table. We pre-compute the
    // same CALL action hash and load an entry with RESULT as the nextAction.
    //
    // The CALL action built by the proxy uses:
    //   rollupId = proxy.originalRollupId (= 0, meaning "L1 target")
    //   destination = proxy.originalAddress (= l1Target)
    //   value = msg.value
    //   data = callData (the data sent to the proxy)
    //   sourceAddress = msg.sender of the proxy (= l2Sender, the EOA)
    //   sourceRollup = ROLLUP_ID (= this.config.rollupId)
    const proxyCallAction: Action = {
      actionType: ActionType.CALL,
      rollupId: 0n, // proxy.originalRollupId for L1 targets
      destination: l1Target,
      value: l2CallValue,
      data: l2CallData,
      failed: false,
      sourceAddress: l2Sender,
      sourceRollup: this.config.rollupId,
      scope: [],
    };
    const proxyCallHash = this.computeActionHash(proxyCallAction);

    // The nextAction is a RESULT with the L1 call's return data
    const simResultAction: Action = {
      actionType: ActionType.RESULT,
      rollupId: 0n,
      destination: "0x0000000000000000000000000000000000000000",
      value: 0n,
      data: l1CallResult.returnData,
      failed: l1CallResult.failed,
      sourceAddress: "0x0000000000000000000000000000000000000000",
      sourceRollup: 0n,
      scope: [],
    };

    // Encode loadExecutionTable call
    const ccmIface = new Interface([
      `function loadExecutionTable(${EXECUTION_ENTRY_TUPLE_TYPE}[] entries)`,
    ]);
    const simEntries = [{
      stateDeltas: [],
      actionHash: proxyCallHash,
      nextAction: [
        simResultAction.actionType,
        simResultAction.rollupId,
        simResultAction.destination,
        simResultAction.value,
        simResultAction.data,
        simResultAction.failed,
        simResultAction.sourceAddress,
        simResultAction.sourceRollup,
        simResultAction.scope,
      ],
    }];
    const loadCallData = ccmIface.encodeFunctionData("loadExecutionTable", [simEntries]);

    // Mine the loadExecutionTable as its own block BEFORE the user's tx.
    // This ensures the execution entry is available when the proxy call runs.
    // Using systemCall (not sendSystemTx) so it mines immediately.
    console.log(`[Planner] Pre-loading execution entry for proxy call (actionHash=${proxyCallHash.slice(0, 18)}...)`);
    await this.fullnodeProvider.send("syncrollups_systemCall", [
      this.config.rollupsAddress,
      loadCallData,
      "0x0",
      timestamp,
    ]);

    // Now simulate user's L2TX (mines its own L2 block — the proxy call will find the entry)
    const l2txTimestamp = timestamp ? timestamp + 1 : undefined;
    const l2txSimulation = await this.simulateAction(l2txAction, l2txTimestamp);
    if (!l2txSimulation.success) {
      throw new Error(
        `L2 transaction simulation failed for L2→L1 planning: ${l2txSimulation.error || "unknown error"}`
      );
    }

    const postL2State =
      l2txSimulation.stateDeltas.length > 0
        ? l2txSimulation.stateDeltas[0].newState
        : this.computeNewState(currentState, l2txActionHash);

    entries.push({
      stateDeltas: [{
        rollupId: this.config.rollupId,
        currentState,
        newState: postL2State,
        etherDelta: 0n,
      }],
      actionHash: l2txActionHash,
      nextAction: callAction,
    });
    rootActions.push(l2txAction);

    // ── Entry 2: RESULT(call) → final RESULT ───────────────────────────
    const callResultAction = createResultAction(
      this.config.rollupId,
      l1CallResult.returnData,
      l1CallResult.failed
    );
    const callResultHash = this.computeActionHash(callResultAction);

    const continuationStateDeltas: StateDelta[] = l2CallValue > 0n
      ? [{
          rollupId: this.config.rollupId,
          currentState: postL2State,
          newState: postL2State,
          etherDelta: -l2CallValue,
        }]
      : [];
    entries.push({
      stateDeltas: continuationStateDeltas,
      actionHash: callResultHash,
      nextAction: createResultAction(
        this.config.rollupId,
        l1CallResult.returnData,
        l1CallResult.failed
      ),
    });
    rootActions.push(callResultAction);

    // The user's L2TX entry index: 1 if proxy deploy present, 0 otherwise
    const userEntryIndex = proxyDeploySignedTx ? 1 : 0;

    return {
      entries,
      rootActionHash: this.computeActionHash(rootActions[0]),
      rootActions,
      proof: "",
      preloadSystemCalls: [{
        entryIndex: userEntryIndex,
        to: this.config.rollupsAddress,
        data: loadCallData,
      }],
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
   * This is called when an L1 contract calls a CrossChainProxy
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
   * IMPORTANT: The action hash must match exactly what CrossChainProxy.fallback() produces:
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
    timestamp?: number,         // L1 block timestamp for deterministic state roots
    overrideCurrentState?: string, // Use this instead of L1 state when correction pending
    proxyRollupId?: bigint      // Proxy's originalRollupId (from authorizedProxies); defaults to config.rollupId
  ): Promise<ExecutionPlan> {
    const entries: ExecutionEntry[] = [];

    // Get current state from L1 (this is what the contract will check)
    // If overrideCurrentState is provided (state correction pending), use that instead
    const states = await this.getStates();
    const currentState = overrideCurrentState || states.l1State.stateRoot;
    console.log(`[Planner] Current L1 state: ${currentState.slice(0, 18)}...${overrideCurrentState ? " (corrected)" : ""}`);

    // Build CALL action matching Rollups.executeCrossChainCall:
    // - rollupId = proxyInfo.originalRollupId (from the proxy contract)
    // - sourceAddress = msg.sender passed by proxy = the original L1 caller
    // - sourceRollup = MAINNET_ROLLUP_ID = 0
    const actionRollupId = proxyRollupId ?? this.config.rollupId;
    const callAction = createCallAction(
      actionRollupId,        // rollupId = proxyInfo.originalRollupId
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
