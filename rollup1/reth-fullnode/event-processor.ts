/**
 * Event Processor for sync-rollups fullnode
 * Watches L1 for Rollups contract events and processes them
 */

import { Contract, JsonRpcProvider, Interface, EventLog, Log, Transaction, AbiCoder } from "ethers";
import { StateManager, SyncState, L1L2Checkpoint } from "./state-manager.js";
import { ROLLUPS_EVENTS, ExecutionEntry, ActionType } from "./types.js";

export interface EventProcessorConfig {
  l1RpcUrl: string;
  rollupsAddress: string;
  rollupId: bigint;
  startBlock: number;
  pollingInterval?: number; // ms, default 2000
}

// Rollups contract ABI (events and functions)
const ROLLUPS_ABI = [
  "event RollupCreated(uint256 indexed rollupId, address indexed owner, bytes32 verificationKey, bytes32 initialState)",
  "event StateUpdated(uint256 indexed rollupId, bytes32 newStateRoot)",
  "event VerificationKeyUpdated(uint256 indexed rollupId, bytes32 newVerificationKey)",
  "event OwnershipTransferred(uint256 indexed rollupId, address indexed previousOwner, address indexed newOwner)",
  "event CrossChainProxyCreated(address indexed proxy, address indexed originalAddress, uint256 indexed originalRollupId)",
  "event L2ExecutionPerformed(uint256 indexed rollupId, bytes32 currentState, bytes32 newState)",
  "event ExecutionConsumed(bytes32 indexed actionHash, tuple(uint8 actionType, uint256 rollupId, address destination, uint256 value, bytes data, bool failed, address sourceAddress, uint256 sourceRollup, uint256[] scope) action)",
  // Read functions we need
  "function rollups(uint256) view returns (address owner, bytes32 verificationKey, bytes32 stateRoot, uint256 etherBalance)",
  "function computeCrossChainProxyAddress(address originalAddress, uint256 originalRollupId, uint256 domain) view returns (address)",
  "function authorizedProxies(address) view returns (address originalAddress, uint64 originalRollupId)",
  // Functions we need to decode L1 transactions
  "function executeL2TX(uint256 rollupId, bytes calldata rlpEncodedTx) external returns (bytes)",
];

// CrossChainProxy immutables are internal in the new contract.
// Use authorizedProxies(address) on the Rollups/CrossChainManagerL2 contract to look up proxy identity.

interface ProcessedEvent {
  blockNumber: number;
  logIndex: number;
  eventName: string;
  args: any;
  transactionHash: string;  // L1 tx hash that emitted this event
}

export class EventProcessor {
  private config: EventProcessorConfig;
  private stateManager: StateManager;
  private l1Provider: JsonRpcProvider;
  private rollupsContract: Contract;
  private rollupsInterface: Interface;

  private lastProcessedBlock: number;
  private pollingInterval: number;
  private lastEventWasStateUpdate = false;
  private lastFraudWarningState = "";
  private pollTimer: NodeJS.Timeout | null = null;
  private eventQueue: ProcessedEvent[] = [];
  private processing = false;

  // L1 reorg detection and recovery
  private blockHashHistory: Map<number, string> = new Map();
  private checkpoints: L1L2Checkpoint[] = [];
  private readonly MAX_REORG_HISTORY = 128;  // Max blocks of hash history to keep
  private readonly REORG_CHECK_DEPTH = 8;    // Blocks to check per poll cycle
  private reorgInProgress = false;
  private readonly deploymentBlock: number;  // Original deployment block (never changes)

  /** Expose L1 RPC URL for use by other components (e.g. RpcServer) */
  getL1RpcUrl(): string {
    return this.config.l1RpcUrl;
  }

  constructor(config: EventProcessorConfig, stateManager: StateManager) {
    this.config = config;
    this.stateManager = stateManager;
    this.lastProcessedBlock = config.startBlock - 1;
    this.pollingInterval = config.pollingInterval || 2000;
    this.deploymentBlock = config.startBlock; // Remember original deployment block

    this.l1Provider = new JsonRpcProvider(config.l1RpcUrl, undefined, {
      batchMaxCount: 1, // Disable batching to avoid rate limits on public RPCs
    });
    this.rollupsInterface = new Interface(ROLLUPS_ABI);
    this.rollupsContract = new Contract(
      config.rollupsAddress,
      ROLLUPS_ABI,
      this.l1Provider
    );
  }

  /**
   * Restore state from persisted sync state, including reorg data.
   * Called when persisted sync state is found on startup.
   */
  setResumeState(syncState: SyncState): void {
    const resumeBlock = syncState.lastProcessedL1Block + 1;
    this.config.startBlock = resumeBlock;
    this.lastProcessedBlock = syncState.lastProcessedL1Block;

    // Restore tracked state root and ether balance
    this.stateManager.restoreState(syncState.stateRoot, syncState.etherBalance || "0");

    // Restore block hash history
    if (syncState.blockHashHistory) {
      this.blockHashHistory.clear();
      for (const entry of syncState.blockHashHistory) {
        this.blockHashHistory.set(entry.blockNumber, entry.blockHash);
      }
      console.log(`[EventProcessor] Restored ${this.blockHashHistory.size} block hash entries`);
    }

    // Restore checkpoints
    if (syncState.checkpoints) {
      this.checkpoints = [...syncState.checkpoints];
      console.log(`[EventProcessor] Restored ${this.checkpoints.length} checkpoints`);
    }
  }

  /**
   * Start watching for events
   */
  async start(): Promise<void> {
    console.log(
      `[EventProcessor] Starting from block ${this.config.startBlock}`
    );

    // First, verify our rollup exists
    await this.verifyRollupExists();

    // Replay historical events
    await this.replayHistoricalEvents();

    // Start polling for new events
    this.startPolling();
  }

  /**
   * Stop watching for events
   */
  stop(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    console.log("[EventProcessor] Stopped");
  }

  /**
   * Verify that our rollup exists on L1
   */
  private async verifyRollupExists(): Promise<void> {
    const rollupData = await this.rollupsContract.rollups(
      this.config.rollupId
    );
    if (
      rollupData.owner === "0x0000000000000000000000000000000000000000"
    ) {
      throw new Error(`Rollup ${this.config.rollupId} does not exist`);
    }
    console.log(
      `[EventProcessor] Rollup ${this.config.rollupId} exists, owner: ${rollupData.owner}`
    );
    console.log(
      `[EventProcessor] Current state root: ${rollupData.stateRoot}`
    );
  }

  /**
   * Replay all historical events from startBlock to current
   */
  private async replayHistoricalEvents(): Promise<void> {
    const currentBlock = await this.l1Provider.getBlockNumber();
    console.log(
      `[EventProcessor] Replaying events from block ${this.config.startBlock} to ${currentBlock}`
    );

    // Fetch events in batches to avoid RPC limits
    const batchSize = 10000;
    let fromBlock = this.config.startBlock;

    while (fromBlock <= currentBlock) {
      const toBlock = Math.min(fromBlock + batchSize - 1, currentBlock);
      await this.fetchAndProcessEvents(fromBlock, toBlock);
      fromBlock = toBlock + 1;
    }

    console.log("[EventProcessor] Historical replay complete");
  }

