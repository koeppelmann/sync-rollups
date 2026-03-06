/**
 * State Manager for sync-rollups fullnode
 * Tracks rollup state and manages loaded executions cache
 * Uses reth as the L2 execution engine
 */

import { ChildProcess, spawn, execSync } from "child_process";
import { JsonRpcProvider, Wallet, Interface, solidityPackedKeccak256 } from "ethers";
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
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
  dataDir?: string; // Persistent data directory for reth state
  // L1 contract addresses needed for L2 genesis alloc
  rollupsAddress?: string; // L1 Rollups contract address (L2Authority deployed here on L2)
  l2ProxyImplAddress?: string; // L1 L2Proxy implementation address (mirrored on L2)
  // Path to compiled contract artifacts
  contractsOutDir?: string; // Path to sync-rollups/out/ directory
}

/// Large initial balance for the operator account (10^30 wei ≈ 10^12 ETH)
/// The operator needs ETH to bridge value in L1→L2 calls.
/// Since this is a local-only L2 with no external access, a large pre-fund is safe.
const OPERATOR_INITIAL_BALANCE = "0xc9f2c9cd04674edea40000000"; // 10^30

export interface L1L2Checkpoint {
  l1BlockNumber: number;
  l1BlockHash: string;
  l2BlockNumber: number;      // L2 block number BEFORE processing this L1 block's events
  trackedStateRoot: string;   // Tracked state BEFORE processing
  trackedEtherBalance: string;
}

export interface SyncState {
  lastProcessedL1Block: number;
  stateRoot: string;
  etherBalance: string;
  // Block hash history for L1 reorg detection
  blockHashHistory?: Array<{ blockNumber: number; blockHash: string }>;
  // L1→L2 checkpoints for precise state rollback
  checkpoints?: L1L2Checkpoint[];
}

export class StateManager {
  private config: StateManagerConfig;
  private state: RollupState;

  // Cache of loaded executions: actionHash -> Execution[]
  private executionCache: Map<string, Execution[]> = new Map();

  // reth process and provider
  private engineProcess: ChildProcess | null = null;
  private l2Provider: JsonRpcProvider | null = null;

  // Operator wallet — used to sign system call transactions on the local L2.
  // This is a randomly generated key (NOT a well-known dev account), stored in the
  // data directory. Only this fullnode process knows the key, preventing interference.
  // Since L2Authority has no access control, any address can perform protocol operations.
  private operatorWallet: Wallet | null = null;

  // Cached genesis path for reuse in unwindToBlock
  private genesisPath: string | null = null;

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
   * Derive the operator private key deterministically from public parameters.
   *
   * The key is computed as keccak256("sync-rollups-operator" || rollupsAddress || rollupId || chainId).
   * Every fullnode with the same config independently derives the same key, producing
   * identical genesis alloc and state root — no key sharing or storage needed.
   *
   * The key is purely a local implementation detail: reth requires signed transactions,
   * so we need SOME private key. Since L2Authority has no access control, the specific
   * address doesn't matter — only that all fullnodes agree on the same genesis state.
   */
  private deriveOperatorKey(): string {
    const rollupsAddress = this.config.rollupsAddress || "0x0000000000000000000000000000000000000000";
    const privateKey = solidityPackedKeccak256(
      ["string", "address", "uint256", "uint256"],
      ["sync-rollups-operator", rollupsAddress, this.config.rollupId, this.config.l2ChainId]
    );
    const wallet = new Wallet(privateKey);
    console.log(`[StateManager] Operator address: ${wallet.address} (derived from config)`);
    return privateKey;
  }

  /**
   * Get the data directory for this instance
   */
  getDataDir(): string {
    if (this.config.dataDir) {
      return this.config.dataDir;
    }
    return join(process.cwd(), "state", `l2-${this.config.l2EvmPort}`);
  }

  /**
   * Load compiled contract bytecode from Forge artifacts
   */
  private loadContractBytecode(contractName: string, fileName: string): string | null {
    const outDir = this.config.contractsOutDir;
    if (!outDir) return null;

    const artifactPath = join(outDir, fileName, `${contractName}.json`);
    if (!existsSync(artifactPath)) {
      console.warn(`[StateManager] Contract artifact not found: ${artifactPath}`);
      return null;
    }

    try {
      const artifact = JSON.parse(readFileSync(artifactPath, "utf-8"));
      // Forge artifacts have deployedBytecode.object for runtime bytecode
      return artifact.deployedBytecode?.object || null;
    } catch (e: any) {
      console.warn(`[StateManager] Failed to load artifact ${artifactPath}: ${e.message}`);
      return null;
    }
  }

