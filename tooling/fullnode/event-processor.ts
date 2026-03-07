/**
 * Event Processor for sync-rollups fullnode
 * Watches L1 for Rollups contract events and processes them
 */

import { Contract, JsonRpcProvider, Interface, EventLog, Log, Transaction, AbiCoder } from "ethers";
import { StateManager, SyncState, L1L2Checkpoint } from "./state-manager.js";
import { ROLLUPS_EVENTS, Execution, ActionType } from "./types.js";

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
  "event L2ProxyCreated(address indexed proxy, address indexed originalAddress, uint256 indexed originalRollupId)",
  "event ExecutionsLoaded(uint256 count)",
  "event L2ExecutionPerformed(uint256 indexed rollupId, bytes32 currentState, bytes32 newState)",
  // Read functions we need
  "function rollups(uint256) view returns (address owner, bytes32 verificationKey, bytes32 stateRoot, uint256 etherBalance)",
  "function computeL2ProxyAddress(address originalAddress, uint256 originalRollupId, uint256 domain) view returns (address)",
  // Functions we need to decode L1 transactions
  "function executeL2TX(uint256 rollupId, bytes calldata rlpEncodedTx) external",
];

// L2Proxy ABI for reading original address
const L2PROXY_ABI = [
  "function originalAddress() external view returns (address)",
  "function originalRollupId() external view returns (uint256)",
];

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

    this.l1Provider = new JsonRpcProvider(config.l1RpcUrl);
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

    // Fetch ExecutionsLoaded events (not indexed by rollupId)
    const loadedFilter = this.rollupsContract.filters.ExecutionsLoaded();
    const loadedEvents = await this.rollupsContract.queryFilter(
      loadedFilter,
      fromBlock,
      toBlock
    );

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
        allEvents.push({
          blockNumber: event.blockNumber,
          logIndex: event.index,
          eventName: "L2ExecutionPerformed",
          transactionHash: event.transactionHash,
          args: {
            rollupId: event.args[0],
            currentState: event.args[1],
            newState: event.args[2],
          },
        });
      }
    }

    for (const event of loadedEvents) {
      if (event instanceof EventLog) {
        allEvents.push({
          blockNumber: event.blockNumber,
          logIndex: event.index,
          eventName: "ExecutionsLoaded",
          transactionHash: event.transactionHash,
          args: {
            count: event.args[0],
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
    let lastCheckpointedBlock = -1;
    for (const event of allEvents) {
      if (event.blockNumber !== lastCheckpointedBlock) {
        lastCheckpointedBlock = event.blockNumber;
        await this.saveCheckpoint(event.blockNumber);
      }
      await this.processEvent(event);
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
        break;

      case "L2ExecutionPerformed":
        console.log(
          `[EventProcessor] L2ExecutionPerformed at block ${blockNumber}: ${args.currentState.slice(0, 10)}... -> ${args.newState.slice(0, 10)}...`
        );
        // Replay the execution on L2 EVM by extracting data from L1 tx
        await this.replayExecution(args.currentState, args.newState, blockNumber, transactionHash);
        break;

      case "ExecutionsLoaded":
        console.log(
          `[EventProcessor] ExecutionsLoaded at block ${blockNumber}: ${args.count} executions`
        );
        // Executions are loaded on L1 - fullnode doesn't need to cache them
        // We will extract execution data from L1 tx when L2ExecutionPerformed is emitted
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
    l1TxHash: string
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

    // Check if the L2 EVM already has the correct post-execution state.
    // This happens when the builder's fullnode pre-executed the call during
    // planL1ToL2CallWithProxy. In that case, skip re-execution.
    try {
      const actualL2State = await this.stateManager.getActualStateRoot();
      if (actualL2State === newState && currentState !== newState) {
        console.log(
          `[EventProcessor] L2 state already matches newState (pre-executed), skipping replay`
        );
        this.stateManager.updateState(newState, BigInt(blockNumber));
        console.log(`[EventProcessor] State updated to: ${newState.slice(0, 10)}...`);
        return;
      }
    } catch (e: any) {
      // If we can't check, proceed with normal replay
      console.warn(`[EventProcessor] Could not check L2 state: ${e.message}`);
    }

    try {
      // Get the L1 transaction that triggered this execution
      const l1Tx = await this.l1Provider.getTransaction(l1TxHash);
      if (!l1Tx) {
        throw new Error(`L1 transaction ${l1TxHash} not found`);
      }

      // Try to decode as a Rollups contract call
      const decoded = this.rollupsInterface.parseTransaction({ data: l1Tx.data });

      if (decoded && decoded.name === 'executeL2TX') {
        // This is a direct L2TX execution — an already-signed L2 transaction.
        // Instead of sending the raw signed tx (which pays gas to reth's random
        // coinbase, causing non-determinism), we decode it and replay via the
        // operator's zero-gas system call.
        const rlpEncodedTx = decoded.args[1];
        const { Transaction } = await import("ethers");
        const parsedTx = Transaction.from(rlpEncodedTx);
        console.log(`[EventProcessor] Decoded executeL2TX: ${parsedTx.from?.slice(0, 10)}... -> ${parsedTx.to ? parsedTx.to.slice(0, 10) + '...' : 'CREATE'}, value=${parsedTx.value}`);

        const txHash = await this.stateManager.replayL2TX(parsedTx);
        console.log(`[EventProcessor] L2TX replayed: ${txHash}`);
      } else {
        // This is an L1→L2 call via L2Proxy (L1 user called proxy on L1)
        // We replay it on L2 using system calls + proxy deployment
        const proxyAddress = l1Tx.to;
        if (!proxyAddress) {
          throw new Error("L1 transaction has no 'to' address");
        }

        console.log(`[EventProcessor] L1→L2 call via proxy ${proxyAddress.slice(0, 10)}...`);

        // Read the proxy's original L2 target address
        const proxyContract = new Contract(proxyAddress, L2PROXY_ABI, this.l1Provider);
        const l2Target = await proxyContract.originalAddress();
        console.log(`[EventProcessor] L2 target: ${l2Target}`);

        // Derive caller-side L2 proxy from the original L1 sender.
        // This is the address that should appear as msg.sender on L2.
        const l1ChainId = l1Tx.chainId ?? (await this.l1Provider.getNetwork()).chainId;
        const sourceProxy = await this.rollupsContract.computeL2ProxyAddress(
          l1Tx.from,
          this.config.rollupId,
          l1ChainId
        );
        console.log(
          `[EventProcessor] L2 source proxy: ${sourceProxy} (from L1 sender ${l1Tx.from})`
        );

        // Step 1: Ensure the source proxy is deployed on L2
        // This deploys an L2Proxy at the same CREATE2 address as on L1
        await this.stateManager.ensureProxyDeployed(
          l1Tx.from,
          this.config.rollupId,
          BigInt(l1ChainId)
        );

        // Step 2: Call sourceProxy.executeOnBehalf(l2Target, calldata) via system call
        // The proxy will forward the call to l2Target, making msg.sender = sourceProxy
        const proxyIface = new Interface([
          "function executeOnBehalf(address destination, bytes calldata data) payable returns (bool, bytes)"
        ]);
        const execCalldata = proxyIface.encodeFunctionData("executeOnBehalf", [
          l2Target,
          l1Tx.data,
        ]);

        const value = l1Tx.value;
        const result = await this.stateManager.systemCall(
          sourceProxy,
          execCalldata,
          "0x" + value.toString(16)
        );
        console.log(`[EventProcessor] System call executed, result: ${result.slice(0, 20)}...`);
      }

      // Verify the state matches what L1 expects
      const actualState = await this.stateManager.getActualStateRoot();
      if (actualState !== newState) {
        console.warn(
          `[EventProcessor] State mismatch after replay! Expected: ${newState.slice(0, 10)}..., Got: ${actualState.slice(0, 10)}...`
        );
        // Still update tracked state to stay in sync with L1
      }

      // Update tracked state
      this.stateManager.updateState(newState, BigInt(blockNumber));
      console.log(`[EventProcessor] State updated to: ${newState.slice(0, 10)}...`);

    } catch (error: any) {
      console.error(`[EventProcessor] Failed to replay execution: ${error.message}`);
      // Update tracked state anyway to stay in sync with L1
      this.stateManager.updateState(newState, BigInt(blockNumber));
    }
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
        try {
          await this.stateManager.unwindToBlock(checkpoint.l2BlockNumber);
        } catch (err: any) {
          console.error(`[EventProcessor] Unwind failed: ${err.message}`);
          console.log(`[EventProcessor] Falling back to full wipe and replay`);
          this.stateManager.clearRethData();
        }

        // Step 3: Restart reth
        await this.stateManager.startEngine();

        // Step 4: Restore tracked state from checkpoint
        this.stateManager.restoreState(
          checkpoint.trackedStateRoot,
          checkpoint.trackedEtherBalance
        );

        // Step 5: Prune reorg data from the checkpoint's block onward
        // (the checkpoint itself recorded state BEFORE that block, so prune from there)
        this.pruneFromBlock(checkpoint.l1BlockNumber);

        // Step 6: Reset lastProcessedBlock to BEFORE the checkpoint's block
        // Because the checkpoint records state BEFORE processing that block,
        // we need to re-process from checkpoint.l1BlockNumber onward
        this.lastProcessedBlock = checkpoint.l1BlockNumber - 1;

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
    try {
      const actualL2State = await this.stateManager.getActualStateRoot();
      if (actualL2State !== l1State.stateRoot) {
        console.warn(
          `[EventProcessor] FRAUD DETECTED: L1 state ${l1State.stateRoot.slice(0, 10)}... ` +
          `does not match actual L2 EVM state ${actualL2State.slice(0, 10)}...`
        );
        return false;
      }
    } catch (e: any) {
      console.warn(`[EventProcessor] Could not verify L2 EVM state: ${e.message}`);
    }

    return true;
  }
}