  /**
   * Fetch events in a block range and add to queue
   */
  private async fetchAndProcessEvents(
    fromBlock: number,
    toBlock: number
  ): Promise<void> {
    // Record block hashes for reorg detection
    await this.recordBlockHashes(fromBlock, toBlock);

    // Fetch StateUpdated events for our rollup
    const stateUpdatedFilter =
      this.rollupsContract.filters.StateUpdated(this.config.rollupId);
    const stateUpdatedEvents = await this.rollupsContract.queryFilter(
      stateUpdatedFilter,
      fromBlock,
      toBlock
    );

    // Fetch L2ExecutionPerformed events for our rollup
    const executionFilter = this.rollupsContract.filters.L2ExecutionPerformed(
      this.config.rollupId
    );
    const executionEvents = await this.rollupsContract.queryFilter(
      executionFilter,
      fromBlock,
      toBlock
    );

    // Fetch ExecutionConsumed events (contains the Action struct with all details)
    const consumedFilter = this.rollupsContract.filters.ExecutionConsumed();
    const consumedEvents = await this.rollupsContract.queryFilter(
      consumedFilter,
      fromBlock,
      toBlock
    );

    // Index ExecutionConsumed events by tx hash for quick lookup
    const consumedByTxHash = new Map<string, any[]>();
    for (const event of consumedEvents) {
      if (event instanceof EventLog) {
        const existing = consumedByTxHash.get(event.transactionHash) || [];
        existing.push(event.args);
        consumedByTxHash.set(event.transactionHash, existing);
      }
    }

    // Combine and sort by block number and log index
    const allEvents: ProcessedEvent[] = [];

    for (const event of stateUpdatedEvents) {
      if (event instanceof EventLog) {
        allEvents.push({
          blockNumber: event.blockNumber,
          logIndex: event.index,
          eventName: "StateUpdated",
          transactionHash: event.transactionHash,
          args: {
            rollupId: event.args[0],
            newStateRoot: event.args[1],
          },
        });
      }
    }

    for (const event of executionEvents) {
      if (event instanceof EventLog) {
        // Find ExecutionConsumed events from the same tx
        const consumed = consumedByTxHash.get(event.transactionHash);
        const firstConsumed = consumed?.[0];
        const secondConsumed = consumed?.[1]; // Present for L2→L1 calls (RESULT from L1 execution)
        allEvents.push({
          blockNumber: event.blockNumber,
          logIndex: event.index,
          eventName: "L2ExecutionPerformed",
          transactionHash: event.transactionHash,
          args: {
            rollupId: event.args[0],
            currentState: event.args[1],
            newState: event.args[2],
            // Action from ExecutionConsumed event (if available)
            consumedAction: firstConsumed ? {
              actionType: Number(firstConsumed[1][0]),
              rollupId: firstConsumed[1][1],
              destination: firstConsumed[1][2],
              value: firstConsumed[1][3],
              data: firstConsumed[1][4],
              failed: firstConsumed[1][5],
              sourceAddress: firstConsumed[1][6],
              sourceRollup: firstConsumed[1][7],
            } : null,
            // Second consumed action (RESULT from L1 call in L2→L1 flow)
            // When present, this L2TX triggered an L2→L1 cross-chain call
            l2ToL1Result: secondConsumed ? {
              actionType: Number(secondConsumed[1][0]),
              rollupId: secondConsumed[1][1],
              destination: secondConsumed[1][2],
              value: secondConsumed[1][3],
              data: secondConsumed[1][4],
              failed: secondConsumed[1][5],
              sourceAddress: secondConsumed[1][6],
              sourceRollup: secondConsumed[1][7],
            } : null,
          },
        });
      }
    }

    // Sort by block number, then log index
    allEvents.sort((a, b) => {
      if (a.blockNumber !== b.blockNumber) {
        return a.blockNumber - b.blockNumber;
      }
      return a.logIndex - b.logIndex;
    });

    // Save checkpoint before processing events for each distinct L1 block
    // This gives us precise rollback targets for reorg recovery
    // Group consecutive L2ExecutionPerformed events from the same L1 tx for batch replay
    let lastCheckpointedBlock = -1;
    let i = 0;
    try {
    while (i < allEvents.length) {
      const event = allEvents[i];
      if (event.blockNumber !== lastCheckpointedBlock) {
        lastCheckpointedBlock = event.blockNumber;
        await this.saveCheckpoint(event.blockNumber);
      }

      // Check if this is part of a batch: multiple L2ExecutionPerformed events from same L1 block
      // Exclude L1-only accounting events (currentState == newState) — they don't produce L2 blocks
      if (event.eventName === "L2ExecutionPerformed") {
        const consecutiveEvents = [event];
        while (
          i + consecutiveEvents.length < allEvents.length &&
          allEvents[i + consecutiveEvents.length].eventName === "L2ExecutionPerformed" &&
          allEvents[i + consecutiveEvents.length].blockNumber === event.blockNumber
        ) {
          consecutiveEvents.push(allEvents[i + consecutiveEvents.length]);
        }

        // Filter to only events that require L2 replay (state actually changes)
        const batchEvents = consecutiveEvents.filter(
          (e) => e.args.currentState !== e.args.newState
        );

        if (batchEvents.length > 1) {
          console.log(`[EventProcessor] Batch of ${batchEvents.length} L2TXs from L1 block ${event.blockNumber}`);
          await this.replayBatchExecution(batchEvents);
          // Process the L1-only accounting events individually
          for (const e of consecutiveEvents) {
            if (e.args.currentState === e.args.newState) {
              await this.processEvent(e);
            }
          }
          i += consecutiveEvents.length;
          continue;
        }

        // If only 0-1 events need L2 replay, process all individually
        if (consecutiveEvents.length > 1) {
          for (const e of consecutiveEvents) {
            await this.processEvent(e);
          }
          i += consecutiveEvents.length;
          continue;
        }
      }

      await this.processEvent(event);
      i++;
    }
    } catch (e: any) {
      if (e.message === 'FULL_REPLAY_NEEDED') {
        // Rollback undershoot: engine API blocks weren't persisted before reth was stopped.
        // Wipe L2 state and restart from the deployment block.
        console.log(`[EventProcessor] Triggering full replay from deployment block ${this.deploymentBlock}`);
        await this.stateManager.stopEngine();
        this.stateManager.clearRethData();
        await this.stateManager.startEngine();
        this.stateManager.resetState();
        this.blockHashHistory.clear();
        this.checkpoints = [];
        this.stateManager.clearExecutionCache();
        this.lastProcessedBlock = this.deploymentBlock - 1;
        // Re-process all events from deployment block
        const currentBlock = await this.l1Provider.getBlockNumber();
        if (currentBlock > this.lastProcessedBlock) {
          console.log(`[EventProcessor] Re-processing events from block ${this.lastProcessedBlock + 1} to ${currentBlock}`);
          const batchSize = 10000;
          let replayFrom = this.lastProcessedBlock + 1;
          while (replayFrom <= currentBlock) {
            const replayTo = Math.min(replayFrom + batchSize - 1, currentBlock);
            await this.fetchAndProcessEvents(replayFrom, replayTo);
            replayFrom = replayTo + 1;
          }
        }
        return;
      }
      throw e;
    }

    this.lastProcessedBlock = toBlock;

    // Persist sync state after each batch (including reorg data)
    this.stateManager.saveSyncState(toBlock, this.getReorgData());
  }