  /**
   * Generate a custom genesis JSON for reth
   * Includes L2Authority, L2Proxy contracts, and operator funding in alloc
   */
  private generateGenesis(): string {
    const { l2ChainId } = this.config;
    const dataDir = this.getDataDir();
    mkdirSync(dataDir, { recursive: true });

    const genesisPath = join(dataDir, "genesis.json");

    // Build alloc — include system contracts and operator funding
    const alloc: Record<string, any> = {};

    // Fund the operator account so it can send transactions (including bridging ETH)
    if (this.operatorWallet) {
      alloc[this.operatorWallet.address.toLowerCase()] = {
        balance: OPERATOR_INITIAL_BALANCE,
      };
      console.log(`[StateManager] Genesis: Operator funded at ${this.operatorWallet.address}`);
    }

    // Deploy L2Authority at the L1 Rollups contract address on L2
    if (this.config.rollupsAddress && this.config.contractsOutDir) {
      const l2AuthBytecode = this.loadContractBytecode("L2Authority", "L2Authority.sol");
      if (l2AuthBytecode) {
        // Storage layout: slot 0 = l2ProxyImplementation address
        const storage: Record<string, string> = {};
        if (this.config.l2ProxyImplAddress) {
          // slot 0: l2ProxyImplementation
          storage["0x0000000000000000000000000000000000000000000000000000000000000000"] =
            "0x000000000000000000000000" + this.config.l2ProxyImplAddress.slice(2).toLowerCase();
        }

        alloc[this.config.rollupsAddress.toLowerCase()] = {
          code: l2AuthBytecode,
          storage,
          balance: "0x0",
        };
        console.log(`[StateManager] Genesis: L2Authority at ${this.config.rollupsAddress}`);
      }
    }

    // Deploy L2Proxy implementation at the same address as on L1
    if (this.config.l2ProxyImplAddress && this.config.contractsOutDir) {
      const l2ProxyBytecode = this.loadContractBytecode("L2Proxy", "L2Proxy.sol");
      if (l2ProxyBytecode) {
        alloc[this.config.l2ProxyImplAddress.toLowerCase()] = {
          code: l2ProxyBytecode,
          balance: "0x0",
        };
        console.log(`[StateManager] Genesis: L2Proxy impl at ${this.config.l2ProxyImplAddress}`);
      }
    }

    const genesis = {
      config: {
        chainId: l2ChainId,
        homesteadBlock: 0,
        eip150Block: 0,
        eip155Block: 0,
        eip158Block: 0,
        byzantiumBlock: 0,
        constantinopleBlock: 0,
        petersburgBlock: 0,
        istanbulBlock: 0,
        berlinBlock: 0,
        londonBlock: 0,
        shanghaiTime: 0,
        cancunTime: 0,
        terminalTotalDifficulty: 0,
        terminalTotalDifficultyPassed: true,
      },
      nonce: "0x0",
      timestamp: "0x0",
      extraData: "0x",
      gasLimit: "0x1c9c380",
      difficulty: "0x0",
      mixHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
      coinbase: "0x0000000000000000000000000000000000000000",
      baseFeePerGas: "0x0",
      number: "0x0",
      gasUsed: "0x0",
      parentHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
      alloc,
    };

    writeFileSync(genesisPath, JSON.stringify(genesis, null, 2));
    return genesisPath;
  }

  /**
   * Start the reth L2 EVM instance
   */
  async startEngine(): Promise<void> {
    const { l2EvmPort } = this.config;
    const dataDir = this.getDataDir();

    // Derive operator key deterministically from public config (so all fullnodes agree)
    const operatorKey = this.deriveOperatorKey();
    // Wallet will be connected to provider after reth starts
    this.operatorWallet = new Wallet(operatorKey);

    this.genesisPath = this.generateGenesis();

    console.log(
      `[StateManager] Starting reth on port ${l2EvmPort} with chain config ${this.genesisPath}`
    );

    // Use standard reth binary (or custom one if SYNC_ROLLUPS_RETH is set)
    const rethBinary = process.env.SYNC_ROLLUPS_RETH || "reth";

    // Derive unique ports from the HTTP port so multiple reth instances don't conflict
    const portOffset = l2EvmPort - 9546;
    const p2pPort = 30303 + portOffset;
    const authRpcPort = 8551 + portOffset;

    this.engineProcess = spawn(
      rethBinary,
      [
        "node",
        "--dev",                        // Auto-mine on each transaction (no empty blocks)
        "--http",
        "--http.port", l2EvmPort.toString(),
        "--http.api", "eth,net,debug,trace,txpool,web3,rpc,reth,miner",
        "--chain", this.genesisPath!,
        "--datadir", join(dataDir, "reth"),
        "--log.stdout.filter", "error",
        "--disable-discovery",                  // No P2P discovery needed for local dev L2
        "--port", p2pPort.toString(),           // Unique P2P port per instance
        "--authrpc.port", authRpcPort.toString(), // Unique auth RPC port per instance
        "--txpool.minimal-protocol-fee", "0",   // Allow 0-gas txs for deterministic state
        "--txpool.minimum-priority-fee", "0",   // No minimum tip required
      ],
      {
        stdio: ["ignore", "ignore", "pipe"],
        detached: true,
      }
    );

    // Log reth stderr for debugging
    this.engineProcess.stderr?.on("data", (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) {
        console.error(`[reth] ${msg}`);
      }
    });

