#!/usr/bin/env node
/**
 * Builder for sync-rollups
 * HTTP API for transaction submission and execution management
 */

import { createServer, IncomingMessage, ServerResponse } from "http";
import { Contract, JsonRpcProvider, Wallet, Transaction } from "ethers";
import { ExecutionPlanner, ExecutionPlannerConfig } from "./execution-planner.js";
import { ProofGenerator, ProofGeneratorConfig } from "./proof-generator.js";
import { ActionType, Execution, ExecutionPlan } from "../fullnode/types.js";

export interface BuilderConfig {
  // L1 connection
  l1RpcUrl: string;
  rollupsAddress: string;
  adminPrivateKey: string;
  // Key used to sign proofs accepted by AdminZKVerifier (can differ from tx-submitting admin key)
  proofSignerPrivateKey: string;

  // Builder-private fullnode connection (not the public/read-only fullnode)
  fullnodeRpcUrl: string;

  // Rollup config
  rollupId: bigint;

  // HTTP server
  port: number;
}

// Rollups contract ABI (functions we call)
const ROLLUPS_ABI = [
  "function loadL2Executions((tuple(uint256 rollupId, bytes32 currentState, bytes32 newState, int256 etherDelta)[] stateDeltas, bytes32 actionHash, tuple(uint8 actionType, uint256 rollupId, address destination, uint256 value, bytes data, bool failed, address sourceAddress, uint256 sourceRollup, uint256[] scope) nextAction)[] executions, bytes proof)",
  "function executeL2TX(uint256 rollupId, bytes rlpEncodedTx) returns (bytes)",
  "function rollups(uint256) view returns (address owner, bytes32 verificationKey, bytes32 stateRoot, uint256 etherBalance)",
  "function computeL2ProxyAddress(address originalAddress, uint256 originalRollupId, uint256 domain) view returns (address)",
  "function createL2ProxyContract(address originalAddress, uint256 originalRollupId) returns (address)",
  "function authorizedProxies(address) view returns (bool)",
  "event ExecutionsLoaded(uint256 count)",
  "event L2ExecutionPerformed(uint256 indexed rollupId, bytes32 currentState, bytes32 newState)",
  "event L2ProxyCreated(address indexed proxy, address indexed originalAddress, uint256 indexed originalRollupId)",
];

const L2PROXY_VIEW_ABI = [
  "function originalAddress() view returns (address)",
  "function originalRollupId() view returns (uint256)",
];

interface SubmitRequest {
  sourceChain: "L1" | "L2";
  signedTx: string;
  hints?: {
    l2TargetAddress?: string;
  };
}

interface SubmitResponse {
  success: boolean;
  l1TxHash?: string;
  executionsLoaded?: number;
  stateRoot?: string;
  error?: string;
}

interface StatusResponse {
  rollupId: string;
  l1StateRoot: string;
  fullnodeStateRoot: string;
  isSynced: boolean;
  adminAddress: string;
}

interface PrepareL1CallRequest {
  l2Target: string;      // Target address on L2 (EOA or contract)
  value: string;         // ETH value to send (hex string)
  data: string;          // Calldata (hex string, "0x" for plain ETH transfer)
  sourceAddress: string; // L1 caller address (EOA or contract)
}

interface PrepareL1CallResponse {
  success: boolean;
  proxyAddress?: string;     // L2Proxy address user should call on L1
  sourceProxyAddress?: string; // L2 sender proxy derived from original L1 caller
  proxyDeployed?: boolean;   // Whether proxy was newly deployed
  executionsLoaded?: number; // Number of executions pre-loaded
  reusedPreparation?: boolean; // Whether an existing prep was reused
  error?: string;
}

interface PrepareL2CallRequest {
  l1Target: string;      // Target contract address on L1
  sourceAddress?: string; // Optional L2 sender for source-proxy preview
}