  /**
   * Process a single event
   */
  private async processEvent(event: ProcessedEvent): Promise<void> {
    const { eventName, args, blockNumber, transactionHash } = event;

    switch (eventName) {
      case "StateUpdated":
        console.log(
          `[EventProcessor] StateUpdated at block ${blockNumber}: ${args.newStateRoot.slice(0, 10)}...`
        );
        this.stateManager.updateState(args.newStateRoot, BigInt(blockNumber));
        this.lastEventWasStateUpdate = true;
        break;

      case "L2ExecutionPerformed":
        console.log(
          `[EventProcessor] L2ExecutionPerformed at block ${blockNumber}: ${args.currentState.slice(0, 10)}... -> ${args.newState.slice(0, 10)}...`
        );
        // Replay the execution on L2 EVM using action data from ExecutionConsumed event
        await this.replayExecution(args.currentState, args.newState, blockNumber, transactionHash, args.consumedAction, args.l2ToL1Result);
        this.lastEventWasStateUpdate = false;
        break;

      default:
        console.log(`[EventProcessor] Unknown event: ${eventName}`);
    }
  }

  /**
   * Replay an execution on the local L2 EVM by extracting data from L1 transaction
   * This is the key function that allows L2 state to be deterministically derived from L1
   */
  private async replayExecution(
    currentState: string,
    newState: string,
    blockNumber: number,
    l1TxHash: string,
    consumedAction?: { actionType: number; rollupId: bigint; destination: string; value: bigint; data: string; failed: boolean; sourceAddress: string; sourceRollup: bigint } | null,
    l2ToL1Result?: { actionType: number; rollupId: bigint; data: string; failed: boolean; [key: string]: any } | null
  ): Promise<void> {
    console.log(
      `[EventProcessor] Replaying execution from L1 tx ${l1TxHash.slice(0, 10)}...`
    );

    // Verify our tracked state matches
    const trackedState = this.stateManager.getStateRoot();
    if (trackedState !== currentState) {
      console.warn(
        `[EventProcessor] State mismatch! Tracked: ${trackedState.slice(0, 10)}..., Event: ${currentState.slice(0, 10)}...`
      );
    }

    // When currentState === newState, this is an L1-only accounting event
    // (e.g., ether delta from an L2→L1 withdrawal continuation). No L2 state
    // change, no L2 block to mine — just update our tracked state.
    if (currentState === newState) {
      console.log(
        `[EventProcessor] L1-only accounting event (currentState == newState), no L2 replay needed`
      );
      this.stateManager.updateState(newState, BigInt(blockNumber));
      return;
    }

    // Check if the L2 EVM already has the correct post-execution state.
    // This happens when the builder's fullnode pre-executed the call during
    // planL1ToL2CallWithProxy. In that case, we may skip re-execution — but only
    // if the L2 block timestamp matches the actual L1 block timestamp.
    // On real chains (non-Anvil), the builder simulates with a predicted timestamp
    // that may differ from the actual L1 block timestamp. If they don't match,
    // we must rollback and re-execute with the correct timestamp.
    try {
      const actualL2State = await this.stateManager.getActualStateRoot();
      if (actualL2State === newState && currentState !== newState) {
        // Pre-executed state matches. Verify timestamp correctness.
        const l1Block = await this.l1Provider.getBlock(blockNumber);
        const l1Timestamp = l1Block ? Number(l1Block.timestamp) : undefined;
        const l2BlockNum = await this.stateManager.getL2BlockNumber();
        const l2Block = await this.stateManager.getL2Provider()!.send(
          "eth_getBlockByNumber", [`0x${l2BlockNum.toString(16)}`, false]
        );
        const l2Timestamp = l2Block ? parseInt(l2Block.timestamp, 16) : undefined;

        if (l1Timestamp && l2Timestamp && l1Timestamp === l2Timestamp) {
          console.log(
            `[EventProcessor] L2 state already matches newState (pre-executed), skipping replay`
          );
        } else {
          // Timestamp mismatch — on real chains (non-Anvil) this is expected since
          // the builder simulates with a predicted timestamp. Accept the pre-executed
          // state to maintain consistency with builder and proofer. Rolling back and
          // re-executing with the L1 timestamp would produce a different state root,
          // causing divergence between nodes.
          console.log(
            `[EventProcessor] Pre-executed state matches newState (L2 ts=${l2Timestamp}, L1 ts=${l1Timestamp}), ` +
            `accepting pre-executed state for consistency`
          );
        }
        this.stateManager.updateState(newState, BigInt(blockNumber), l2BlockNum);
        console.log(`[EventProcessor] State updated to: ${newState.slice(0, 10)}...`);
        return;
      }
    } catch (e: any) {
      if (e.message === 'FULL_REPLAY_NEEDED') throw e;
      // If we can't check, proceed with normal replay
      console.warn(`[EventProcessor] Could not check L2 state: ${e.message}`);
    }

    try {
      // Get the L1 transaction that triggered this execution
      const l1Tx = await this.l1Provider.getTransaction(l1TxHash);
      if (!l1Tx) {
        throw new Error(`L1 transaction ${l1TxHash} not found`);
      }

      // Per state transition spec (Rules 2 & 3):
      // - coinbase = msg.sender on L1 (the address that called the L1 function)
      // - timestamp = L1 block timestamp
      //
      // The L2 block timestamp MUST match the L1 block timestamp so that
      // builder simulation and event processor replay produce the same state root.
      // The builder forces the L1 block timestamp via evm_setNextBlockTimestamp
      // before mining the L1 block containing the execution.
      const l1Block = await this.l1Provider.getBlock(blockNumber);
      const l1Timestamp = l1Block ? l1Block.timestamp : undefined;
      console.log(`[EventProcessor] Replaying L1 caller=${l1Tx.from}, L1 block timestamp=${l1Timestamp}`);

      // Try to decode as a Rollups contract call
      const decoded = this.rollupsInterface.parseTransaction({ data: l1Tx.data });

      if (decoded && decoded.name === 'executeL2TX') {
        // Broadcast the original signed L2 transaction to reth.
        // The sender must have sufficient L2 balance (bridged from L1).
        // Rule 1: exactly one L2 block per L1 function call.
        const rlpEncodedTx = decoded.args[1];
        const { Transaction: TxClass } = await import("ethers");
        const parsedTx = TxClass.from(rlpEncodedTx);
        console.log(`[EventProcessor] L2TX: from=${parsedTx.from?.slice(0, 10)}... -> ${parsedTx.to ? parsedTx.to.slice(0, 10) + '...' : 'CREATE'}, value=${parsedTx.value}`);

        // L2→L1 call: pre-load execution entry in its own block, then mine
        // the user's tx in the next block. Separate blocks are needed because
        // reth orders txs by gas price, not submission order.
        if (l2ToL1Result && parsedTx.to) {
          const l2Provider = this.stateManager.getL2Provider()!;
          const proxyInfo = await new Contract(this.config.rollupsAddress, [
            "function authorizedProxies(address) view returns (address, uint64)",
          ], l2Provider).authorizedProxies(parsedTx.to);
          const originalAddress = proxyInfo[0] as string;
          const originalRollupId = BigInt(proxyInfo[1]);
          // Block N: system preload
          await this.preloadL2ToL1Entry(parsedTx, originalAddress, originalRollupId, l2ToL1Result);
          await this.stateManager.mineBlock({ timestamp: l1Timestamp });
          // Block N+1: user tx
          await this.stateManager.sendRawTransaction(rlpEncodedTx);
          const userTimestamp = l1Timestamp ? l1Timestamp + 1 : undefined;
          await this.stateManager.mineBlock({ timestamp: userTimestamp });
          console.log(`[EventProcessor] L2→L1 L2TX executed with pre-loaded entry (2 blocks)`);
        } else {
          const txHash = await this.stateManager.broadcastRawTx(rlpEncodedTx, { timestamp: l1Timestamp });
          console.log(`[EventProcessor] L2TX executed: ${txHash}`);
        }
      } else if (consumedAction && consumedAction.actionType === 0) {
        // L1→L2 call: use the ExecutionConsumed event's Action struct
        // actionType 0 = CALL
        const l2Target = consumedAction.destination;
        const sourceAddress = consumedAction.sourceAddress;
        const callData = consumedAction.data;
        const value = consumedAction.value;

        console.log(`[EventProcessor] L1→L2 call (from ExecutionConsumed event)`);
        console.log(`[EventProcessor] L2 target: ${l2Target}, source: ${sourceAddress}, sourceRollup: ${consumedAction.sourceRollup}, value: ${value}`);

        // CrossChainManagerL2.executeIncomingCrossChainCall (now payable) requires execution
        // entries to be loaded via loadExecutionTable BEFORE calling it.
        // The flow inside _processCallAtScope:
        //   1. Calls sourceProxy.executeOnBehalf(destination, data) — gets returnData
        //   2. Builds a RESULT action with that returnData
        //   3. Hashes the RESULT → calls _consumeExecution(resultHash)
        // So we must predict the returnData via a dry-run eth_call, build the
        // RESULT, hash it, and load an entry keyed by that hash.
        const { Interface, AbiCoder } = await import("ethers");
        const provider = this.stateManager.getL2Provider();
        const rollupId = this.stateManager.getRollupId();

        // Step 1: Dry-run to predict return data from the destination call.
        // The actual execution goes through sourceProxy.executeOnBehalf which
        // does destination.call{value}(data). We simulate from the operator
        // address for deterministic results across L2 clients.
        const operatorAddr = this.stateManager.getOperatorAddress();
        let rawReturnData = "0x";
        let callFailed = false;
        try {
          const callArgs: any[] = [
            {
              from: operatorAddr,
              to: l2Target,
              value: "0x" + value.toString(16),
              data: callData,
            },
            "latest",
          ];
          if (value > 0n) {
            callArgs.push({ [operatorAddr]: { balance: "0x" + (value * 2n).toString(16) } });
          }
          rawReturnData = await provider.send("eth_call", callArgs);
        } catch (e: any) {
          // Call would revert — the proxy .call() catches this and sets failed=true
          callFailed = true;
          rawReturnData = e.data || "0x";
        }

        // Step 2: Use raw return data as-is to match what _processCallAtScope captures.
        // CrossChainProxy.executeOnBehalf uses assembly return, so the caller's .call()
        // gets the raw bytes from the destination — NOT ABI-wrapped.
        const abiCoder = AbiCoder.defaultAbiCoder();
        const proxyReturnData = rawReturnData;

        // Step 3: Build the RESULT action matching what _processCallAtScope builds
        const RESULT_ACTION_TYPE = 1; // ActionType.RESULT
        const resultAction = {
          actionType: RESULT_ACTION_TYPE,
          rollupId: rollupId,
          destination: "0x0000000000000000000000000000000000000000",
          value: 0n,
          data: proxyReturnData,
          failed: callFailed,
          sourceAddress: "0x0000000000000000000000000000000000000000",
          sourceRollup: 0n,
          scope: [] as bigint[],
        };

        // Step 4: Hash the RESULT using abi.encode(Action) — same encoding as Solidity
        const ACTION_TUPLE_TYPE = "tuple(uint8 actionType, uint256 rollupId, address destination, uint256 value, bytes data, bool failed, address sourceAddress, uint256 sourceRollup, uint256[] scope)";
        const encodedResult = abiCoder.encode(
          [ACTION_TUPLE_TYPE],
          [resultAction]
        );
        const { keccak256 } = await import("ethers");
        const resultHash = keccak256(encodedResult);

        // Step 5: Build a terminal RESULT nextAction for the entry
        const terminalResult = {
          actionType: RESULT_ACTION_TYPE,
          rollupId: 0n,
          destination: "0x0000000000000000000000000000000000000000",
          value: 0n,
          data: "0x",
          failed: false,
          sourceAddress: "0x0000000000000000000000000000000000000000",
          sourceRollup: 0n,
          scope: [] as bigint[],
        };

        // Step 6: Encode loadExecutionTable([entry]) call
        const ccmIface = new Interface([
          "function loadExecutionTable(tuple(tuple(uint256 rollupId, bytes32 currentState, bytes32 newState, int256 etherDelta)[] stateDeltas, bytes32 actionHash, tuple(uint8 actionType, uint256 rollupId, address destination, uint256 value, bytes data, bool failed, address sourceAddress, uint256 sourceRollup, uint256[] scope) nextAction)[] entries)",
          "function executeIncomingCrossChainCall(address destination, uint256 value, bytes data, address sourceAddress, uint256 sourceRollup, uint256[] scope)"
        ]);

        const entries = [{
          stateDeltas: [],
          actionHash: resultHash,
          nextAction: terminalResult,
        }];

        const loadCallData = ccmIface.encodeFunctionData("loadExecutionTable", [entries]);

        // Step 7: Send loadExecutionTable as system tx (no mining yet)
        await this.stateManager.sendSystemTx(
          this.config.rollupsAddress, // CrossChainManagerL2 address
          loadCallData
        );

        // Step 8: Send executeIncomingCrossChainCall as system tx
        const execCallData = ccmIface.encodeFunctionData("executeIncomingCrossChainCall", [
          l2Target,
          value,
          callData,
          sourceAddress,
          consumedAction.sourceRollup,
          [] // scope = empty for root calls
        ]);

        await this.stateManager.sendSystemTx(
          this.config.rollupsAddress, // CrossChainManagerL2 address
          execCallData,
          "0x" + value.toString(16)
        );

        // Step 9: Mine one block with both txs
        await this.stateManager.mineBlock({ timestamp: l1Timestamp });
        console.log(`[EventProcessor] L1→L2 call executed via loadExecutionTable + executeIncomingCrossChainCall`);
      } else {
        // Fallback: try to parse from L1 tx (legacy path)
        const proxyAddress = l1Tx.to;
        if (!proxyAddress) {
          throw new Error("L1 transaction has no 'to' address and no ExecutionConsumed event");
        }

        console.log(`[EventProcessor] L1→L2 call via proxy ${proxyAddress.slice(0, 10)}... (legacy path)`);

        // Look up proxy identity via authorizedProxies on the Rollups contract
        const proxyInfo = await this.rollupsContract.authorizedProxies(proxyAddress);
        const l2Target = proxyInfo[0]; // originalAddress
        console.log(`[EventProcessor] L2 target: ${l2Target}`);

        // Execute via operator system call
        const value = l1Tx.value;
        await this.stateManager.sendSystemTx(
          l2Target,
          l1Tx.data,
          "0x" + value.toString(16)
        );
        await this.stateManager.mineBlock({ timestamp: l1Timestamp });
        console.log(`[EventProcessor] Legacy L1→L2 call executed in single block`);
      }

      // Verify the state matches what L1 expects
      const actualState = await this.stateManager.getActualStateRoot();
      if (actualState !== newState) {
        console.warn(
          `[EventProcessor] State mismatch after replay! Expected: ${newState.slice(0, 10)}..., Got: ${actualState.slice(0, 10)}...`
        );
        // Keep the mismatched block to maintain L2 block height parity across all
        // fullnodes. Rolling back would cause block height divergence, which breaks
        // EIP-1559 base fee determinism. The tracked state advances to match L1;
        // the proofer uses hints to reach the correct starting state when needed.
      }

      // Update tracked state
      const postReplayL2Block = await this.stateManager.getL2BlockNumber();
      this.stateManager.updateState(newState, BigInt(blockNumber), postReplayL2Block);
      console.log(`[EventProcessor] State updated to: ${newState.slice(0, 10)}...`);

      // Check bridge invariant: L1 etherBalance + operator L2 balance == genesis balance
      await this.checkBridgeInvariant();

    } catch (error: any) {
      console.error(`[EventProcessor] Failed to replay execution: ${error.message}`);
      // Update tracked state anyway to stay in sync with L1
      const postErrorL2Block = await this.stateManager.getL2BlockNumber().catch(() => 0);
      this.stateManager.updateState(newState, BigInt(blockNumber), postErrorL2Block);
    }
  }

