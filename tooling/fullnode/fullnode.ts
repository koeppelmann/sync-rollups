#!/usr/bin/env node
/**
 * Main Fullnode for sync-rollups
 * Orchestrates StateManager, EventProcessor, and RpcServer
 */

import { StateManager, StateManagerConfig } from "./state-manager.js";
import { EventProcessor, EventProcessorConfig } from "./event-processor.js";
import { RpcServer, RpcServerConfig } from "./rpc-server.js";

export interface FullnodeConfig {
  // L1 connection
  l1RpcUrl: string;
  rollupsAddress: string;
  rollupId: bigint;
  startBlock: number;

  // L2 EVM
  l2ChainId: number;
  l2EvmPort: number;

  // RPC server
  rpcPort: number;

  // Initial state (for genesis)
  initialStateRoot: string;

  // Polling interval for L1 events (ms)
  pollingInterval?: number;

  // L2 genesis alloc — contract addresses to mirror on L2
  l2ProxyImplAddress?: string; // L1 L2Proxy implementation address
  contractsOutDir?: string;    // Path to sync-rollups/out/ for compiled bytecode

  // Data directory for persistent state
  dataDir?: string;
}

export class Fullnode {
  private config: FullnodeConfig;
  private stateManager: StateManager;
  private eventProcessor: EventProcessor;
  private rpcServer: RpcServer;
  private running = false;

  constructor(config: FullnodeConfig) {
    this.config = config;

    // Initialize StateManager
    const stateConfig: StateManagerConfig = {
      rollupId: config.rollupId,
      initialStateRoot: config.initialStateRoot,
      l2ChainId: config.l2ChainId,
      l2EvmPort: config.l2EvmPort,
      dataDir: config.dataDir,
      rollupsAddress: config.rollupsAddress,
      l2ProxyImplAddress: config.l2ProxyImplAddress,
      contractsOutDir: config.contractsOutDir,
    };
    this.stateManager = new StateManager(stateConfig);

    // Initialize EventProcessor
    const eventConfig: EventProcessorConfig = {
      l1RpcUrl: config.l1RpcUrl,
      rollupsAddress: config.rollupsAddress,
      rollupId: config.rollupId,
      startBlock: config.startBlock,
      pollingInterval: config.pollingInterval,
    };
    this.eventProcessor = new EventProcessor(eventConfig, this.stateManager);

    // Initialize RpcServer
    const rpcConfig: RpcServerConfig = {
      port: config.rpcPort,
    };
    this.rpcServer = new RpcServer(
      rpcConfig,
      this.stateManager,
      this.eventProcessor
    );
  }

  /**
   * Start the fullnode
   */
  async start(): Promise<void> {
    console.log("=== sync-rollups Fullnode ===");
    console.log(`Rollups contract: ${this.config.rollupsAddress}`);
    console.log(`Rollup ID: ${this.config.rollupId}`);
    console.log(`L1 RPC: ${this.config.l1RpcUrl}`);
    console.log(`L2 Chain ID: ${this.config.l2ChainId}`);
    console.log(`Start block: ${this.config.startBlock}`);
    console.log("");

    // Check for persisted sync state (resume without full replay)
    const syncState = this.stateManager.loadSyncState();
    if (syncState) {
      console.log(`[Fullnode] Found persisted state: block ${syncState.lastProcessedL1Block}, root ${syncState.stateRoot.slice(0, 10)}...`);
      const hashCount = syncState.blockHashHistory?.length || 0;
      const cpCount = syncState.checkpoints?.length || 0;
      console.log(`[Fullnode] Resuming from block ${syncState.lastProcessedL1Block + 1} (${hashCount} block hashes, ${cpCount} checkpoints)`);
      // Restore full state including reorg data (block hashes, checkpoints)
      this.eventProcessor.setResumeState(syncState);
    }

    // Start reth for L2 EVM
    console.log("[Fullnode] Starting L2 EVM (reth)...");
    await this.stateManager.startEngine();

    // Start event processor (replays historical events or resumes)
    console.log("[Fullnode] Starting event processor...");
    await this.eventProcessor.start();

    // Start RPC server
    console.log("[Fullnode] Starting RPC server...");
    await this.rpcServer.start();

    // Check sync status
    const synced = await this.eventProcessor.isSynced();
    if (synced) {
      console.log("[Fullnode] Synced with L1!");
    } else {
      console.warn("[Fullnode] WARNING: Not synced with L1");
    }

    console.log("");
    console.log(`[Fullnode] RPC available at http://localhost:${this.config.rpcPort}`);
    console.log("[Fullnode] Ready");

    this.running = true;
  }

  /**
   * Stop the fullnode
   */
  async stop(): Promise<void> {
    console.log("[Fullnode] Stopping...");

    this.eventProcessor.stop();
    await this.rpcServer.stop();
    await this.stateManager.stopEngine();

    this.running = false;
    console.log("[Fullnode] Stopped");
  }

  /**
   * Check if fullnode is running
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get current state root
   */
  getStateRoot(): string {
    return this.stateManager.getStateRoot();
  }

  /**
   * Check if synced with L1
   */
  async isSynced(): Promise<boolean> {
    return this.eventProcessor.isSynced();
  }
}

// CLI entry point
async function main() {
  // Parse command line arguments
  const args = process.argv.slice(2);
  const getArg = (name: string, defaultValue?: string): string => {
    const index = args.indexOf(`--${name}`);
    if (index !== -1 && args[index + 1]) {
      return args[index + 1];
    }
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    throw new Error(`Missing required argument: --${name}`);
  };

  const config: FullnodeConfig = {
    l1RpcUrl: getArg("l1-rpc", "http://localhost:8545"),
    rollupsAddress: getArg("rollups"),
    rollupId: BigInt(getArg("rollup-id", "0")),
    startBlock: parseInt(getArg("start-block", "0")),
    l2ChainId: parseInt(getArg("l2-chain-id", "10200200")),
    l2EvmPort: parseInt(getArg("l2-port", "9546")),
    rpcPort: parseInt(getArg("rpc-port", "9547")),
    initialStateRoot: getArg(
      "initial-state",
      "0x0000000000000000000000000000000000000000000000000000000000000000"
    ),
    pollingInterval: parseInt(getArg("poll-interval", "2000")),
    l2ProxyImplAddress: args.indexOf("--l2-proxy-impl") !== -1 ? getArg("l2-proxy-impl") : undefined,
    contractsOutDir: args.indexOf("--contracts-out") !== -1 ? getArg("contracts-out") : undefined,
    dataDir: args.indexOf("--data-dir") !== -1 ? getArg("data-dir") : undefined,
  };

  const fullnode = new Fullnode(config);

  // Handle shutdown
  const shutdown = async () => {
    console.log("\nShutdown signal received");
    await fullnode.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    await fullnode.start();
  } catch (error) {
    console.error("Failed to start fullnode:", error);
    process.exit(1);
  }
}

// Run if executed directly
const isMainModule = process.argv[1]?.endsWith("fullnode.ts") ||
                     process.argv[1]?.endsWith("fullnode.js");
if (isMainModule) {
  main().catch(console.error);
}
