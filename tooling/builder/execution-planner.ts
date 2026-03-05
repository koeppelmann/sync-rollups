/**
 * Execution Planner for sync-rollups builder
 * Computes all execution paths for a transaction
 */

import { JsonRpcProvider, keccak256, AbiCoder } from "ethers";
import {
  Action,
  Execution,
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
  executionToJson,
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
  async planL2Transaction(rlpEncodedTx: string): Promise<ExecutionPlan> {
    const executions: Execution[] = [];

    // Get current state from L1 directly (this is what the contract will check)
    const states = await this.getStates();
    const currentState = states.l1State.stateRoot;
    console.log(`[Planner] Current L1 state: ${currentState.slice(0, 18)}...`);

    // Build L2TX action
    const l2txAction = createL2TXAction(this.config.rollupId, rlpEncodedTx);
    const rootActionHash = this.computeActionHash(l2txAction);
    console.log(`[Planner] Action hash: ${rootActionHash.slice(0, 18)}...`);

    // Simulate the transaction
    const simulation = await this.simulateAction(l2txAction);
    console.log(`[Planner] Simulation success: ${simulation.success}, stateDeltas: ${simulation.stateDeltas.length}`);

    // Build RESULT action
    const resultAction = createResultAction(
      this.config.rollupId,
      simulation.nextAction.data,
      simulation.nextAction.failed
    );

    // For L2TX, we use the L1 state as current, and compute a new state hash
    // In a real implementation, the new state would come from actually executing on L2
    // For now, we create a deterministic new state based on the action
    const newState = simulation.stateDeltas.length > 0
      ? simulation.stateDeltas[0].newState
      : this.computeNewState(currentState, rootActionHash);

    console.log(`[Planner] New state: ${newState.slice(0, 18)}...`);

    // Create execution for L2TX -> RESULT
    const execution: Execution = {
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

    executions.push(execution);

    return {
      executions,
      rootActionHash,
      proof: "", // Will be filled by proof-generator
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
    sourceProxyOnL1: string
  ): Promise<ExecutionPlan> {
    const executions: Execution[] = [];

    // Root action: L2TX
    const states = await this.getStates();
    const currentState = states.l1State.stateRoot;
    const l2txAction = createL2TXAction(this.config.rollupId, rlpEncodedTx);
    const rootActionHash = this.computeActionHash(l2txAction);

    // Simulate root L2TX on fullnode to obtain the post-tx L2 state root.
    const l2txSimulation = await this.simulateAction(l2txAction);
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

    // Simulate the L1 call return data (state changes on L1 are not in rollup state deltas).
    const l1CallResult = await this.simulateL1Call(
      sourceProxyOnL1,
      l1Target,
      l2CallData,
      l2CallValue
    );

    // Execution #1: L2TX -> CALL(L1)
    const rootExecution: Execution = {
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
    executions.push(rootExecution);

    // Result action hash is what Rollups._processCallAtScope computes after CALL.
    const callResultAction = createResultAction(
      this.config.rollupId,
      l1CallResult.returnData,
      l1CallResult.failed
    );
    const callResultHash = this.computeActionHash(callResultAction);

    // Execution #2: RESULT(call) -> final RESULT.
    // No rollup state change here; this continuation only finalizes the call chain.
    const continuationExecution: Execution = {
      stateDeltas: [],
      actionHash: callResultHash,
      nextAction: createResultAction(
        this.config.rollupId,
        l1CallResult.returnData,
        l1CallResult.failed
      ),
    };
    executions.push(continuationExecution);

    return {
      executions,
      rootActionHash,
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
    const executions: Execution[] = [];

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
    const execution: Execution = {
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

    executions.push(execution);

    return {
      executions,
      rootActionHash,
      proof: "", // Will be filled by proof-generator
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
    sourceProxyAddress: string  // L2 proxy representing the original L1 caller
  ): Promise<ExecutionPlan> {
    const executions: Execution[] = [];

    // Get current state from L1 (this is what the contract will check)
    const states = await this.getStates();
    const currentState = states.l1State.stateRoot;
    console.log(`[Planner] Current L1 state: ${currentState.slice(0, 18)}...`);

    // Build CALL action exactly as L2Proxy.fallback() does:
    // - sourceAddress = address(this) = targetProxyAddress
    // - sourceRollup = rollupId = this.config.rollupId (NOT L1 chain ID!)
    const callAction = createCallAction(
      this.config.rollupId,  // rollupId
      l2Target,              // destination = _getOriginalAddress()
      value,                 // msg.value
      callData,              // msg.data
      targetProxyAddress,    // sourceAddress = address(this)
      this.config.rollupId,  // sourceRollup = rollupId (NOT L1 chain ID!)
      []                     // scope = empty
    );
    const rootActionHash = this.computeActionHash(callAction);
    console.log(`[Planner] Action hash: ${rootActionHash.slice(0, 18)}...`);

    // Simulate the L1→L2 call
    const simulation = await this.simulateL1ToL2Call(
      l2Target,
      callData,
      value,
      sourceProxyAddress
    );
    console.log(`[Planner] Simulation success: ${simulation.success}, returnData: ${simulation.returnData.slice(0, 18)}...`);

    // Build RESULT action
    const resultAction = createResultAction(
      this.config.rollupId,
      simulation.returnData,
      simulation.failed
    );

    // For L1→L2 calls, etherDelta should be 0 because the L2Proxy already calls
    // depositEther() which increments the rollup's etherBalance on L1.
    // We don't want to double-count by also adding it via etherDelta.
    const etherDelta = 0n;

    // Build state deltas - always use etherDelta=0 for L1→L2 calls because
    // the L2Proxy already calls depositEther() which handles the balance update
    const stateDeltas: StateDelta[] = simulation.stateDeltas.length > 0
      ? simulation.stateDeltas.map(sd => ({ ...sd, etherDelta: 0n })) // Override etherDelta to 0
      : [
          {
            rollupId: this.config.rollupId,
            currentState,
            newState: simulation.newState || this.computeNewState(currentState, rootActionHash),
            etherDelta,
          },
        ];

    // Create execution for CALL -> RESULT
    const execution: Execution = {
      stateDeltas,
      actionHash: rootActionHash,
      nextAction: resultAction,
    };

    executions.push(execution);
    console.log(`[Planner] Created execution with etherDelta: ${etherDelta}`);

    return {
      executions,
      rootActionHash,
      proof: "", // Will be filled by proof-generator
    };
  }

  /**
   * Simulate an L1→L2 call on the fullnode
   */
  private async simulateL1ToL2Call(
    destination: string,
    data: string,
    value: bigint,
    fromProxy: string
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
      }]);

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
  private async simulateAction(action: Action): Promise<SimulationResult> {
    // Convert to JSON-safe format for RPC
    const actionJson = actionToJson(action);
    const resultJson = await this.fullnodeProvider.send("syncrollups_simulateAction", [
      actionJson,
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
  async notifyExecutions(executions: Execution[]): Promise<void> {
    // Convert to JSON-safe format
    const executionsJson = executions.map(executionToJson);
    await this.fullnodeProvider.send("syncrollups_loadExecutions", [
      executionsJson,
    ]);
  }

  /**
   * Check if fullnode is synced
   */
  async isFullnodeSynced(): Promise<boolean> {
    return await this.fullnodeProvider.send("syncrollups_isSynced", []);
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