  /**
   * Replay a batch of L2TX events from the same L1 block as a single L2 block.
   * Each event has its own L1 tx hash (separate executeL2TX calls in same L1 block).
   * Sends all raw txs to the txpool, then mines one block containing all of them.
   *
   * For L2→L1 calls (detected by l2ToL1Result in event args), the L2 block contains:
   *   1. System tx: loadExecutionTable (pre-load entry for proxy to consume)
   *   2. Builder EOA tx: createCrossChainProxy (deploy proxy if needed)
   *   3. User tx: calls proxy, proxy consumes the pre-loaded entry
   * All derived implicitly from L1 data.
   */
  private async replayBatchExecution(events: ProcessedEvent[]): Promise<void> {
    const blockNumber = events[0].blockNumber;
    const finalNewState = events[events.length - 1].args.newState;

    try {
      // Fetch L1 block timestamp — all events share the same L1 block
      const l1Block = await this.l1Provider.getBlock(blockNumber);
      const l1Timestamp = l1Block ? l1Block.timestamp : undefined;
      let sentCount = 0;

      // First pass: decode all L2TXs and detect proxy deploys for L2→L1 flow.
      // Track proxy deploys so we know originalAddress/originalRollupId for L2→L1 calls.
      const proxyDeploysByAddress = new Map<string, { originalAddress: string; originalRollupId: bigint }>();
      const decodedTxs: { event: ProcessedEvent; rlpEncodedTx: string; parsedTx: Transaction }[] = [];

      for (const event of events) {
        const l1Tx = await this.l1Provider.getTransaction(event.transactionHash);
        if (!l1Tx) {
          console.warn(`[EventProcessor] L1 tx ${event.transactionHash} not found, skipping`);
          continue;
        }

        const decoded = this.rollupsInterface.parseTransaction({ data: l1Tx.data });
        if (decoded && decoded.name === 'executeL2TX') {
          const rlpEncodedTx = decoded.args[1];
          const parsedTx = Transaction.from(rlpEncodedTx);
          decodedTxs.push({ event, rlpEncodedTx, parsedTx });

          // Check if this L2TX is a createCrossChainProxy call
          if (parsedTx.to?.toLowerCase() === this.config.rollupsAddress.toLowerCase() && parsedTx.data.startsWith("0x2dd72120")) {
            // 0x2dd72120 = createCrossChainProxy(address,uint256)
            try {
              const ccmIface = new Interface([
                "function createCrossChainProxy(address originalAddress, uint256 originalRollupId) returns (address)",
              ]);
              const decodedProxy = ccmIface.decodeFunctionData("createCrossChainProxy", parsedTx.data);
              const originalAddress = decodedProxy[0] as string;
              const originalRollupId = BigInt(decodedProxy[1]);

              // Compute the deterministic proxy address on L2
              const l2Provider = this.stateManager.getL2Provider();
              const computeIface = new Interface([
                "function computeCrossChainProxyAddress(address, uint256, uint256) view returns (address)",
              ]);
              const l2ChainId = this.stateManager.getL2ChainId();
              const computeCalldata = computeIface.encodeFunctionData("computeCrossChainProxyAddress", [
                originalAddress, originalRollupId, l2ChainId,
              ]);
              const proxyResult = await l2Provider!.send("eth_call", [
                { to: this.config.rollupsAddress, data: computeCalldata }, "latest",
              ]);
              const proxyAddress = ("0x" + proxyResult.slice(26)).toLowerCase();
              proxyDeploysByAddress.set(proxyAddress, { originalAddress, originalRollupId });
              console.log(`[EventProcessor] Proxy deploy in batch: ${proxyAddress} → ${originalAddress} (rollupId=${originalRollupId})`);
            } catch (e: any) {
              console.warn(`[EventProcessor] Failed to decode proxy deploy: ${e.message}`);
            }
          }
        }
      }

      // Identify L2→L1 calls and split batch into blocks matching builder structure.
      // Builder produces: Block N = proxy deploy only, Block N+1 = system tx + user tx.
      // Non-L2→L1 batches: all txs in one block.
      const hasL2ToL1 = decodedTxs.some(({ event }) => event.args.l2ToL1Result);

      if (hasL2ToL1) {
        // L2→L1 batch: split into separate blocks.
        // First, send and mine proxy deploy txs (they need their own block).
        const proxyDeployTxs = decodedTxs.filter(
          ({ parsedTx }) => parsedTx.to?.toLowerCase() === this.config.rollupsAddress.toLowerCase()
            && parsedTx.data.startsWith("0x2dd72120")
        );
        const l2ToL1Txs = decodedTxs.filter(({ event }) => event.args.l2ToL1Result && event.args.l2ToL1Result);
        const otherTxs = decodedTxs.filter(
          ({ event, parsedTx }) => !event.args.l2ToL1Result
            && !(parsedTx.to?.toLowerCase() === this.config.rollupsAddress.toLowerCase() && parsedTx.data.startsWith("0x2dd72120"))
        );

        // Block 1: proxy deploys (if any)
        if (proxyDeployTxs.length > 0) {
          for (const { rlpEncodedTx } of proxyDeployTxs) {
            await this.stateManager.sendRawTransaction(rlpEncodedTx);
            sentCount++;
          }
          // Also include non-L2→L1, non-proxy-deploy txs in block 1
          for (const { rlpEncodedTx } of otherTxs) {
            await this.stateManager.sendRawTransaction(rlpEncodedTx);
            sentCount++;
          }
          await this.stateManager.mineBlock({ timestamp: l1Timestamp });
          console.log(`[EventProcessor] L2→L1 batch block 1: ${proxyDeployTxs.length + otherTxs.length} txs (proxy deploys + other)`);
        }

        // Block 2: system preloads (loadExecutionTable) — mined separately to
        // ensure they execute before user txs (reth orders by gas price, not
        // submission order, so co-mining would let user txs run first).
        for (const { event, parsedTx } of l2ToL1Txs) {
          if (!parsedTx.to) continue;
          const l2ToL1Result = event.args.l2ToL1Result;
          const txTo = parsedTx.to.toLowerCase();

          let originalAddress: string;
          let originalRollupId: bigint;
          const batchProxy = proxyDeploysByAddress.get(txTo);
          if (batchProxy) {
            originalAddress = batchProxy.originalAddress;
            originalRollupId = batchProxy.originalRollupId;
          } else {
            const l2Provider = this.stateManager.getL2Provider()!;
            const l2Contract = new Contract(this.config.rollupsAddress, [
              "function authorizedProxies(address) view returns (address, uint64)",
            ], l2Provider);
            const proxyInfo = await l2Contract.authorizedProxies(parsedTx.to);
            originalAddress = proxyInfo[0];
            originalRollupId = BigInt(proxyInfo[1]);
          }

          await this.preloadL2ToL1Entry(parsedTx, originalAddress, originalRollupId, l2ToL1Result);
          sentCount++;
        }
        const block2Timestamp = l1Timestamp ? l1Timestamp + 1 : undefined;
        await this.stateManager.mineBlock({ timestamp: block2Timestamp });
        console.log(`[EventProcessor] L2→L1 batch block 2: ${l2ToL1Txs.length} system preloads (timestamp=${block2Timestamp})`);

        // Block 3: L2→L1 user txs
        for (const { rlpEncodedTx } of l2ToL1Txs) {
          await this.stateManager.sendRawTransaction(rlpEncodedTx);
          sentCount++;
        }
        const block3Timestamp = l1Timestamp ? l1Timestamp + 2 : undefined;
        await this.stateManager.mineBlock({ timestamp: block3Timestamp });
        console.log(`[EventProcessor] L2→L1 batch block 3: ${l2ToL1Txs.length} L2→L1 user txs (timestamp=${block3Timestamp})`);
      } else {
        // Standard batch: all txs in one block
        for (const { rlpEncodedTx } of decodedTxs) {
          await this.stateManager.sendRawTransaction(rlpEncodedTx);
          sentCount++;
        }

        if (sentCount === 0) {
          throw new Error("No executeL2TX transactions decoded from batch events");
        }

        await this.stateManager.mineBlock({ timestamp: l1Timestamp });
        console.log(`[EventProcessor] Batch of ${sentCount} txs mined in single L2 block (timestamp=${l1Timestamp})`);
      }

      // Verify final state
      const actualState = await this.stateManager.getActualStateRoot();
      if (actualState !== finalNewState) {
        console.warn(
          `[EventProcessor] Batch state mismatch! Expected: ${finalNewState.slice(0, 10)}..., Got: ${actualState.slice(0, 10)}...`
        );
      }

      // Update tracked state for each event (intermediate states are trusted from L1)
      const batchL2Block = await this.stateManager.getL2BlockNumber();
      for (const event of events) {
        this.stateManager.updateState(event.args.newState, BigInt(blockNumber), batchL2Block);
      }
      console.log(`[EventProcessor] Batch state updated to: ${finalNewState.slice(0, 10)}...`);

    } catch (error: any) {
      console.error(`[EventProcessor] Failed to replay batch: ${error.message}`);
      // Update tracked state anyway
      for (const event of events) {
        this.stateManager.updateState(event.args.newState, BigInt(blockNumber));
      }
    }
  }