    // Allow the process to run independently
    this.engineProcess.unref();

    // Wait for reth to be ready (may take longer than Anvil)
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("reth startup timeout (30s)"));
      }, 30000);

      const checkReady = async () => {
        try {
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
            this.l2Provider = new JsonRpcProvider(
              `http://localhost:${l2EvmPort}`
            );
            // Connect operator wallet to the provider for signing transactions
            if (this.operatorWallet) {
              this.operatorWallet = this.operatorWallet.connect(this.l2Provider);
            }
            resolve();
          } else {
            setTimeout(checkReady, 200);
          }
        } catch {
          setTimeout(checkReady, 200);
        }
      };

      checkReady();
    });

    console.log(`[StateManager] reth started on port ${l2EvmPort}`);
  }

  /**
   * Stop the reth process and wait for it to fully exit.
   * This is important for reorg handling: `reth stage unwind` requires
   * exclusive access to the database (storage lock).
   */
  async stopEngine(): Promise<void> {
    if (this.engineProcess) {
      const proc = this.engineProcess;
      this.engineProcess = null;
      this.l2Provider = null;

      // Wait for the process to actually exit
      await new Promise<void>((resolve) => {
        proc.on("exit", () => resolve());
        proc.kill("SIGTERM");
        // Force kill after 5 seconds if SIGTERM didn't work
        setTimeout(() => {
          try { proc.kill("SIGKILL"); } catch {}
          resolve();
        }, 5000);
      });

      // Small delay to ensure the storage lock is fully released
      await new Promise(r => setTimeout(r, 500));
      console.log("[StateManager] reth stopped");
    }
  }

  /**
   * Unwind the reth database to a specific L2 block number.
   * Uses `reth stage unwind to-block <N>` which precisely reverses only the
   * affected blocks while preserving genesis state and all earlier blocks.
   *
   * IMPORTANT: reth must be stopped before calling this (storage lock).
   *
   * @param l2BlockNumber The target block number (blocks after this are removed)
   */
  async unwindToBlock(l2BlockNumber: number): Promise<void> {
    const dataDir = this.getDataDir();
    const rethDataDir = join(dataDir, "reth");
    const genesisPath = this.genesisPath || join(dataDir, "genesis.json");
    const rethBinary = this.getRethBinary();

    console.log(`[StateManager] Unwinding reth to L2 block ${l2BlockNumber}...`);

    try {
      const result = execSync(
        `"${rethBinary}" stage unwind --datadir "${rethDataDir}" --chain "${genesisPath}" to-block ${l2BlockNumber}`,
        {
          timeout: 60000, // 60s timeout
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
        }
      );
      console.log(`[StateManager] Unwind complete: ${result.trim()}`);
    } catch (err: any) {
      const stderr = err.stderr || "";
      const stdout = err.stdout || "";
      console.error(`[StateManager] Unwind failed: ${stderr || stdout || err.message}`);
      throw new Error(`reth stage unwind failed: ${stderr || err.message}`);
    }
  }

  /**
   * Restore in-memory tracked state from checkpoint values.
   * Used during reorg recovery to roll back tracked state.
   */
  restoreState(stateRoot: string, etherBalance: string): void {
    console.log(
      `[StateManager] Restoring state: ${this.state.stateRoot.slice(0, 10)}... -> ${stateRoot.slice(0, 10)}...`
    );
    this.state.stateRoot = stateRoot;
    this.state.etherBalance = BigInt(etherBalance);
  }

  /**
   * Reset in-memory state to initial genesis values.
   * Used as a last resort when no checkpoint is available for reorg recovery.
   */
  resetState(): void {
    this.state.stateRoot = this.config.initialStateRoot;
    this.state.etherBalance = 0n;
    this.state.blockNumber = 0n;
    console.log(`[StateManager] State reset to initial`);
  }

  /**
   * Clear the reth data directory entirely (nuclear option).
   * Only used when unwindToBlock fails or when no checkpoint exists.
   */
  clearRethData(): void {
    const rethDir = join(this.getDataDir(), "reth");
    if (existsSync(rethDir)) {
      rmSync(rethDir, { recursive: true, force: true });
      console.log(`[StateManager] Cleared reth data at ${rethDir}`);
    }
  }

  /**
   * Get the reth binary path (for use by event processor for unwind commands)
   */
  getRethBinary(): string {
    return process.env.SYNC_ROLLUPS_RETH || "reth";
  }

  /**
   * Get the current L2 block number
   */
  async getL2BlockNumber(): Promise<number> {
    if (!this.l2Provider) {
      throw new Error("L2 provider not initialized");
    }
    const blockHex = await this.l2Provider.send("eth_blockNumber", []);
    return parseInt(blockHex, 16);
  }

  /**
   * Save sync state to disk for persistence across restarts.
   * Includes block hash history and checkpoints for reorg detection/recovery.
   */
  saveSyncState(
    lastProcessedL1Block: number,
    reorgData?: {
      blockHashHistory: Array<{ blockNumber: number; blockHash: string }>;
      checkpoints: L1L2Checkpoint[];
    }
  ): void {
    const dataDir = this.getDataDir();
    mkdirSync(dataDir, { recursive: true });
    const syncState: SyncState = {
      lastProcessedL1Block,
      stateRoot: this.state.stateRoot,
      etherBalance: this.state.etherBalance.toString(),
      blockHashHistory: reorgData?.blockHashHistory || [],
      checkpoints: reorgData?.checkpoints || [],
    };
    writeFileSync(
      join(dataDir, "sync-state.json"),
      JSON.stringify(syncState, null, 2)
    );
  }

  /**
   * Load sync state from disk (returns null if no persisted state)
   */
  loadSyncState(): SyncState | null {
    const syncStatePath = join(this.getDataDir(), "sync-state.json");
    if (!existsSync(syncStatePath)) {
      return null;
    }
    try {
      const data = readFileSync(syncStatePath, "utf-8");
      return JSON.parse(data) as SyncState;
    } catch {
      return null;
    }
  }

  /**
   * Get the L2 provider
   */
  getL2Provider(): JsonRpcProvider {
    if (!this.l2Provider) {
      throw new Error("L2 provider not initialized - call startEngine first");
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
   * Verify that tracked state matches actual L2 EVM state.
   *
   * NOTE: The raw L2 EVM state root (from reth) reflects low-level Ethereum
   * trie state and will NOT match the application-level state root tracked on
   * L1.  This method is kept for diagnostics but always logs both values for
   * manual comparison rather than expecting an exact match.
   */
  async verifyStateSync(): Promise<{ trackedRoot: string; evmRoot: string }> {
    const evmRoot = await this.getActualStateRoot();
    console.log(
      `[StateManager] Tracked state root: ${this.state.stateRoot}, L2 EVM state root: ${evmRoot}`
    );
    return { trackedRoot: this.state.stateRoot, evmRoot };
  }

  /**
   * Save the current chain head block number (replaces anvil_snapshot)
   * Returns the block number as a hex string
   */
  async saveHead(): Promise<string> {
    if (!this.l2Provider) {
      throw new Error("L2 provider not initialized");
    }
    const blockNum = await this.l2Provider.send("eth_blockNumber", []);
    return blockNum;
  }

  /**
   * Revert to a previous block number using debug_setHead.
   *
   * WARNING: In standard reth, debug_setHead is a NO-OP (returns Ok without action).
   * This method is kept for API compatibility but does NOT actually revert state.
   * Simulations should use eth_call (read-only) instead of snapshot/revert.
   *
   * @param blockHex The block number as hex string (e.g., "0xa")
   */
  async revertToBlock(blockHex: string): Promise<void> {
    if (!this.l2Provider) {
      throw new Error("L2 provider not initialized");
    }
    // Note: This is a no-op in standard reth. State is not actually reverted.
    await this.l2Provider.send("debug_setHead", [blockHex]);
  }

  /**
   * Execute a "system call" — a protocol-level transaction on the local L2.
   *
   * Uses a randomly-generated operator account (not a well-known dev account)
   * to sign and submit the transaction. Since L2Authority has no access control
   * and authorizedProxies() always returns true, any caller can perform these
   * operations. The operator key is stored in the data directory and is only
   * known to this fullnode process.
   *
   * @param to Target contract address
   * @param data ABI-encoded calldata
   * @param value ETH value to send (hex string, default "0x0")
   * @returns The transaction hash
   */
  async systemCall(to: string, data: string, value: string = "0x0"): Promise<string> {
    if (!this.operatorWallet) {
      throw new Error("Operator wallet not initialized - call startEngine first");
    }

    const tx = await this.operatorWallet.sendTransaction({
      to,
      data,
      value: BigInt(value),
      // Zero gas cost for deterministic execution across fullnode instances.
      // With baseFeePerGas=0 in genesis (stays 0 forever since 0*anything=0),
      // using maxFeePerGas=0 means zero gas cost and zero priority fee.
      // This ensures no miner/coinbase balance entry is created — critical because
      // reth --dev mode generates a random miner address per instance.
      // Requires --txpool.minimal-protocol-fee 0 --txpool.minimum-priority-fee 0.
      gasLimit: 10_000_000n,
      maxFeePerGas: 0n,
      maxPriorityFeePerGas: 0n,
      type: 2,                                // EIP-1559
    });

    // Wait for the transaction to be mined (reth auto-mines with --dev.block-time)
    const receipt = await this.waitForReceipt(tx.hash);
    if (receipt.status === 0) {
      throw new Error(`System call reverted (tx: ${tx.hash})`);
    }

    return tx.hash;
  }

  /**
   * Wait for a transaction to be mined (reth auto-mines with --dev.block-time)
   * @param txHash The transaction hash to wait for
   * @param timeoutMs Maximum time to wait in ms (default 10s)
   * @returns The transaction receipt
   */
  async waitForReceipt(txHash: string, timeoutMs: number = 10000): Promise<any> {
    if (!this.l2Provider) {
      throw new Error("L2 provider not initialized");
    }

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const receipt = await this.l2Provider.getTransactionReceipt(txHash);
      if (receipt) return receipt;
      await new Promise(r => setTimeout(r, 200));
    }
    throw new Error(`Transaction ${txHash} not mined within ${timeoutMs}ms`);
  }

  /**
   * Ensure an L2Proxy is deployed at the correct address on L2.
   * If the proxy doesn't exist yet, deploys it via L2Authority.deployProxy().
   * @param originalAddress The original address (L1 sender)
   * @param rollupId The rollup ID
   * @param domain The chain ID domain (L1 chain ID)
   * @returns The proxy address on L2
   */
  async ensureProxyDeployed(originalAddress: string, rollupId: bigint, domain: bigint): Promise<string> {
    if (!this.l2Provider) {
      throw new Error("L2 provider not initialized");
    }
    if (!this.config.rollupsAddress) {
      throw new Error("rollupsAddress not configured - cannot deploy proxy on L2");
    }

    // Compute the expected proxy address (same as L1's computeL2ProxyAddress)
    // We ask the L2Authority contract (deployed at rollupsAddress on L2) to compute it
    const l2AuthIface = new Interface([
      "function computeProxyAddress(address originalAddress, uint256 originalRollupId, uint256 domain) view returns (address)",
      "function deployProxy(address originalAddress, uint256 originalRollupId, uint256 domain) returns (address)",
    ]);

    // Compute expected address
    const computeCalldata = l2AuthIface.encodeFunctionData("computeProxyAddress", [
      originalAddress, rollupId, domain
    ]);
    const proxyAddrResult = await this.l2Provider.send("eth_call", [
      { to: this.config.rollupsAddress, data: computeCalldata },
      "latest",
    ]);
    const proxyAddress = "0x" + proxyAddrResult.slice(26); // Extract address from 32-byte result

    // Check if proxy already has code
    const code = await this.l2Provider.send("eth_getCode", [proxyAddress, "latest"]);
    if (code !== "0x" && code !== "0x0") {
      return proxyAddress; // Already deployed
    }

    // Deploy via system call to L2Authority
    console.log(`[StateManager] Deploying L2 proxy for ${originalAddress} at ${proxyAddress}`);
    const deployCalldata = l2AuthIface.encodeFunctionData("deployProxy", [
      originalAddress, rollupId, domain
    ]);
    await this.systemCall(this.config.rollupsAddress, deployCalldata);

    // Verify deployment
    const codeAfter = await this.l2Provider.send("eth_getCode", [proxyAddress, "latest"]);
    if (codeAfter === "0x" || codeAfter === "0x0") {
      throw new Error(`Failed to deploy proxy at ${proxyAddress}`);
    }

    console.log(`[StateManager] L2 proxy deployed at ${proxyAddress}`);
    return proxyAddress;
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