interface PrepareL2CallResponse {
  success: boolean;
  proxyAddress?: string;      // Alias proxy address user should call from L2
  sourceProxyAddress?: string; // Deterministic L1 proxy for the L2 sender
  proxyDeployed?: boolean;    // Whether proxy was newly deployed
  error?: string;
}

export class Builder {
  private config: BuilderConfig;
  private planner: ExecutionPlanner;
  private proofGenerator: ProofGenerator;
  private l1Provider: JsonRpcProvider;
  private adminWallet: Wallet;
  private proofSignerWallet: Wallet;
  private rollupsContract: Contract;
  private server: ReturnType<typeof createServer> | null = null;
  private readonly prepareL1Cache = new Map<string, {
    stateRoot: string;
    proxyAddress: string;
    sourceProxyAddress: string;
    createdAtMs: number;
  }>();
  private static readonly PREPARE_L1_CACHE_TTL_MS = 10 * 60 * 1000;

  constructor(config: BuilderConfig) {
    this.config = config;

    // Initialize providers
    this.l1Provider = new JsonRpcProvider(config.l1RpcUrl);
    this.adminWallet = new Wallet(config.adminPrivateKey, this.l1Provider);
    this.proofSignerWallet = new Wallet(config.proofSignerPrivateKey, this.l1Provider);

    // Initialize contracts
    this.rollupsContract = new Contract(
      config.rollupsAddress,
      ROLLUPS_ABI,
      this.adminWallet
    );

    // Initialize planner
    const plannerConfig: ExecutionPlannerConfig = {
      rollupId: config.rollupId,
      fullnodeRpcUrl: config.fullnodeRpcUrl,
      l1RpcUrl: config.l1RpcUrl,
    };
    this.planner = new ExecutionPlanner(plannerConfig);

    // Initialize proof generator
    const proofConfig: ProofGeneratorConfig = {
      adminPrivateKey: config.proofSignerPrivateKey,
      l1RpcUrl: config.l1RpcUrl,
      rollupsAddress: config.rollupsAddress,
    };
    this.proofGenerator = new ProofGenerator(proofConfig);
  }

  /**
   * Start the builder HTTP server
   */
  async start(): Promise<void> {
    console.log("=== sync-rollups Builder ===");
    console.log(`Rollups contract: ${this.config.rollupsAddress}`);
    console.log(`Rollup ID: ${this.config.rollupId}`);
    console.log(`L1 RPC: ${this.config.l1RpcUrl}`);
    console.log(`Builder Fullnode RPC: ${this.config.fullnodeRpcUrl}`);
    console.log(`Admin: ${this.adminWallet.address}`);
    console.log(`Proof signer: ${this.proofSignerWallet.address}`);
    console.log("");

    // Verify connection
    const synced = await this.planner.isFullnodeSynced();
    console.log(`[Builder] Fullnode synced: ${synced}`);

    // Start HTTP server
    this.server = createServer((req, res) => this.handleRequest(req, res));

    return new Promise((resolve) => {
      this.server!.listen(this.config.port, () => {
        console.log(`[Builder] API listening on http://localhost:${this.config.port}`);
        console.log("");
        console.log("Endpoints:");
        console.log("  POST /submit           - Submit transaction");
        console.log("  POST /prepare-l1-call  - Prepare L1→L2 call");
        console.log("  POST /prepare-l2-call  - Prepare L2→L1 call");
        console.log("  GET  /status           - Get builder status");
        resolve();
      });
    });
  }

