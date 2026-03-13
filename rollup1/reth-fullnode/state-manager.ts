/**
 * State Manager for sync-rollups fullnode
 * Tracks rollup state and manages loaded executions cache
 * Uses reth as the L2 execution engine
 */

import { ChildProcess, spawn, execSync } from "child_process";
import { createHmac } from "crypto";
import { JsonRpcProvider, Wallet, Interface, solidityPackedKeccak256 } from "ethers";
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import {
  RollupState,
  ExecutionEntry,
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
  rollupsAddress?: string; // L1 Rollups contract address (CrossChainManagerL2 deployed here on L2)
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

  // Cache of loaded executions: actionHash -> ExecutionEntry[]
  private executionCache: Map<string, ExecutionEntry[]> = new Map();

  // reth process and provider
  private engineProcess: ChildProcess | null = null;
  private l2Provider: JsonRpcProvider | null = null;

  // Engine API (auth RPC) for block production
  private authRpcPort: number = 0;
  private jwtSecret: string = "";  // hex-encoded JWT secret

  // Operator wallet — used to sign system call transactions on the local L2.
  // This is a randomly generated key (NOT a well-known dev account), stored in the
  // data directory. Only this fullnode process knows the key, preventing interference.
  // Since CrossChainManagerL2 has no access control, any address can perform protocol operations.
  private operatorWallet: Wallet | null = null;

  // Tracked operator nonce (avoids stale provider cache between mine cycles)
  private operatorNonce: number = 0;

  // Cached genesis path for reuse in unwindToBlock
  private genesisPath: string | null = null;

  // L2 block number corresponding to the last tracked state update.
  // Used by the builder to rollback simulation-only blocks before planning.
  private trackedL2Block: number = 0;

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
   * so we need SOME private key. Since CrossChainManagerL2 has no access control, the specific
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
   * Load compiled contract artifact from Forge
   */
  private loadContractArtifact(contractName: string, fileName: string): any | null {
    const outDir = this.config.contractsOutDir;
    if (!outDir) return null;

    const artifactPath = join(outDir, fileName, `${contractName}.json`);
    if (!existsSync(artifactPath)) {
      console.warn(`[StateManager] Contract artifact not found: ${artifactPath}`);
      return null;
    }

    try {
      return JSON.parse(readFileSync(artifactPath, "utf-8"));
    } catch (e: any) {
      console.warn(`[StateManager] Failed to load artifact ${artifactPath}: ${e.message}`);
      return null;
    }
  }

  /**
   * Get deployed bytecode with immutables spliced in.
   * Forge artifacts store immutable reference locations; we replace them with actual values.
   */
  private getDeployedBytecodeWithImmutables(
    artifact: any,
    immutableValues: Record<string, string> // name -> hex value (no 0x prefix, 64-char padded)
  ): string | null {
    const bytecodeHex = artifact.deployedBytecode?.object;
    if (!bytecodeHex) return null;

    // Remove 0x prefix for manipulation
    let code = bytecodeHex.startsWith("0x") ? bytecodeHex.slice(2) : bytecodeHex;

    const immutableRefs = artifact.deployedBytecode?.immutableReferences;
    if (!immutableRefs) return "0x" + code;

    // immutableRefs is { "<ast_id>": [{ start: number, length: number }, ...] }
    // We need to map AST IDs to names. The AST is in artifact.ast.
    // Simpler: match by searching the AST for variable declarations with the given names.
    const astIdToName: Record<string, string> = {};
    const ast = artifact.ast;
    if (ast) {
      const findImmutables = (node: any) => {
        if (!node || typeof node !== "object") return;
        if (node.nodeType === "VariableDeclaration" && node.mutability === "immutable") {
          astIdToName[node.id.toString()] = node.name;
        }
        for (const value of Object.values(node)) {
          if (Array.isArray(value)) {
            value.forEach((item: any) => findImmutables(item));
          } else if (value && typeof value === "object") {
            findImmutables(value);
          }
        }
      };
      findImmutables(ast);
    }

    for (const [astId, refs] of Object.entries(immutableRefs) as Array<[string, any[]]>) {
      const name = astIdToName[astId];
      if (!name) {
        console.warn(`[StateManager] Unknown immutable AST ID ${astId}`);
        continue;
      }
      const value = immutableValues[name];
      if (!value) {
        console.warn(`[StateManager] No value provided for immutable ${name}`);
        continue;
      }
      for (const ref of refs) {
        const startByte = ref.start;
        const length = ref.length;
        const paddedValue = value.padStart(length * 2, "0");
        code = code.slice(0, startByte * 2) + paddedValue + code.slice((startByte + length) * 2);
      }
    }

    return "0x" + code;
  }

  /**
   * Generate a custom genesis JSON for reth
   * Includes CrossChainManagerL2 and operator funding in alloc
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

    // Deploy CrossChainManagerL2 at the L1 Rollups contract address on L2.
    // The contract has immutables (ROLLUP_ID, SYSTEM_ADDRESS) that must be
    // spliced into the deployed bytecode since the constructor doesn't run at genesis.
    if (this.config.rollupsAddress && this.config.contractsOutDir) {
      const artifact = this.loadContractArtifact("CrossChainManagerL2", "CrossChainManagerL2.sol");
      if (artifact) {
        const operatorAddr = this.operatorWallet?.address || "0x0000000000000000000000000000000000000000";
        const bytecode = this.getDeployedBytecodeWithImmutables(artifact, {
          ROLLUP_ID: this.config.rollupId.toString(16).padStart(64, "0"),
          SYSTEM_ADDRESS: operatorAddr.slice(2).toLowerCase().padStart(64, "0"),
        });

        if (bytecode) {
          alloc[this.config.rollupsAddress.toLowerCase()] = {
            code: bytecode,
            balance: "0x0",
          };
          console.log(`[StateManager] Genesis: CrossChainManagerL2 at ${this.config.rollupsAddress} (SYSTEM_ADDRESS=${operatorAddr})`);
        }
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
      baseFeePerGas: "0x3B9ACA00",
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

    // Store auth RPC port for engine API calls (block production)
    this.authRpcPort = authRpcPort;

    this.engineProcess = spawn(
      rethBinary,
      [
        "node",
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
        "--txpool.max-account-slots", "256",    // Allow up to 256 pending txs per account (for batch replay)
        "--engine.persistence-threshold", "0",    // Persist blocks immediately (needed for reliable rollbacks via reth stage unwind)
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

    // Load JWT secret for engine API authentication
    const jwtPath = join(dataDir, "reth", "jwt.hex");
    if (existsSync(jwtPath)) {
      this.jwtSecret = readFileSync(jwtPath, "utf-8").trim();
    } else {
      console.warn(`[StateManager] JWT secret not found at ${jwtPath}, engine API mining unavailable`);
    }

    // Sync operator nonce from chain state
    if (this.operatorWallet && this.l2Provider) {
      const onChainNonce = await this.l2Provider.getTransactionCount(this.operatorWallet.address, "latest");
      this.operatorNonce = onChainNonce;
    }

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

    // reth stage unwind has off-by-one: "to-block N" ends at block N-1.
    // Pass N+1 to end at the desired block N. Guard against block 0 edge case.
    const unwindTarget = l2BlockNumber + 1;
    try {
      const result = execSync(
        `"${rethBinary}" stage unwind --datadir "${rethDataDir}" --chain "${genesisPath}" to-block ${unwindTarget}`,
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
   * Roll back the L2 EVM to a specific block number using the engine API's
   * forkchoice mechanism. This is lightweight (no reth restart) and works
   * with unpersisted engine API blocks. Falls back to the heavy path
   * (stop + unwind + restart) if forkchoice revert fails.
   */
  async rollbackToBlock(targetBlock: number): Promise<void> {
    const currentBlock = await this.getL2BlockNumber();
    if (currentBlock <= targetBlock) {
      return; // Nothing to rollback
    }
    console.log(`[StateManager] Rolling back L2 from block ${currentBlock} to ${targetBlock}...`);

    // Try lightweight forkchoice-based rollback first.
    // Get the target block's hash and set it as the chain head.
    try {
      const provider = this.getL2Provider();
      const targetBlockHex = "0x" + targetBlock.toString(16);
      const block = await provider.send("eth_getBlockByNumber", [targetBlockHex, false]);
      if (block && block.hash) {
        await this.engineApiCall("engine_forkchoiceUpdatedV3", [
          { headBlockHash: block.hash, safeBlockHash: block.hash, finalizedBlockHash: block.hash },
          null,
        ]);
        const newBlock = await this.getL2BlockNumber();
        if (newBlock === targetBlock) {
          console.log(`[StateManager] Rollback complete via forkchoice, now at block ${newBlock}`);
          return;
        }
        console.warn(`[StateManager] Forkchoice rollback landed at block ${newBlock}, expected ${targetBlock}. Trying heavy path.`);
      }
    } catch (e: any) {
      console.warn(`[StateManager] Forkchoice rollback failed: ${e.message}. Trying heavy path.`);
    }

    // Heavy path: stop reth, unwind, restart
    await this.stopEngine();
    try {
      await this.unwindToBlock(targetBlock);
    } catch (e: any) {
      // Unwind can fail if simulation blocks weren't persisted to reth's DB
      // (e.g. target block > reth's latest persisted block after stop).
      // The unpersisted blocks are already gone after stopEngine(), so this is safe to ignore.
      console.warn(`[StateManager] Unwind failed (non-fatal): ${e.message}`);
    }
    await this.startEngine();
    const newBlock = await this.getL2BlockNumber();
    console.log(`[StateManager] Rollback complete, now at block ${newBlock}`);
    if (newBlock < targetBlock) {
      // Engine API blocks weren't persisted to reth's DB before the stop.
      // After restart, reth is at a lower block than expected. This is OK —
      // the event processor will re-mine the missing blocks from L1 events.
      // Update trackedL2Block to reflect what reth actually has.
      console.warn(
        `[StateManager] Rollback undershoot: landed at block ${newBlock}, expected ${targetBlock}. ` +
        `Event processor will re-mine missing blocks.`
      );
      this.trackedL2Block = newBlock;
    }
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
   * Get the L2 block number corresponding to the last tracked state update.
   * Used by the builder to know where to rollback simulation-only blocks.
   */
  getTrackedL2Block(): number {
    return this.trackedL2Block;
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

  getL2ChainId(): number {
    return this.config.l2ChainId;
  }

  /**
   * Get the L1 Rollups / L2 CrossChainManagerL2 contract address
   */
  getRollupsAddress(): string {
    return this.config.rollupsAddress || "0x0000000000000000000000000000000000000000";
  }

  getOperatorAddress(): string {
    return this.operatorWallet?.address || "0x0000000000000000000000000000000000000000";
  }

  /**
   * Get the operator's genesis balance (constant).
   */
  getOperatorGenesisBalance(): bigint {
    return BigInt(OPERATOR_INITIAL_BALANCE);
  }

  /**
   * Check the bridge invariant:
   *   rollup.etherBalance (L1) + operator.balance (L2) == operator genesis balance
   *
   * Every ETH that enters the rollup on L1 (via depositEther / L1→L2 calls) is
   * disbursed by the operator on L2. The operator's L2 balance decreases by the
   * same amount the L1 etherBalance increases, so their sum must always equal
   * the operator's genesis allocation.
   *
   * @param l1EtherBalance The rollup's etherBalance from the L1 contract
   * @returns Object with balances and whether the invariant holds
   */
  async checkBridgeInvariant(l1EtherBalance: bigint): Promise<{
    l1EtherBalance: bigint;
    operatorL2Balance: bigint;
    genesisBalance: bigint;
    holds: boolean;
  }> {
    if (!this.l2Provider || !this.operatorWallet) {
      throw new Error("Engine not started");
    }
    const operatorL2Balance = await this.l2Provider.getBalance(this.operatorWallet.address);
    const genesisBalance = this.getOperatorGenesisBalance();
    const holds = l1EtherBalance + operatorL2Balance === genesisBalance;
    return { l1EtherBalance, operatorL2Balance, genesisBalance, holds };
  }

  /**
   * Update state from L1 event
   */
  updateState(newStateRoot: string, blockNumber: bigint, l2BlockNumber?: number): void {
    console.log(
      `[StateManager] State updated: ${this.state.stateRoot.slice(0, 10)}... -> ${newStateRoot.slice(0, 10)}... at block ${blockNumber}`
    );
    this.state.stateRoot = newStateRoot;
    this.state.blockNumber = blockNumber;
    if (l2BlockNumber !== undefined) {
      this.trackedL2Block = l2BlockNumber;
    }
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
  cacheExecutions(executions: ExecutionEntry[]): void {
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
  ): ExecutionEntry | null {
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
  getExecutions(actionHash: string): ExecutionEntry[] {
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
   * to sign and submit the transaction. Since CrossChainManagerL2 has no access control
   * and authorizedProxies() always returns true, any caller can perform these
   * operations. The operator key is stored in the data directory and is only
   * known to this fullnode process.
   *
   * @param to Target contract address
   * @param data ABI-encoded calldata
   * @param value ETH value to send (hex string, default "0x0")
   * @returns The transaction hash
   */
  /**
   * Compute the expected base fee for the next block using the EIP-1559 formula.
   * This is deterministic: given the same parent block, all fullnodes compute the
   * same value. Used for system transaction gas pricing.
   */
  async getNextBaseFee(): Promise<bigint> {
    if (!this.l2Provider) {
      return 1000000000n; // 1 gwei fallback
    }
    const block = await this.l2Provider.send("eth_getBlockByNumber", ["latest", false]);
    const parentBaseFee = BigInt(block.baseFeePerGas || "0x0");
    const parentGasUsed = BigInt(block.gasUsed || "0x0");
    const parentGasLimit = BigInt(block.gasLimit || "0x1c9c380");
    return computeNextBaseFee(parentBaseFee, parentGasUsed, parentGasLimit);
  }

  /**
   * Send a system transaction to the txpool WITHOUT mining a block.
   * Use this for preparation transactions that should share a block with the main tx.
   * Call mineBlock() afterwards to include all pending txs in one block.
   */
  async sendSystemTx(to: string, data: string, value: string = "0x0"): Promise<string> {
    if (!this.operatorWallet) {
      throw new Error("Operator wallet not initialized - call startEngine first");
    }

    const baseFee = await this.getNextBaseFee();
    const nonce = this.operatorNonce;
    const tx = await this.operatorWallet.sendTransaction({
      to,
      data,
      value: BigInt(value),
      nonce,
      gasLimit: 10_000_000n,
      maxFeePerGas: baseFee,
      maxPriorityFeePerGas: 0n,
      type: 2,
    });
    this.operatorNonce++;
    return tx.hash;
  }

  async systemCall(
    to: string,
    data: string,
    value: string = "0x0",
    blockOptions?: { coinbase?: string; timestamp?: number }
  ): Promise<string> {
    if (!this.operatorWallet) {
      throw new Error("Operator wallet not initialized - call startEngine first");
    }

    const baseFee = await this.getNextBaseFee();
    const nonce = this.operatorNonce;
    const tx = await this.operatorWallet.sendTransaction({
      to,
      data,
      value: BigInt(value),
      nonce,
      gasLimit: 10_000_000n,
      maxFeePerGas: baseFee,
      maxPriorityFeePerGas: 0n,
      type: 2,                                // EIP-1559
    });
    this.operatorNonce++;

    // Mine a block and wait for the receipt
    const receipt = await this.waitForReceipt(tx.hash, 30000, blockOptions);
    if (receipt.status === 0) {
      throw new Error(`System call reverted (tx: ${tx.hash})`);
    }

    return tx.hash;
  }

  /**
   * Broadcast a raw signed L2 transaction to reth.
   * The original signed transaction is sent as-is via eth_sendRawTransaction,
   * preserving the real sender address. The sender must have sufficient L2
   * balance (bridged from L1 via depositEther).
   */
  async broadcastRawTx(
    rlpEncodedTx: string,
    blockOptions?: { coinbase?: string; timestamp?: number }
  ): Promise<string> {
    const txHash = await this.sendRawTransaction(rlpEncodedTx);
    // Check txpool status after submission for debugging
    try {
      const poolStatus = await this.l2Provider!.send("txpool_status", []);
      console.log(`[StateManager] txpool after submit: pending=${parseInt(poolStatus.pending, 16)}, queued=${parseInt(poolStatus.queued, 16)}`);
    } catch {}
    const receipt = await this.waitForReceipt(txHash, 30000, blockOptions);
    if (receipt.status === 0) {
      throw new Error(`L2TX reverted (tx: ${txHash})`);
    }
    return txHash;
  }

  /**
   * Wait for a transaction to be mined.
   * Since we don't use --dev auto-mining, this calls mineBlock() to produce a block
   * via the engine API, then checks for the receipt.
   */
  async waitForReceipt(
    txHash: string,
    timeoutMs: number = 30000,
    blockOptions?: { coinbase?: string; timestamp?: number }
  ): Promise<any> {
    if (!this.l2Provider) {
      throw new Error("L2 provider not initialized");
    }

    // Mine a block to include the pending transaction.
    // For large txs (e.g. UniswapV2Factory deploy), the tx may not be in the
    // pending pool yet when we start building. Wait briefly for it to propagate.
    await new Promise(r => setTimeout(r, 100));

    const start = Date.now();
    let mineAttempts = 0;
    while (Date.now() - start < timeoutMs) {
      const opts = mineAttempts === 0 ? blockOptions : undefined;
      try {
        await this.mineBlock(opts);
      } catch (mineErr: any) {
        console.warn(`[StateManager] mineBlock attempt ${mineAttempts} failed: ${mineErr.message}`);
      }
      mineAttempts++;
      const receipt = await this.l2Provider.getTransactionReceipt(txHash);
      if (receipt) return receipt;
      // Tx not in the block — check txpool and retry
      try {
        const poolStatus = await this.l2Provider.send("txpool_status", []);
        const pending = parseInt(poolStatus.pending, 16);
        const queued = parseInt(poolStatus.queued, 16);
        if (pending === 0 && queued === 0) {
          throw new Error(`Transaction ${txHash} not in txpool (dropped or rejected)`);
        }
        console.log(`[StateManager] Tx not in block after mine attempt ${mineAttempts}, txpool: pending=${pending} queued=${queued}`);
      } catch (poolErr: any) {
        if (poolErr.message.includes("not in txpool")) throw poolErr;
      }
      await new Promise(r => setTimeout(r, 500));
    }
    throw new Error(`Transaction ${txHash} not mined within ${timeoutMs}ms`);
  }

  /**
   * Ensure a CrossChainProxy is deployed at the correct address on L2.
   * If the proxy doesn't exist yet, deploys it via CrossChainManagerL2.createCrossChainProxy().
   * @param originalAddress The original address (L1 sender)
   * @param rollupId The rollup ID
   * @param domain The chain ID domain (L1 chain ID)
   * @returns The proxy address on L2
   */
  async ensureProxyDeployed(
    originalAddress: string,
    rollupId: bigint,
    domain: bigint,
    blockOptions?: { coinbase?: string; timestamp?: number }
  ): Promise<string> {
    if (!this.l2Provider) {
      throw new Error("L2 provider not initialized");
    }
    if (!this.config.rollupsAddress) {
      throw new Error("rollupsAddress not configured - cannot deploy proxy on L2");
    }

    // Compute the expected proxy address via CrossChainManagerL2
    const managerIface = new Interface([
      "function computeCrossChainProxyAddress(address originalAddress, uint256 originalRollupId, uint256 domain) view returns (address)",
      "function createCrossChainProxy(address originalAddress, uint256 originalRollupId) returns (address)",
    ]);

    // Compute expected address
    const computeCalldata = managerIface.encodeFunctionData("computeCrossChainProxyAddress", [
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

    // Deploy via system call to CrossChainManagerL2.
    // When blockOptions are provided, use sendSystemTx (no mining) so the proxy
    // deployment shares the same L2 block as the main call (spec rule: preparation
    // txs at the beginning of the block).
    console.log(`[StateManager] Deploying CrossChainProxy for ${originalAddress} at ${proxyAddress}`);
    const deployCalldata = managerIface.encodeFunctionData("createCrossChainProxy", [
      originalAddress, rollupId
    ]);

    if (blockOptions) {
      // Deferred mining: add to txpool, caller will mine later
      await this.sendSystemTx(this.config.rollupsAddress, deployCalldata);
      // Can't verify deployment until block is mined — caller must mine first
    } else {
      // Immediate mining (builder simulation, no block options)
      await this.systemCall(this.config.rollupsAddress, deployCalldata);
    }

    // Verify deployment (only when block was mined immediately)
    if (!blockOptions) {
      const codeAfter = await this.l2Provider.send("eth_getCode", [proxyAddress, "latest"]);
      if (codeAfter === "0x" || codeAfter === "0x0") {
        throw new Error(`Failed to deploy proxy at ${proxyAddress}`);
      }
    }

    console.log(`[StateManager] CrossChainProxy deployed at ${proxyAddress}`);
    return proxyAddress;
  }

  /**
   * Send a raw transaction to the L2 EVM
   */
  async sendRawTransaction(rawTx: string): Promise<string> {
    if (!this.l2Provider) {
      throw new Error("L2 provider not initialized");
    }
    try {
      return await this.l2Provider.send("eth_sendRawTransaction", [rawTx]);
    } catch (e: any) {
      // "already known" means the tx is already in the txpool (e.g. from a previous
      // attempt within the same session). Return the hash so we can mine it.
      if (e.message?.includes("already known") || e.error?.message?.includes("already known")) {
        const { Transaction } = await import("ethers");
        const tx = Transaction.from(rawTx);
        console.log(`[StateManager] tx already known: ${tx.hash} (nonce ${tx.nonce}), proceeding to mine`);
        return tx.hash!;
      }
      throw e;
    }
  }

  /**
   * Generate a JWT token for engine API authentication (HS256).
   */
  private generateJwt(): string {
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ iat: Math.floor(Date.now() / 1000) })).toString("base64url");
    const secret = Buffer.from(this.jwtSecret, "hex");
    const signature = createHmac("sha256", secret)
      .update(`${header}.${payload}`)
      .digest("base64url");
    return `${header}.${payload}.${signature}`;
  }

  /**
   * Call the engine API (auth RPC) with JWT authentication.
   */
  private async engineApiCall(method: string, params: any[]): Promise<any> {
    const token = this.generateJwt();
    const response = await fetch(`http://localhost:${this.authRpcPort}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
    });
    const result = await response.json() as any;
    if (result.error) {
      throw new Error(`Engine API ${method}: ${result.error.message}`);
    }
    return result.result;
  }

  /**
   * Mine a block using the engine API.
   *
   * Without --dev mode, reth doesn't auto-mine. We use the engine API to:
   * 1. Request a new payload (with suggestedFeeRecipient and timestamp)
   * 2. Get the built payload (includes pending txpool transactions)
   * 3. Submit the new payload
   * 4. Update the fork choice to make it canonical
   *
   * Per the state transition spec:
   * - coinbase = msg.sender of whoever called the L1 function
   * - timestamp = L1 block timestamp
   *
   * @param options.coinbase  The fee recipient / coinbase for this block (default: 0x0...0)
   * @param options.timestamp The block timestamp in seconds (default: headTimestamp + 1)
   */
  async mineBlock(options?: { coinbase?: string; timestamp?: number }): Promise<void> {
    if (!this.l2Provider) {
      throw new Error("L2 provider not initialized");
    }

    // Get the current head block
    const headBlock = await this.l2Provider.send("eth_getBlockByNumber", ["latest", false]);
    const headHash = headBlock.hash;
    const headTimestamp = parseInt(headBlock.timestamp, 16);

    // Use provided timestamp or increment by 1
    // Ensure timestamp is strictly greater than parent (EVM requirement)
    let blockTimestamp = options?.timestamp ?? (headTimestamp + 1);
    if (blockTimestamp <= headTimestamp) {
      blockTimestamp = headTimestamp + 1;
    }

    const coinbase = options?.coinbase || "0x0000000000000000000000000000000000000000";

    // Step 1: forkchoiceUpdated with payload attributes to start building a block
    const payloadAttributes = {
      timestamp: "0x" + blockTimestamp.toString(16),
      prevRandao: "0x0000000000000000000000000000000000000000000000000000000000000000",
      suggestedFeeRecipient: coinbase,
      withdrawals: [],
      parentBeaconBlockRoot: "0x0000000000000000000000000000000000000000000000000000000000000000",
    };
    const fcuResult = await this.engineApiCall("engine_forkchoiceUpdatedV3", [
      { headBlockHash: headHash, safeBlockHash: headHash, finalizedBlockHash: headHash },
      payloadAttributes,
    ]);
    const payloadId = fcuResult.payloadId;
    if (!payloadId) {
      throw new Error("engine_forkchoiceUpdatedV3 did not return payloadId");
    }

    // Step 2: Get the built payload
    const payload = await this.engineApiCall("engine_getPayloadV3", [payloadId]);
    const executionPayload = payload.executionPayload;

    // Step 3: Submit the new payload
    const newPayloadResult = await this.engineApiCall("engine_newPayloadV3", [
      executionPayload,
      [],  // no blob versioned hashes
      payloadAttributes.parentBeaconBlockRoot,
    ]);
    if (newPayloadResult.status !== "VALID") {
      throw new Error(`engine_newPayloadV3 returned ${newPayloadResult.status}: ${newPayloadResult.validationError}`);
    }

    // Step 4: Update fork choice to make the new block canonical
    const newHash = executionPayload.blockHash;
    await this.engineApiCall("engine_forkchoiceUpdatedV3", [
      { headBlockHash: newHash, safeBlockHash: newHash, finalizedBlockHash: newHash },
      null,
    ]);
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

/**
 * Compute the next block's base fee using the EIP-1559 formula.
 * This must be identical across all fullnode implementations for determinism.
 *
 * Formula (EIP-1559):
 *   gasTarget = parentGasLimit / 2
 *   if parentGasUsed == gasTarget:  nextBaseFee = parentBaseFee
 *   if parentGasUsed > gasTarget:   nextBaseFee = parentBaseFee + max(1, parentBaseFee * (parentGasUsed - gasTarget) / gasTarget / 8)
 *   if parentGasUsed < gasTarget:   nextBaseFee = parentBaseFee - parentBaseFee * (gasTarget - parentGasUsed) / gasTarget / 8
 */
export function computeNextBaseFee(
  parentBaseFee: bigint,
  parentGasUsed: bigint,
  parentGasLimit: bigint,
): bigint {
  const gasTarget = parentGasLimit / 2n;
  if (gasTarget === 0n) return parentBaseFee;

  if (parentGasUsed === gasTarget) {
    return parentBaseFee;
  } else if (parentGasUsed > gasTarget) {
    const delta = parentBaseFee * (parentGasUsed - gasTarget) / gasTarget / 8n;
    return parentBaseFee + (delta > 0n ? delta : 1n);
  } else {
    const delta = parentBaseFee * (gasTarget - parentGasUsed) / gasTarget / 8n;
    const newBaseFee = parentBaseFee - delta;
    return newBaseFee > 0n ? newBaseFee : 0n;
  }
}