  /**
   * Pre-load an L2 execution entry for an L2→L1 call.
   * Sends a loadExecutionTable system tx (without mining) so the proxy can consume it.
   *
   * The entry maps: CALL action hash → RESULT nextAction (with L1 return data).
   * The CALL action hash matches what the L2 CrossChainProxy will compute when
   * the user's tx hits it.
   */
  private async preloadL2ToL1Entry(
    parsedTx: Transaction,
    originalAddress: string,
    originalRollupId: bigint,
    l2ToL1Result: { actionType: number; rollupId: bigint; data: string; failed: boolean; [key: string]: any }
  ): Promise<void> {
    const rollupId = this.stateManager.getRollupId();

    // Build the CALL action the L2 proxy will construct
    const callAction = {
      actionType: 0, // CALL
      rollupId: originalRollupId,
      destination: originalAddress,
      value: parsedTx.value,
      data: parsedTx.data,
      failed: false,
      sourceAddress: parsedTx.from!,
      sourceRollup: rollupId,
      scope: [] as bigint[],
    };

    // Hash the CALL action (same encoding as Solidity abi.encode(Action))
    const abiCoder = AbiCoder.defaultAbiCoder();
    const ACTION_TUPLE_TYPE = "tuple(uint8 actionType, uint256 rollupId, address destination, uint256 value, bytes data, bool failed, address sourceAddress, uint256 sourceRollup, uint256[] scope)";
    const encodedCall = abiCoder.encode([ACTION_TUPLE_TYPE], [callAction]);
    const { keccak256 } = await import("ethers");
    const callHash = keccak256(encodedCall);

    // Build the RESULT nextAction from the L1 execution result
    const resultNextAction = {
      actionType: 1, // RESULT
      rollupId: 0n,
      destination: "0x0000000000000000000000000000000000000000",
      value: 0n,
      data: l2ToL1Result.data,
      failed: l2ToL1Result.failed,
      sourceAddress: "0x0000000000000000000000000000000000000000",
      sourceRollup: 0n,
      scope: [] as bigint[],
    };

    // Encode loadExecutionTable([{ stateDeltas: [], actionHash: callHash, nextAction: resultNextAction }])
    const ccmIface = new Interface([
      "function loadExecutionTable(tuple(tuple(uint256 rollupId, bytes32 currentState, bytes32 newState, int256 etherDelta)[] stateDeltas, bytes32 actionHash, tuple(uint8 actionType, uint256 rollupId, address destination, uint256 value, bytes data, bool failed, address sourceAddress, uint256 sourceRollup, uint256[] scope) nextAction)[] entries)",
    ]);

    const entries = [{
      stateDeltas: [],
      actionHash: callHash,
      nextAction: resultNextAction,
    }];

    const loadCallData = ccmIface.encodeFunctionData("loadExecutionTable", [entries]);

    console.log(
      `[EventProcessor] Pre-loading L2→L1 entry: proxy calls ${originalAddress}, ` +
      `callHash=${callHash.slice(0, 14)}..., result.failed=${l2ToL1Result.failed}`
    );

    await this.stateManager.sendSystemTx(
      this.config.rollupsAddress,
      loadCallData
    );
  }

