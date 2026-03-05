/**
 * State Manager for sync-rollups fullnode
 * Tracks rollup state and manages loaded executions cache
 */

import { ChildProcess, spawn } from "child_process";
import { JsonRpcProvider } from "ethers";
import {
  RollupState,
  Execution,
  StateDelta,
  Action,
  ActionType,
} from "./types.js";

export interface StateManagerConfig {
  rollupId: bigint;
  initialStateRoot: string;
  l2ChainId: number;
  l2EvmPort: number;
}

export class StateManager {
  private config: StateManagerConfig;
  private state: RollupState;

  // Cache of loaded executions: actionHash -> Execution[]
  private executionCache: Map<string, Execution[]> = new Map();

  // Anvil process and provider
  private anvilProcess: ChildProcess | null = null;
  private l2Provider: JsonRpcProvider | null = null;

  constructor(config: StateManagerConfig) {
    this.config = config;
    this.state = {
      rollupId: config.rollupId,
      stateRoot: config.initialStateRoot,
      etherBalance: 0n,
      blockNumber: 0n,
    };
  }

  /**
   * Start the Anvil L2 EVM instance
   */
  async startAnvil(): Promise<void> {
    const { l2ChainId, l2EvmPort } = this.config;

    console.log(
      `[StateManager] Starting Anvil on port ${l2EvmPort} with chain ID ${l2ChainId}`
    );

    this.anvilProcess = spawn(
      "anvil",
      [
        "--port",
        l2EvmPort.toString(),
        "--chain-id",
        l2ChainId.toString(),
        "--no-mining", // Mine only when the fullnode explicitly calls evm_mine
        "--base-fee",
        "0", // Keep fee market deterministic across public/private replay nodes
        "--disable-min-priority-fee",
        "--balance",
        "0", // Start with zero balances - funds must come from L1 bridging
      ],
      {
        stdio: ["ignore", "ignore", "ignore"],
        detached: true,
      }
    );

    // Allow the process to run independently
    this.anvilProcess.unref();

    // Wait for Anvil to be ready
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Anvil startup timeout"));
      }, 10000);

      const checkReady = async () => {
        try {
          // Use fetch directly to avoid ethers auto-retry behavior
          const response = await fetch(`http://localhost:${l2EvmPort}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              method: 'eth_blockNumber',
              params: [],
              id: 1,
            }),
          });
          if (response.ok) {
            clearTimeout(timeout);
            // Now create the provider
            this.l2Provider = new JsonRpcProvider(
              `http://localhost:${l2EvmPort}`
            );
            resolve();
          } else {
            setTimeout(checkReady, 100);
          }
        } catch {
          setTimeout(checkReady, 100);
        }
      };

      checkReady();
    });

    console.log(`[StateManager] Anvil started on port ${l2EvmPort}`);
  }

  /**
   * Stop the Anvil process
   */
  async stopAnvil(): Promise<void> {
    if (this.anvilProcess) {
      this.anvilProcess.kill();
      this.anvilProcess = null;
      this.l2Provider = null;
      console.log("[StateManager] Anvil stopped");
    }
  }

  /**
   * Get the L2 provider
   */
  getL2Provider(): JsonRpcProvider {
    if (!this.l2Provider) {
      throw new Error("L2 provider not initialized - call startAnvil first");
    }
    return this.l2Provider;
  }

  /**
   * Get current rollup state
   */
  getState(): RollupState {
    return { ...this.state };
  }

  /**
   * Get current state root
   */
  getStateRoot(): string {
    return this.state.stateRoot;
  }

  /**
   * Get ether balance
   */
  getEtherBalance(): bigint {
    return this.state.etherBalance;
  }

  /**
   * Get rollup ID
   */
  getRollupId(): bigint {
    return this.config.rollupId;
  }

  /**
   * Update state from L1 event
   */
  updateState(newStateRoot: string, blockNumber: bigint): void {
    console.log(
      `[StateManager] State updated: ${this.state.stateRoot.slice(0, 10)}... -> ${newStateRoot.slice(0, 10)}... at block ${blockNumber}`
    );
    this.state.stateRoot = newStateRoot;
    this.state.blockNumber = blockNumber;
  }

  /**
   * Update ether balance
   */
  updateEtherBalance(delta: bigint): void {
    const newBalance = this.state.etherBalance + delta;
    if (newBalance < 0n) {
      throw new Error("Ether balance would be negative");
    }
    this.state.etherBalance = newBalance;
  }

  /**
   * Cache executions for later lookup
   * Called when builder notifies us of loaded executions
   */
  cacheExecutions(executions: Execution[]): void {
    for (const exec of executions) {
      const existing = this.executionCache.get(exec.actionHash) || [];
      existing.push(exec);
      this.executionCache.set(exec.actionHash, existing);
    }
    console.log(
      `[StateManager] Cached ${executions.length} execution(s), total: ${this.executionCache.size} action hashes`
    );
  }

  /**
   * Find and remove a matching execution from cache
   * Returns the execution if found, null otherwise
   */
  findAndConsumeExecution(
    actionHash: string,
    currentState: string
  ): Execution | null {
    const executions = this.executionCache.get(actionHash);
    if (!executions || executions.length === 0) {
      return null;
    }

    // Find execution where all state deltas match current state
    for (let i = 0; i < executions.length; i++) {
      const exec = executions[i];
      let allMatch = true;

      for (const delta of exec.stateDeltas) {
        // For single-rollup mode, check if this delta is for our rollup
        if (delta.rollupId === this.config.rollupId) {
          if (delta.currentState !== currentState) {
            allMatch = false;
            break;
          }
        }
      }

      if (allMatch) {
        // Remove from cache (consumed)
        executions.splice(i, 1);
        if (executions.length === 0) {
          this.executionCache.delete(actionHash);
        }
        return exec;
      }
    }

    return null;
  }

  /**
   * Get cached executions for an action hash (without consuming)
   */
  getExecutions(actionHash: string): Execution[] {
    return this.executionCache.get(actionHash) || [];
  }

  /**
   * Clear all cached executions
   */
  clearExecutionCache(): void {
    this.executionCache.clear();
    console.log("[StateManager] Execution cache cleared");
  }

  /**
   * Get the actual state root from the L2 EVM
   */
  async getActualStateRoot(): Promise<string> {
    if (!this.l2Provider) {
      throw new Error("L2 provider not initialized");
    }

    // Get the latest block and return its state root
    const block = await this.l2Provider.send("eth_getBlockByNumber", [
      "latest",
      false,
    ]);
    return block.stateRoot;
  }

  /**
   * Verify that tracked state matches actual L2 EVM state
   */
  async verifyStateSync(): Promise<boolean> {
    const actualRoot = await this.getActualStateRoot();
    const matches = actualRoot === this.state.stateRoot;
    if (!matches) {
      console.warn(
        `[StateManager] State mismatch! Tracked: ${this.state.stateRoot}, Actual: ${actualRoot}`
      );
    }
    return matches;
  }

  /**
   * Take a snapshot of the L2 EVM state
   */
  async takeSnapshot(): Promise<string> {
    if (!this.l2Provider) {
      throw new Error("L2 provider not initialized");
    }
    const snapshotId = await this.l2Provider.send("evm_snapshot", []);
    return snapshotId;
  }

  /**
   * Revert to a previous snapshot
   */
  async revertToSnapshot(snapshotId: string): Promise<void> {
    if (!this.l2Provider) {
      throw new Error("L2 provider not initialized");
    }
    await this.l2Provider.send("evm_revert", [snapshotId]);
  }

  /**
   * Mine a block on the L2 EVM
   */
  async mineBlock(timestamp?: number): Promise<void> {
    if (!this.l2Provider) {
      throw new Error("L2 provider not initialized");
    }

    if (timestamp !== undefined) {
      await this.l2Provider.send("evm_setNextBlockTimestamp", [timestamp]);
    }
    await this.l2Provider.send("evm_mine", []);
  }

  /**
   * Send a raw transaction to the L2 EVM
   */
  async sendRawTransaction(rawTx: string): Promise<string> {
    if (!this.l2Provider) {
      throw new Error("L2 provider not initialized");
    }
    return await this.l2Provider.send("eth_sendRawTransaction", [rawTx]);
  }

  /**
   * Get transaction receipt
   */
  async getTransactionReceipt(txHash: string): Promise<any> {
    if (!this.l2Provider) {
      throw new Error("L2 provider not initialized");
    }
    return await this.l2Provider.getTransactionReceipt(txHash);
  }
}
