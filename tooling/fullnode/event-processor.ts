/**
 * Event Processor for sync-rollups fullnode
 * Watches L1 for Rollups contract events and processes them
 */

import { Contract, JsonRpcProvider, Interface, EventLog, Log, Transaction } from "ethers";
import { StateManager } from "./state-manager.js";
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

  constructor(config: EventProcessorConfig, stateManager: StateManager) {
    this.config = config;
    this.stateManager = stateManager;
    this.lastProcessedBlock = config.startBlock - 1;
    this.pollingInterval = config.pollingInterval || 2000;

    this.l1Provider = new JsonRpcProvider(config.l1RpcUrl);
    this.rollupsInterface = new Interface(ROLLUPS_ABI);
    this.rollupsContract = new Contract(
      config.rollupsAddress,
      ROLLUPS_ABI,
      this.l1Provider
    );
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

    // Process each event
    for (const event of allEvents) {
      await this.processEvent(event);
    }

    this.lastProcessedBlock = toBlock;
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

    try {
      // Get the L1 transaction that triggered this execution
      const l1Tx = await this.l1Provider.getTransaction(l1TxHash);
      if (!l1Tx) {
        throw new Error(`L1 transaction ${l1TxHash} not found`);
      }

      // Try to decode as a Rollups contract call
      const decoded = this.rollupsInterface.parseTransaction({ data: l1Tx.data });

      if (decoded && decoded.name === 'executeL2TX') {
        // This is a direct L2TX execution
        const rlpEncodedTx = decoded.args[1]; // Second arg is rlpEncodedTx
        console.log(`[EventProcessor] Decoded executeL2TX, sending to L2 EVM...`);

        // Send the raw L2 transaction to local Anvil
        const txHash = await this.stateManager.sendRawTransaction(rlpEncodedTx);
        console.log(`[EventProcessor] L2 tx sent: ${txHash}`);

        // Mine a block to include the transaction
        await this.stateManager.mineBlock();
        console.log(`[EventProcessor] L2 block mined`);
      } else {
        // This is likely an L2Proxy fallback call (L1→L2)
        // The L1 tx target should be the proxy address
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

        // Execute the call on local Anvil from the derived source proxy
        const provider = this.stateManager.getL2Provider();

        // Impersonate source proxy on L2
        await provider.send("anvil_impersonateAccount", [sourceProxy]);

        // Set sufficient balance for source proxy on L2 to cover value + gas
        const value = l1Tx.value;
        const balanceNeeded = value + 10n ** 18n; // Add 1 ETH buffer for gas
        await provider.send("anvil_setBalance", [sourceProxy, "0x" + balanceNeeded.toString(16)]);

        // Execute the transaction
        const l2TxParams: any = {
          from: sourceProxy,
          to: l2Target,
          value: "0x" + value.toString(16),
          data: l1Tx.data,
        };

        const txHash = await provider.send("eth_sendTransaction", [l2TxParams]);
        console.log(`[EventProcessor] L2 tx sent: ${txHash}`);

        // Stop impersonating
        await provider.send("anvil_stopImpersonatingAccount", [sourceProxy]);

        // Reset proxy balance to 0 — the 1 ETH gas buffer was only needed for execution
        await provider.send("anvil_setBalance", [sourceProxy, "0x0"]);

        // Mine a block
        await this.stateManager.mineBlock();
        console.log(`[EventProcessor] L2 block mined`);
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
        const currentBlock = await this.l1Provider.getBlockNumber();
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

  /**
   * Check if fullnode is synced with L1
   */
  async isSynced(): Promise<boolean> {
    const l1State = await this.getL1State();
    const trackedState = this.stateManager.getStateRoot();
    const actualState = await this.stateManager.getActualStateRoot();
    return l1State.stateRoot === trackedState && trackedState === actualState;
  }
}