  /**
   * Start polling for new events
   */
  private startPolling(): void {
    console.log(
      `[EventProcessor] Watching L1 events (polling every ${this.pollingInterval}ms)`
    );

    const poll = async () => {
      try {
        // Step 1: Check for L1 reorgs BEFORE processing new events
        if (!this.reorgInProgress) {
          const forkBlock = await this.detectReorg();
          if (forkBlock !== null) {
            await this.handleReorg(forkBlock);
            // Schedule next poll immediately to continue processing
            this.pollTimer = setTimeout(poll, 100);
            return;
          }
        }

        // Step 2: Check for chain shrinkage (also a reorg signal)
        const currentBlock = await this.l1Provider.getBlockNumber();
        if (currentBlock < this.lastProcessedBlock) {
          console.warn(
            `[EventProcessor] Chain tip moved backward: ${this.lastProcessedBlock} -> ${currentBlock}`
          );
          await this.handleReorg(currentBlock + 1);
          this.pollTimer = setTimeout(poll, 100);
          return;
        }

        // Step 3: Normal event processing
        if (currentBlock > this.lastProcessedBlock) {
          await this.fetchAndProcessEvents(
            this.lastProcessedBlock + 1,
            currentBlock
          );
        }
      } catch (error) {
        console.error("[EventProcessor] Polling error:", error);
      }

      this.pollTimer = setTimeout(poll, this.pollingInterval);
    };

    poll();
  }