  /**
   * Stop the builder
   */
  async stop(): Promise<void> {
    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => {
          console.log("[Builder] Stopped");
          resolve();
        });
      });
    }
  }

  /**
   * Handle HTTP request
   */
  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || "/", `http://localhost:${this.config.port}`);

    try {
      if (url.pathname === "/status" && req.method === "GET") {
        const status = await this.getStatus();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(status));
      } else if (url.pathname === "/submit" && req.method === "POST") {
        // Read body
        let body = "";
        for await (const chunk of req) {
          body += chunk;
        }

        const request: SubmitRequest = JSON.parse(body);
        const response = await this.handleSubmit(request);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(response));
      } else if (url.pathname === "/prepare-l1-call" && req.method === "POST") {
        // Read body
        let body = "";
        for await (const chunk of req) {
          body += chunk;
        }

        const request: PrepareL1CallRequest = JSON.parse(body);
        const response = await this.handlePrepareL1Call(request);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(response));
      } else if (url.pathname === "/prepare-l2-call" && req.method === "POST") {
        // Read body
        let body = "";
        for await (const chunk of req) {
          body += chunk;
        }

        const request: PrepareL2CallRequest = JSON.parse(body);
        const response = await this.handlePrepareL2Call(request);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(response));
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    } catch (error: any) {
      console.error("[Builder] Request error:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    }
  }

  /**
   * Get builder status
   */
  private async getStatus(): Promise<StatusResponse> {
    const states = await this.planner.getStates();
    const synced = states.fullnodeState === states.l1State.stateRoot;

    return {
      rollupId: this.config.rollupId.toString(),
      l1StateRoot: states.l1State.stateRoot,
      fullnodeStateRoot: states.fullnodeState,
      isSynced: synced,
      adminAddress: this.adminWallet.address,
    };
  }

  /**
   * Handle transaction submission
   */
  private async handleSubmit(request: SubmitRequest): Promise<SubmitResponse> {
    const { sourceChain, signedTx, hints } = request;

    console.log(`[Builder] Received ${sourceChain} transaction`);

    // Check sync status
    const synced = await this.planner.isFullnodeSynced();
    if (!synced) {
      return {
        success: false,
        error: "Fullnode not synced with L1",
      };
    }

    try {
      if (sourceChain === "L2") {
        return await this.processL2Transaction(signedTx);
      } else {
        return await this.processL1Transaction(signedTx, hints);
      }
    } catch (error: any) {
      console.error("[Builder] Submit error:", error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Process an L2 transaction
   */
  private async processL2Transaction(signedTx: string): Promise<SubmitResponse> {
    console.log("[Builder] Processing L2 transaction...");

    const tx = Transaction.from(signedTx);
    const l1ChainId = (await this.l1Provider.getNetwork()).chainId;

    let plan: ExecutionPlan;
    if (tx.to) {
      const l2ToL1 = await this.tryResolveL2ToL1Proxy(tx.to, l1ChainId);
      if (l2ToL1) {
        if (!tx.from) {
          throw new Error("Signed L2 tx has no sender address");
        }
        // Use rollup identity for caller mapping:
        // fixed proxy per (address, rollupId) on L1.
        const sourceProxyOnL1 = await this.rollupsContract.computeL2ProxyAddress(
          tx.from,
          this.config.rollupId,
          l1ChainId
        );
        console.log(
          `[Builder] Detected L2→L1 call via prepared proxy ${tx.to} -> ${l2ToL1.l1Target}`
        );
        console.log(`[Builder] L1 source proxy for sender ${tx.from}: ${sourceProxyOnL1}`);

        plan = await this.planner.planL2ToL1Call(
          signedTx,
          l2ToL1.l1Target,
          tx.data,
          tx.value,
          tx.from,
          sourceProxyOnL1
        );
      } else {
        // Standard L2 transaction
        plan = await this.planner.planL2Transaction(signedTx);
      }
    } else {
      // L2 contract deployment
      plan = await this.planner.planL2Transaction(signedTx);
    }

    console.log(`[Builder] Planned ${plan.executions.length} execution(s)`);

    // Sign the proof
    const proof = await this.proofGenerator.signLoadExecutionsProof(
      plan.executions
    );
    console.log("[Builder] Proof signed");

    // Notify fullnode of executions
    await this.planner.notifyExecutions(plan.executions);
    console.log("[Builder] Fullnode notified");

    // Load executions on L1 (get fresh nonce)
    let nonce = await this.adminWallet.getNonce();
    console.log(`[Builder] Starting with nonce ${nonce}`);

    const l1TxHash = await this.loadExecutionsOnL1(plan.executions, proof, nonce);
    console.log(`[Builder] Executions loaded: ${l1TxHash}`);
    nonce++;

    // Now execute the L2TX on L1 (with next nonce)
    // In single-tx mode, we can call executeL2TX directly
    // The user would normally call this, but for simplicity we do it here
    const execTx = await this.rollupsContract.executeL2TX(
      this.config.rollupId,
      signedTx,
      { nonce }
    );
    const execReceipt = await execTx.wait();
    console.log(`[Builder] L2TX executed: ${execReceipt.hash}`);

    // Get new state
    const rollupData = await this.rollupsContract.rollups(this.config.rollupId);

    return {
      success: true,
      l1TxHash: execReceipt.hash,
      executionsLoaded: plan.executions.length,
      stateRoot: rollupData.stateRoot,
    };
  }

  /**
   * Resolve whether an L2 tx destination is a prepared proxy representing an L1 target.
   * For now, we treat a proxy as L2→L1-callable only if originalRollupId == current L1 chain ID.
   */
  private async tryResolveL2ToL1Proxy(
    proxyAddress: string,
    l1ChainId: bigint
  ): Promise<{ l1Target: string } | null> {
    try {
      const code = await this.l1Provider.getCode(proxyAddress);
      if (code === "0x") {
        return null;
      }

      const isAuthorized = await this.rollupsContract.authorizedProxies(proxyAddress);
      if (!isAuthorized) {
        return null;
      }

      const proxy = new Contract(proxyAddress, L2PROXY_VIEW_ABI, this.l1Provider);
      const originalAddress = await proxy.originalAddress();
      const originalRollupId = BigInt(await proxy.originalRollupId());

      if (originalRollupId !== l1ChainId) {
        return null;
      }

      return { l1Target: originalAddress };
    } catch (error: any) {
      console.warn(
        `[Builder] Failed to resolve potential L2→L1 proxy ${proxyAddress}: ${error.message}`
      );
      return null;
    }
  }

  /**
   * Process an L1 transaction (L1 contract calling L2)
   */
  private async processL1Transaction(
    signedTx: string,
    hints?: { l2TargetAddress?: string }
  ): Promise<SubmitResponse> {
    console.log("[Builder] Processing L1 transaction...");

    // Parse the transaction to get details
    const tx = Transaction.from(signedTx);
    if (!tx.to) {
      return {
        success: false,
        error: "Transaction has no destination",
      };
    }

    // For L1->L2 calls, we need to know the L2 target
    // This would normally be detected by analyzing the call
    // For now, we require a hint
    const l2Target = hints?.l2TargetAddress;
    if (!l2Target) {
      // Try to broadcast as a simple L1 transaction
      console.log("[Builder] Broadcasting as simple L1 transaction");
      const txResponse = await this.l1Provider.broadcastTransaction(signedTx);
      console.log(`[Builder] L1 transaction broadcast: ${txResponse.hash}`);

      return {
        success: true,
        l1TxHash: txResponse.hash,
      };
    }

    // Plan the L1->L2 call execution
    const plan = await this.planner.planL1ToL2Call(
      l2Target,
      tx.data,
      tx.value,
      tx.from || this.adminWallet.address
    );
    console.log(`[Builder] Planned ${plan.executions.length} execution(s)`);

    // Sign the proof
    const proof = await this.proofGenerator.signLoadExecutionsProof(
      plan.executions
    );
    console.log("[Builder] Proof signed");

    // Notify fullnode
    await this.planner.notifyExecutions(plan.executions);

    // Load executions on L1
    const loadTxHash = await this.loadExecutionsOnL1(plan.executions, proof);
    console.log(`[Builder] Executions loaded: ${loadTxHash}`);

    // Now broadcast the user's L1 transaction
    const txResponse = await this.l1Provider.broadcastTransaction(signedTx);
    console.log(`[Builder] User transaction broadcast: ${txResponse.hash}`);

    // Do not block indefinitely waiting for mining here. Browsers expect
    // eth_sendTransaction/eth_sendRawTransaction to return promptly.
    let stateRoot: string | undefined;
    try {
      const receipt = await this.l1Provider.waitForTransaction(
        txResponse.hash,
        1,
        5000
      );
      if (receipt) {
        console.log(`[Builder] User transaction executed: ${receipt.hash}`);
        const rollupData = await this.rollupsContract.rollups(this.config.rollupId);
        stateRoot = rollupData.stateRoot;
      } else {
        console.log("[Builder] User transaction pending (not mined within 5s)");
      }
    } catch (error: any) {
      console.warn(
        `[Builder] Could not confirm user tx within timeout: ${error.message}`
      );
    }

    return {
      success: true,
      l1TxHash: txResponse.hash,
      executionsLoaded: plan.executions.length,
      ...(stateRoot ? { stateRoot } : {}),
    };
  }

  /**
   * Handle L1→L2 call preparation
   * This is the "hint" API - user tells us about upcoming L1→L2 call
   */
  private async handlePrepareL1Call(
    request: PrepareL1CallRequest
  ): Promise<PrepareL1CallResponse> {
    const { l2Target, value, data, sourceAddress } = request;

    console.log(`[Builder] Preparing L1→L2 call:`);
    console.log(`  Source: ${sourceAddress}`);
    console.log(`  Target: ${l2Target}`);
    console.log(`  Value: ${value}`);

    try {
      this.prunePrepareL1Cache();

      // Check sync status
      const synced = await this.planner.isFullnodeSynced();
      if (!synced) {
        return {
          success: false,
          error: "Fullnode not synced with L1",
        };
      }

      // Get L1 chain ID for deterministic proxy domain
      const network = await this.l1Provider.getNetwork();
      const l1ChainId = network.chainId;

      // 1. Compute proxy address for the L2 target
      // The proxy represents the L2 target on L1
      const proxyAddress = await this.rollupsContract.computeL2ProxyAddress(
        l2Target,
        this.config.rollupId,  // Target rollup
        l1ChainId              // Domain is L1 chain ID
      );
      console.log(`[Builder] Computed proxy address: ${proxyAddress}`);

      // Compute the L2 sender proxy from the original L1 caller.
      // This is the address used as msg.sender during L2 execution/replay.
      const sourceProxyAddress = await this.rollupsContract.computeL2ProxyAddress(
        sourceAddress,
        this.config.rollupId,
        l1ChainId
      );
      console.log(`[Builder] Computed source proxy: ${sourceProxyAddress}`);

      // Idempotency: if the same request was already prepared at the current
      // L1 state root, reuse it instead of writing another prep tx.
      const rollupData = await this.rollupsContract.rollups(this.config.rollupId);
      const currentL1StateRoot = rollupData.stateRoot as string;
      const prepareCacheKey = this.computePrepareL1CacheKey(request);
      const cached = this.prepareL1Cache.get(prepareCacheKey);
      if (
        cached &&
        cached.stateRoot.toLowerCase() === currentL1StateRoot.toLowerCase()
      ) {
        console.log("[Builder] Reusing cached L1→L2 preparation (same request + state root)");
        return {
          success: true,
          proxyAddress: cached.proxyAddress,
          sourceProxyAddress: cached.sourceProxyAddress,
          proxyDeployed: false,
          executionsLoaded: 0,
          reusedPreparation: true,
        };
      }

      // 2. Check if proxy exists, deploy if not
      const proxyCode = await this.l1Provider.getCode(proxyAddress);
      let proxyDeployed = false;
      if (proxyCode === "0x") {
        console.log("[Builder] Proxy not deployed, deploying...");
        await this.deployProxy(l2Target, this.config.rollupId);
        proxyDeployed = true;
        console.log("[Builder] Proxy deployed");
      } else {
        console.log("[Builder] Proxy already exists");
      }

      // 3. Plan the execution with proper source context
      const plan = await this.planner.planL1ToL2CallWithProxy(
        l2Target,
        data,
        BigInt(value),
        proxyAddress,
        sourceProxyAddress
      );
      console.log(`[Builder] Planned ${plan.executions.length} execution(s)`);

      // Do not load failing plans as "prepared executions" on L1.
      // This prevents spammy PREP txs on repeated invalid attempts.
      const rootExecution = plan.executions[0];
      if (
        rootExecution &&
        rootExecution.nextAction.actionType === ActionType.RESULT &&
        rootExecution.nextAction.failed
      ) {
        const revertData = rootExecution.nextAction.data || "0x";
        throw new Error(
          `L1→L2 simulation failed (revert data: ${revertData}); execution plan was not loaded`
        );
      }

      // 4. Sign the proof
      const proof = await this.proofGenerator.signLoadExecutionsProof(
        plan.executions
      );
      console.log("[Builder] Proof signed");

      // 5. Notify fullnode of executions
      await this.planner.notifyExecutions(plan.executions);
      console.log("[Builder] Fullnode notified");

      // 6. Load executions on L1
      const l1TxHash = await this.loadExecutionsOnL1(plan.executions, proof);
      console.log(`[Builder] Executions loaded on L1: ${l1TxHash}`);

      this.prepareL1Cache.set(prepareCacheKey, {
        stateRoot: currentL1StateRoot,
        proxyAddress,
        sourceProxyAddress,
        createdAtMs: Date.now(),
      });

      return {
        success: true,
        proxyAddress,
        sourceProxyAddress,
        proxyDeployed,
        executionsLoaded: plan.executions.length,
      };
    } catch (error: any) {
      console.error("[Builder] Prepare L1 call error:", error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  private computePrepareL1CacheKey(request: PrepareL1CallRequest): string {
    const normalizedValue = this.normalizeHexNumber(request.value);
    const normalizedData = this.normalizeHexData(request.data);
    return [
      request.sourceAddress.toLowerCase(),
      request.l2Target.toLowerCase(),
      normalizedValue,
      normalizedData,
    ].join("|");
  }

  private normalizeHexNumber(value: string): string {
    try {
      return "0x" + BigInt(value).toString(16);
    } catch {
      return value.toLowerCase();
    }
  }

  private normalizeHexData(data: string): string {
    if (!data) return "0x";
    return data.toLowerCase();
  }

  private prunePrepareL1Cache(): void {
    const now = Date.now();
    for (const [key, value] of this.prepareL1Cache.entries()) {
      if (now - value.createdAtMs > Builder.PREPARE_L1_CACHE_TTL_MS) {
        this.prepareL1Cache.delete(key);
      }
    }
  }

  /**
   * Handle L2→L1 call preparation.
   * This deploys (if needed) the deterministic proxy alias that L2 txs can target.
   */
  private async handlePrepareL2Call(
    request: PrepareL2CallRequest
  ): Promise<PrepareL2CallResponse> {
    const { l1Target, sourceAddress } = request;

    console.log(`[Builder] Preparing L2→L1 call:`);
    console.log(`  L1 target: ${l1Target}`);
    if (sourceAddress) {
      console.log(`  L2 source: ${sourceAddress}`);
    }

    try {
      const synced = await this.planner.isFullnodeSynced();
      if (!synced) {
        return {
          success: false,
          error: "Fullnode not synced with L1",
        };
      }

      const l1ChainId = (await this.l1Provider.getNetwork()).chainId;

      // Alias proxy for L1 target (domain = L1, origin = L1).
      const proxyAddress = await this.rollupsContract.computeL2ProxyAddress(
        l1Target,
        l1ChainId,
        l1ChainId
      );
      console.log(`[Builder] Computed L2→L1 alias proxy: ${proxyAddress}`);

      let proxyDeployed = false;
      const code = await this.l1Provider.getCode(proxyAddress);
      if (code === "0x") {
        console.log("[Builder] Alias proxy not deployed, deploying...");
        const deployedProxy = await this.deployProxy(l1Target, l1ChainId);
        if (deployedProxy.toLowerCase() !== proxyAddress.toLowerCase()) {
          throw new Error(
            `Deployed proxy ${deployedProxy} does not match computed ${proxyAddress}`
          );
        }
        proxyDeployed = true;
        console.log("[Builder] Alias proxy deployed");
      } else {
        console.log("[Builder] Alias proxy already exists");
      }

      let sourceProxyAddress: string | undefined;
      if (sourceAddress) {
        // Caller identity on L1 is derived from (sourceAddress, rollupId).
        sourceProxyAddress = await this.rollupsContract.computeL2ProxyAddress(
          sourceAddress,
          this.config.rollupId,
          l1ChainId
        );
        console.log(
          `[Builder] L1 source proxy for L2 sender ${sourceAddress}: ${sourceProxyAddress}`
        );
      }

      return {
        success: true,
        proxyAddress,
        sourceProxyAddress,
        proxyDeployed,
      };
    } catch (error: any) {
      console.error("[Builder] Prepare L2 call error:", error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Deploy an L2Proxy contract for a given original address
   */
  private async deployProxy(
    originalAddress: string,
    originalRollupId: bigint
  ): Promise<string> {
    const tx = await this.rollupsContract.createL2ProxyContract(
      originalAddress,
      originalRollupId
    );
    const receipt = await tx.wait();

    // Extract proxy address from L2ProxyCreated event
    const iface = this.rollupsContract.interface;
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog(log);
        if (parsed && parsed.name === "L2ProxyCreated") {
          return parsed.args.proxy;
        }
      } catch {
        // Not our event
      }
    }

    throw new Error("L2ProxyCreated event not found in receipt");
  }

  /**
   * Load executions on L1 via Rollups.loadL2Executions
   */
  private async loadExecutionsOnL1(
    executions: Execution[],
    proof: string,
    nonce?: number
  ): Promise<string> {
    // Convert executions to contract format
    const executionsData = executions.map((e) => ({
      stateDeltas: e.stateDeltas.map((d) => ({
        rollupId: d.rollupId,
        currentState: d.currentState,
        newState: d.newState,
        etherDelta: d.etherDelta,
      })),
      actionHash: e.actionHash,
      nextAction: {
        actionType: e.nextAction.actionType,
        rollupId: e.nextAction.rollupId,
        destination: e.nextAction.destination,
        value: e.nextAction.value,
        data: e.nextAction.data,
        failed: e.nextAction.failed,
        sourceAddress: e.nextAction.sourceAddress,
        sourceRollup: e.nextAction.sourceRollup,
        scope: e.nextAction.scope,
      },
    }));

    const txOptions = nonce !== undefined ? { nonce } : {};
    const tx = await this.rollupsContract.loadL2Executions(
      executionsData,
      proof,
      txOptions
    );
    const receipt = await tx.wait();

    return receipt.hash;
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

  const adminPrivateKey = getArg("admin-key");

  const config: BuilderConfig = {
    l1RpcUrl: getArg("l1-rpc", "http://localhost:8545"),
    rollupsAddress: getArg("rollups"),
    adminPrivateKey,
    proofSignerPrivateKey: getArg("proof-key", adminPrivateKey),
    fullnodeRpcUrl: getArg("fullnode", "http://localhost:9550"),
    rollupId: BigInt(getArg("rollup-id", "0")),
    port: parseInt(getArg("port", "3200")),
  };

  const builder = new Builder(config);

  // Handle shutdown
  const shutdown = async () => {
    console.log("\nShutdown signal received");
    await builder.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    await builder.start();
  } catch (error) {
    console.error("Failed to start builder:", error);
    process.exit(1);
  }
}

// Run if executed directly
const isMainModule = process.argv[1]?.endsWith("builder.ts") ||
                     process.argv[1]?.endsWith("builder.js");
if (isMainModule) {
  main().catch(console.error);
}