  /**
   * Get the current L1 state for our rollup
   */
  async getL1State(): Promise<{
    stateRoot: string;
    etherBalance: string;
  }> {
    const rollupData = await this.rollupsContract.rollups(
      this.config.rollupId
    );
    return {
      stateRoot: rollupData.stateRoot,
      etherBalance: "0x" + BigInt(rollupData.etherBalance).toString(16),
    };
  }

  // ============ L1 Reorg Detection & Recovery ============

  /**
   * Record block hashes for a range of L1 blocks.
   * Must record ALL blocks (not just those with events) because an empty block
   * can be reorged into one with events.
   */
  private async recordBlockHashes(fromBlock: number, toBlock: number): Promise<void> {
    for (let blockNum = fromBlock; blockNum <= toBlock; blockNum++) {
      if (!this.blockHashHistory.has(blockNum)) {
        const block = await this.l1Provider.getBlock(blockNum);
        if (block && block.hash) {
          this.blockHashHistory.set(blockNum, block.hash);
        }
      }
    }
    this.pruneBlockHashHistory();
  }

  /**
   * Save a checkpoint before processing events for a specific L1 block.
   * Records the L2 block number and tracked state BEFORE processing,
   * giving us a precise rollback target.
   */
  private async saveCheckpoint(l1BlockNumber: number): Promise<void> {
    const l1BlockHash = this.blockHashHistory.get(l1BlockNumber) || "";
    let l2BlockNumber = 0;
    try {
      l2BlockNumber = await this.stateManager.getL2BlockNumber();
    } catch {
      // L2 provider might not be ready yet during initial sync
    }

    this.checkpoints.push({
      l1BlockNumber,
      l1BlockHash,
      l2BlockNumber,
      trackedStateRoot: this.stateManager.getStateRoot(),
      trackedEtherBalance: this.stateManager.getEtherBalance().toString(),
    });

    // Keep checkpoints bounded to MAX_REORG_HISTORY
    while (this.checkpoints.length > this.MAX_REORG_HISTORY) {
      this.checkpoints.shift();
    }
  }

  /**
   * Prune block hash history to keep only the most recent MAX_REORG_HISTORY entries.
   */
  private pruneBlockHashHistory(): void {
    if (this.blockHashHistory.size <= this.MAX_REORG_HISTORY) return;

    // Find the cutoff: keep only entries within MAX_REORG_HISTORY of the latest
    const sortedKeys = Array.from(this.blockHashHistory.keys()).sort((a, b) => a - b);
    const cutoff = sortedKeys.length - this.MAX_REORG_HISTORY;
    for (let i = 0; i < cutoff; i++) {
      this.blockHashHistory.delete(sortedKeys[i]);
    }
  }

  /**
   * Detect if an L1 reorg has occurred by checking recent block hashes.
   * Returns the first reorged block number, or null if no reorg detected.
   *
   * Efficient: checks only REORG_CHECK_DEPTH recent blocks per poll.
   * Full binary search only when a mismatch is found (rare).
   */
  private async detectReorg(): Promise<number | null> {
    if (this.blockHashHistory.size === 0) return null;

    const checkDepth = Math.min(this.REORG_CHECK_DEPTH, this.blockHashHistory.size);
    const blocksToCheck: number[] = [];

    // Check the most recent blocks
    for (let i = 0; i < checkDepth; i++) {
      const blockNum = this.lastProcessedBlock - i;
      if (this.blockHashHistory.has(blockNum)) {
        blocksToCheck.push(blockNum);
      }
    }

    for (const blockNum of blocksToCheck) {
      try {
        const block = await this.l1Provider.getBlock(blockNum);
        if (!block) {
          // Block no longer exists — deep reorg or chain shrinkage
          console.warn(`[EventProcessor] Block ${blockNum} no longer exists on L1!`);
          return await this.findForkPoint(blockNum);
        }
        const storedHash = this.blockHashHistory.get(blockNum);
        if (block.hash !== storedHash) {
          console.warn(
            `[EventProcessor] Block hash mismatch at block ${blockNum}: ` +
            `stored=${storedHash?.slice(0, 10)}..., actual=${block.hash?.slice(0, 10)}...`
          );
          return await this.findForkPoint(blockNum);
        }
      } catch (e: any) {
        console.warn(`[EventProcessor] Error checking block ${blockNum}: ${e.message}`);
        // Don't treat RPC errors as reorgs — just skip this check
      }
    }

    return null; // No reorg detected
  }

  /**
   * Binary search to find the exact fork point (first reorged block).
   */
  private async findForkPoint(knownBadBlock: number): Promise<number> {
    // Get the oldest block we have history for
    const oldestTracked = Math.min(...Array.from(this.blockHashHistory.keys()));
    let lo = oldestTracked;
    let hi = knownBadBlock;

    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const storedHash = this.blockHashHistory.get(mid);
      if (!storedHash) {
        // No history for this block — assume it's fine
        lo = mid + 1;
        continue;
      }

      try {
        const block = await this.l1Provider.getBlock(mid);
        if (block && block.hash === storedHash) {
          lo = mid + 1; // mid is still canonical
        } else {
          hi = mid; // mid was reorged
        }
      } catch {
        lo = mid + 1; // Can't check, assume fine
      }
    }

    return lo;
  }

  /**
   * Find the latest checkpoint before (or at) the given L1 block.
   * Returns the checkpoint to roll back to, or null if none found.
   */
  private findCheckpointBefore(l1Block: number): L1L2Checkpoint | null {
    // Checkpoints are in chronological order
    let best: L1L2Checkpoint | null = null;
    for (const cp of this.checkpoints) {
      if (cp.l1BlockNumber < l1Block) {
        best = cp;
      }
    }
    return best;
  }

  /**
   * Prune block hash history and checkpoints from a given L1 block onward.
   */
  private pruneFromBlock(l1Block: number): void {
    // Remove block hashes from forkBlock onward
    for (const key of Array.from(this.blockHashHistory.keys())) {
      if (key >= l1Block) {
        this.blockHashHistory.delete(key);
      }
    }

    // Remove checkpoints from forkBlock onward
    this.checkpoints = this.checkpoints.filter(cp => cp.l1BlockNumber < l1Block);
  }

  /**
   * Get reorg data for persistence
   */
  private getReorgData(): {
    blockHashHistory: Array<{ blockNumber: number; blockHash: string }>;
    checkpoints: L1L2Checkpoint[];
  } {
    return {
      blockHashHistory: Array.from(this.blockHashHistory.entries()).map(
        ([blockNumber, blockHash]) => ({ blockNumber, blockHash })
      ),
      checkpoints: this.checkpoints,
    };
  }

  /**
   * Handle an L1 reorg by unwinding reth to a checkpoint and re-processing events.
   *
   * Strategy:
   * 1. Find the checkpoint just before the fork point
   * 2. Stop reth → unwind to checkpoint's L2 block → restart reth
   * 3. Restore tracked state from checkpoint
   * 4. Re-process events from the fork point on the new canonical chain
   *
   * If no checkpoint is found (reorg deeper than history), falls back to
   * full wipe and replay from deployment block.
   */
  private async handleReorg(forkBlock: number): Promise<void> {
    if (this.reorgInProgress) {
      console.warn("[EventProcessor] Reorg already in progress, skipping");
      return;
    }

    this.reorgInProgress = true;
    console.log(`[EventProcessor] ========================================`);
    console.log(`[EventProcessor] REORG DETECTED at L1 block ${forkBlock}`);
    console.log(`[EventProcessor] Current lastProcessedBlock: ${this.lastProcessedBlock}`);
    console.log(`[EventProcessor] ========================================`);

    try {
      const checkpoint = this.findCheckpointBefore(forkBlock);

      if (checkpoint) {
        // Precise unwind using checkpoint
        console.log(
          `[EventProcessor] Found checkpoint: L1 block ${checkpoint.l1BlockNumber} → L2 block ${checkpoint.l2BlockNumber}`
        );
        console.log(
          `[EventProcessor] Will unwind L2 to block ${checkpoint.l2BlockNumber} and re-process from L1 block ${checkpoint.l1BlockNumber}`
        );

        // Step 1: Stop reth
        await this.stateManager.stopEngine();

        // Step 2: Unwind reth to checkpoint's L2 block
        let unwindSucceeded = false;
        try {
          await this.stateManager.unwindToBlock(checkpoint.l2BlockNumber);
          unwindSucceeded = true;
        } catch (err: any) {
          console.error(`[EventProcessor] Unwind failed: ${err.message}`);
        }

        if (unwindSucceeded) {
          // Step 3: Restart reth
          await this.stateManager.startEngine();

          // Step 4: Restore tracked state from checkpoint
          this.stateManager.restoreState(
            checkpoint.trackedStateRoot,
            checkpoint.trackedEtherBalance
          );

          // Step 5: Prune reorg data from the checkpoint's block onward
          this.pruneFromBlock(checkpoint.l1BlockNumber);

          // Step 6: Reset lastProcessedBlock to BEFORE the checkpoint's block
          this.lastProcessedBlock = checkpoint.l1BlockNumber - 1;
        } else {
          // Unwind failed — fall through to full replay from genesis
          console.log(`[EventProcessor] Falling back to full wipe and replay from deployment block`);
          this.stateManager.clearRethData();
          await this.stateManager.startEngine();
          this.stateManager.resetState();
          this.blockHashHistory.clear();
          this.checkpoints = [];
          this.stateManager.clearExecutionCache();
          this.lastProcessedBlock = this.deploymentBlock - 1;
        }

      } else {
        // No checkpoint found — full replay from deployment block
        console.warn(
          `[EventProcessor] No checkpoint found before block ${forkBlock}. Full replay required.`
        );

        // Stop reth, wipe data, restart
        await this.stateManager.stopEngine();
        this.stateManager.clearRethData();
        await this.stateManager.startEngine();

        // Reset everything
        this.stateManager.resetState();
        this.blockHashHistory.clear();
        this.checkpoints = [];
        this.stateManager.clearExecutionCache();
        this.lastProcessedBlock = this.deploymentBlock - 1;
      }

      // Re-process events from the fork point (or deployment block)
      const currentBlock = await this.l1Provider.getBlockNumber();
      if (currentBlock > this.lastProcessedBlock) {
        console.log(
          `[EventProcessor] Re-processing events from block ${this.lastProcessedBlock + 1} to ${currentBlock}`
        );
        const batchSize = 10000;
        let fromBlock = this.lastProcessedBlock + 1;
        while (fromBlock <= currentBlock) {
          const toBlock = Math.min(fromBlock + batchSize - 1, currentBlock);
          await this.fetchAndProcessEvents(fromBlock, toBlock);
          fromBlock = toBlock + 1;
        }
      }

      // Always persist state after reorg recovery (even if no new events were processed)
      this.stateManager.saveSyncState(this.lastProcessedBlock, this.getReorgData());
      console.log(`[EventProcessor] Reorg recovery complete. Now at L1 block ${this.lastProcessedBlock}`);

    } catch (err: any) {
      console.error(`[EventProcessor] Reorg recovery failed: ${err.message}`);
    } finally {
      this.reorgInProgress = false;
    }
  }

  /**
   * Check if fullnode is synced with L1.
   *
   * Checks two things:
   * 1. Has the fullnode processed all L1 events up to the latest block?
   *    (tracked state root matches L1 contract's state root)
   * 2. Does the actual L2 EVM state agree with what L1 claims?
   *    (reth's state root matches the L1 state root)
   *
   * If (1) passes but (2) fails, it means L1 has a fraudulent state root
   * that doesn't match independent local execution — i.e. a malicious builder/prover.
   */
  async isSynced(): Promise<boolean> {
    const l1State = await this.getL1State();
    const trackedState = this.stateManager.getStateRoot();

    // Check 1: Have we processed all L1 events?
    if (l1State.stateRoot !== trackedState) {
      return false;
    }

    // Check 2: Does our actual L2 EVM state match what L1 claims?
    // On non-Anvil L1s (real chains), timestamp mismatches between simulation
    // and actual L1 blocks cause state root divergence. The builder corrects
    // this via setStateByOwner, but fullnodes replaying from scratch may still
    // see mismatches. Log a warning but don't block sync — the tracked state
    // comparison (check 1) is sufficient for sync detection.
    if (!this.lastEventWasStateUpdate) {
      try {
        const actualL2State = await this.stateManager.getActualStateRoot();
        if (actualL2State !== l1State.stateRoot) {
          // Only log once per state to avoid spam
          if (this.lastFraudWarningState !== l1State.stateRoot) {
            console.warn(
              `[EventProcessor] EVM state mismatch (expected on non-Anvil L1s): ` +
              `L1 ${l1State.stateRoot.slice(0, 10)}... vs EVM ${actualL2State.slice(0, 10)}...`
            );
            this.lastFraudWarningState = l1State.stateRoot;
          }
        }
      } catch (e: any) {
        console.warn(`[EventProcessor] Could not verify L2 EVM state: ${e.message}`);
      }
    }

    return true;
  }

  /**
   * Check the bridge invariant after each execution:
   *   L1 rollup.etherBalance + operator L2 balance == operator genesis balance
   *
   * Every ETH bridged from L1 to L2 is disbursed by the operator on L2.
   * The sum must always equal the operator's genesis allocation.
   */
  private async checkBridgeInvariant(): Promise<void> {
    try {
      const l1State = await this.getL1State();
      const l1EtherBalance = BigInt(l1State.etherBalance);
      const result = await this.stateManager.checkBridgeInvariant(l1EtherBalance);
      if (!result.holds) {
        console.error(
          `[EventProcessor] BRIDGE INVARIANT VIOLATED! ` +
          `L1 etherBalance (${result.l1EtherBalance}) + ` +
          `operator L2 balance (${result.operatorL2Balance}) = ` +
          `${result.l1EtherBalance + result.operatorL2Balance} != ` +
          `genesis balance (${result.genesisBalance})`
        );
      }
    } catch (e: any) {
      // Don't fail event processing if invariant check fails
      console.warn(`[EventProcessor] Could not check bridge invariant: ${e.message}`);
    }
  }
}
