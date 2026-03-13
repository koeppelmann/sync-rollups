#!/usr/bin/env node
/**
 * Builder for sync-rollups
 * HTTP API for transaction submission and execution management
 */

import { createServer, IncomingMessage, ServerResponse } from "http";
import { Contract, JsonRpcProvider, Wallet, Transaction, solidityPackedKeccak256, keccak256, toUtf8Bytes } from "ethers";
import { ExecutionPlanner, ExecutionPlannerConfig } from "./execution-planner.js";
import { BundleSubmitter, IL1BundleSubmitter, SEPOLIA_RELAYS } from "./bundle-submitter.js";
import { MockBundleSubmitter } from "./mock-bundle-submitter.js";
import {
  ActionType,
  ExecutionEntry,
  ExecutionPlan,
  Action,
  executionEntryToJson,
  actionToJson,
} from "../reth-fullnode/types.js";

export interface BuilderConfig {
  // L1 connection
  l1RpcUrl: string;
  rollupsAddress: string;
  adminPrivateKey: string;

  // Builder-private fullnode connection (not the public/read-only fullnode)
  fullnodeRpcUrl: string;

  // Proofer URL (separate service that verifies and signs proofs)
  prooferUrl: string;

  // Rollup config
  rollupId: bigint;

  // HTTP server
  port: number;
}

// Rollups contract ABI (functions we call)
const ROLLUPS_ABI = [
  "function postBatch((tuple(uint256 rollupId, bytes32 currentState, bytes32 newState, int256 etherDelta)[] stateDeltas, bytes32 actionHash, tuple(uint8 actionType, uint256 rollupId, address destination, uint256 value, bytes data, bool failed, address sourceAddress, uint256 sourceRollup, uint256[] scope) nextAction)[] entries, uint256 blobCount, bytes callData, bytes proof)",
  "function executeL2TX(uint256 rollupId, bytes rlpEncodedTx) returns (bytes)",
  "function rollups(uint256) view returns (address owner, bytes32 verificationKey, bytes32 stateRoot, uint256 etherBalance)",
  "function computeCrossChainProxyAddress(address originalAddress, uint256 originalRollupId, uint256 domain) view returns (address)",
  "function createCrossChainProxy(address originalAddress, uint256 originalRollupId) returns (address)",
  "function authorizedProxies(address) view returns (address originalAddress, uint64 originalRollupId)",
  "function setStateByOwner(uint256 rollupId, bytes32 newStateRoot)",
  "event L2ExecutionPerformed(uint256 indexed rollupId, bytes32 currentState, bytes32 newState)",
  "event CrossChainProxyCreated(address indexed proxy, address indexed originalAddress, uint256 indexed originalRollupId)",
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
  l2TxHash?: string;   // Hash of the user's L2 transaction (for L2 proxy to return to ethers)
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
  deferMine?: boolean;   // If true (Anvil only): send postBatch but don't mine. Caller must mine.
}

interface PrepareL1CallResponse {
  success: boolean;
  proxyAddress?: string;     // CrossChainProxy address user should call on L1
  sourceProxyAddress?: string; // L2 sender proxy derived from original L1 caller
  proxyDeployed?: boolean;   // Whether proxy was newly deployed
  executionsLoaded?: number; // Number of executions pre-loaded
  postBatchTxHash?: string;  // When deferMine=true: the pending postBatch tx hash
  reusedPreparation?: boolean; // Whether an existing prep was reused
  error?: string;
}

interface RegisterL2HintRequest {
  l1Target: string;      // Target contract address on L1
}

interface RegisterL2HintResponse {
  success: boolean;
  proxyAddress?: string;      // Deterministic L2 proxy address user should call
  error?: string;
}

export class Builder {
  private config: BuilderConfig;
  private planner: ExecutionPlanner;
  private l1Provider: JsonRpcProvider;
  private adminWallet: Wallet;
  /** Secondary wallet for proxy calls on non-Anvil chains. Using a different
   *  sender ensures postBatch (admin) and proxy call (proxyCaller) can land in
   *  the same block even when validators only include one tx per sender per block. */
  private proxyCallerWallet: Wallet;
  private rollupsContract: Contract;
  private server: ReturnType<typeof createServer> | null = null;
  private isAnvilL1 = false; // Detected at startup
  private l1ChainId = 0n;
  private bundleSubmitter: IL1BundleSubmitter | null = null;
  // Anvil allows 30M gas per block; real chains like Gnosis have lower limits (17M)
  private postBatchGasLimit = 30_000_000n;
  private execL2TXGasLimit = 1_000_000n;
  private operatorAddress = ""; // Derived at startup, used to reject operator-signed L2TXs
  private operatorKey = ""; // Derived at startup, used for L2 proxy deploys
  private readonly prepareL1Cache = new Map<string, {
    stateRoot: string;
    proxyAddress: string;
    sourceProxyAddress: string;
    createdAtMs: number;
  }>();
  private static readonly PREPARE_L1_CACHE_TTL_MS = 10 * 60 * 1000;

  /** Recent L1→L2 calls that the proofer may need as hints to advance its EVM state.
   *  Stored after successful L1→L2 call submission and cleared once used as hints. */
  private recentL1ToL2Hints: Array<{
    action: any;
    timestamp: number;
    sourceProxy: string;
  }> = [];

  /** L2→L1 hint table: maps L2 proxy address (lowercase) → L1 target address.
   *  Populated via POST /register-l2-hint. Used to detect L2→L1 calls during
   *  L2 tx processing without needing the proxy to be deployed yet. */
  private l2HintTable = new Map<string, string>();

  /** Cached L2 chain ID, set during start() */
  private l2ChainId = 0n;

  constructor(config: BuilderConfig) {
    this.config = config;

    // Initialize providers (disable batching to avoid rate limits on public RPCs)
    this.l1Provider = new JsonRpcProvider(config.l1RpcUrl, undefined, { batchMaxCount: 1 });
    this.adminWallet = new Wallet(config.adminPrivateKey, this.l1Provider);

    // Derive a secondary wallet for proxy calls (different sender for same-block inclusion)
    const proxyCallerKey = keccak256(toUtf8Bytes("sync-rollups-proxy-caller:" + config.adminPrivateKey));
    this.proxyCallerWallet = new Wallet(proxyCallerKey, this.l1Provider);

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
      rollupsAddress: config.rollupsAddress,
    };
    this.planner = new ExecutionPlanner(plannerConfig);
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
    console.log(`Proxy caller: ${this.proxyCallerWallet.address}`);
    console.log(`Proofer: ${this.config.prooferUrl}`);
    console.log("");

    // Derive operator address to reject user txs from it
    // Uses L2 chain ID (same as genesis derivation), queried from the fullnode's reth
    const fullnodeProvider = new JsonRpcProvider(this.config.fullnodeRpcUrl);
    const l2ChainId = (await fullnodeProvider.send("eth_chainId", []));
    this.operatorKey = solidityPackedKeccak256(
      ["string", "address", "uint256", "uint256"],
      ["sync-rollups-operator", this.config.rollupsAddress, this.config.rollupId, BigInt(l2ChainId)]
    );
    this.operatorAddress = new Wallet(this.operatorKey).address.toLowerCase();
    this.l2ChainId = BigInt(l2ChainId);
    console.log(`[Builder] Operator address: ${this.operatorAddress} (L2TXs from this address will be rejected)`);

    // Detect whether L1 is Anvil (supports evm_* methods) or a real chain
    try {
      await this.l1Provider.send("evm_setAutomine", [true]);
      this.isAnvilL1 = true;
      this.postBatchGasLimit = 30_000_000n;
      const network = await this.l1Provider.getNetwork();
      this.l1ChainId = network.chainId;
      this.bundleSubmitter = new MockBundleSubmitter(this.l1Provider);
      console.log("[Builder] L1 type: Anvil (MockBundleSubmitter, deterministic timestamp control)");
    } catch {
      this.isAnvilL1 = false;
      // Real chains have lower block gas limits (Gnosis: 17M, Ethereum: 30M)
      // postBatch typically uses <500K gas; keep limit reasonable for block inclusion
      this.postBatchGasLimit = 2_000_000n;

      // Detect Ethereum mainnet/Sepolia for Flashbots bundle submission
      const network = await this.l1Provider.getNetwork();
      this.l1ChainId = network.chainId;
      if (this.l1ChainId === 1n) {
        this.bundleSubmitter = new BundleSubmitter(this.adminWallet);
        console.log("[Builder] L1 type: Ethereum mainnet (Flashbots bundle submission)");
      } else if (this.l1ChainId === 11155111n) {
        // Sepolia: Flashbots relay is unreliable, use priority-fee based ordering instead
        this.postBatchGasLimit = 5_000_000n;
        console.log("[Builder] L1 type: Sepolia testnet (priority fee ordering, 12s slots)");
      } else if (this.l1ChainId === 10200n) {
        // Gnosis Chiado testnet: no bundle submission (Chiado builder unreliable).
        // Uses direct mempool submission with priority-fee ordering (5s slots).
        this.postBatchGasLimit = 2_000_000n;
        console.log("[Builder] L1 type: Chiado testnet (direct submission, 5s slots)");
      } else if (this.l1ChainId === 100n) {
        // Gnosis mainnet
        this.postBatchGasLimit = 5_000_000n;
        console.log("[Builder] L1 type: Gnosis mainnet (direct submission, 5s slots)");
      } else {
        console.log("[Builder] L1 type: real chain (anticipated timestamp mode)");
      }
    }

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
        console.log("  POST /submit-batch     - Submit batch of L2 transactions");
        console.log("  POST /prepare-l1-call  - Prepare L1→L2 call");
        console.log("  POST /register-l2-hint - Register L2→L1 hint (returns proxy address)");
        console.log("  GET  /status           - Get builder status");

        // On real chains, state correction is done inline before each postBatch.
        // The background loop was removed because it creates StateUpdated events
        // that confuse fullnodes (false reorgs, state divergence, invalidated entries).
        // See correctTimestampIfNeeded() for post-L2TX timestamp correction.

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
      } else if (url.pathname === "/submit-batch" && req.method === "POST") {
        let body = "";
        for await (const chunk of req) {
          body += chunk;
        }

        const request = JSON.parse(body);
        const response = await this.processL2Batch(request.transactions);

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
      } else if (url.pathname === "/register-l2-hint" && req.method === "POST") {
        // Read body
        let body = "";
        for await (const chunk of req) {
          body += chunk;
        }

        const request: RegisterL2HintRequest = JSON.parse(body);
        const response = await this.handleRegisterL2Hint(request);

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
    // Use tracked-state sync check (not EVM state) to avoid false "not synced"
    // during L1→L2 call preparation when the builder's L2 EVM is temporarily ahead.
    const synced = await this.planner.isTrackedStateSynced();
    const states = await this.planner.getStates();

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

    // Check sync status (tracked state only — not the EVM state check).
    // The builder's L2 EVM may be temporarily ahead during L1→L2 call preparation.
    // See isTrackedStateSynced() for details.
    const synced = await this.planner.isTrackedStateSynced();
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

    // Reject transactions signed by the operator — operator may only do system calls
    if (tx.from && tx.from.toLowerCase() === this.operatorAddress) {
      console.log(`[Builder] REJECTED: L2TX from operator address ${tx.from}`);
      return {
        success: false,
        error: "Transactions from the operator address are not allowed. The operator is reserved for system calls only.",
      };
    }

    const l1ChainId = (await this.l1Provider.getNetwork()).chainId;

    let execReceiptHash: string;
    let entryCount = 0;

    // Check hint table for L2→L1 call detection.
    // If tx.to matches a registered hint, this is an L2→L1 call.
    let l2ToL1Target: string | null = null;
    if (tx.to) {
      l2ToL1Target = this.l2HintTable.get(tx.to.toLowerCase()) || null;
      if (l2ToL1Target) {
        console.log(`[Builder] Hint table match: ${tx.to} → L1 target ${l2ToL1Target}`);
      }
    }

    // On non-Anvil chains: ensure builder EVM state matches tracked state before
    // planning. The EVM may be ahead due to a persisted simulation from a previous
    // tx (success path keeps simulation state for event processor to reuse).
    // If EVM != tracked, roll back so we simulate from the correct base state.
    let needsStateCorrection = false;
    let correctionTargetState = "";
    if (!this.isAnvilL1) {
      const fullnodeRpc0 = new JsonRpcProvider(this.config.fullnodeRpcUrl);
      const evmState = await fullnodeRpc0.send("syncrollups_getActualStateRoot", []);
      const trackedState = await fullnodeRpc0.send("syncrollups_getStateRoot", []);
      if (evmState !== trackedState) {
        // EVM is ahead (simulation blocks persisted). Roll back to the L2 block
        // that corresponds to the tracked state.
        const trackedL2BlockHex = await fullnodeRpc0.send("syncrollups_getTrackedL2Block", []);
        const trackedL2Block = parseInt(trackedL2BlockHex, 16);
        console.log(`[Builder] EVM state ${evmState.slice(0, 14)}... ahead of tracked ${trackedState.slice(0, 14)}..., rolling back to L2 block ${trackedL2Block}`);
        try {
          await fullnodeRpc0.send("syncrollups_revertToSnapshot", [`0x${trackedL2Block.toString(16)}`]);
        } catch {
          // Rollback may fail (e.g. undershoot). Wait for event processor to fix.
        }
        // Wait for reth to restart and EVM to match tracked state.
        // On undershoot, the event processor will re-mine missing blocks.
        for (let i = 0; i < 60; i++) {
          await new Promise(r => setTimeout(r, 2000));
          try {
            const newRpc = new JsonRpcProvider(this.config.fullnodeRpcUrl);
            const newEvm = await newRpc.send("syncrollups_getActualStateRoot", []);
            if (newEvm === trackedState) {
              console.log(`[Builder] EVM rolled back to tracked state`);
              break;
            }
            // Also re-read tracked state since event processor may have re-synced
            const newTracked = await newRpc.send("syncrollups_getStateRoot", []);
            if (newEvm === newTracked) {
              console.log(`[Builder] EVM matches tracked after event processor re-sync`);
              break;
            }
          } catch {
            // reth restarting
          }
        }
      }
      // Now check if L1 state differs from tracked state (needs setStateByOwner correction)
      const preRollup = await this.rollupsContract.rollups(this.config.rollupId);
      if (trackedState !== preRollup.stateRoot) {
        console.log(`[Builder] State correction needed: L1=${preRollup.stateRoot.slice(0, 12)}... vs tracked=${trackedState.slice(0, 12)}... (will submit with batch)`);
        needsStateCorrection = true;
        correctionTargetState = trackedState;
      }
    }

    // On non-Anvil chains, take a snapshot before simulation so we can roll back
    // if the proofer rejects or any subsequent step fails.
    let snapshotBlock: number | null = null;
    if (!this.isAnvilL1) {
      const fullnodeRpc = new JsonRpcProvider(this.config.fullnodeRpcUrl);
      const blockHex = await fullnodeRpc.send("eth_blockNumber", []);
      snapshotBlock = parseInt(blockHex, 16);
    }
    try {
      // Choose the simulation timestamp (Anvil: deterministic; real chain: anticipated)
      const simTimestamp = await this.chooseSimTimestamp();
      console.log(`[Builder] Simulation timestamp: ${simTimestamp}`);

      let plan: ExecutionPlan;
      // Signed proxy deploy tx (if L2→L1 and proxy not yet deployed)
      let proxyDeploySignedTx: string | undefined;
      if (l2ToL1Target) {
        if (!tx.from) {
          throw new Error("Signed L2 tx has no sender address");
        }

        // Check if the L2 proxy already exists (may have been deployed in a previous call)
        const fullnodeRpc = new JsonRpcProvider(this.config.fullnodeRpcUrl);
        const proxyCode = await fullnodeRpc.send("eth_getCode", [tx.to!, "latest"]);
        if (proxyCode === "0x" || proxyCode === "0x0") {
          // Proxy not deployed — sign a deploy tx from the builder's L2 EOA.
          // This is a regular L2 tx calling CrossChainManagerL2.createCrossChainProxy().
          const { Interface } = await import("ethers");
          const managerIface = new Interface([
            "function createCrossChainProxy(address originalAddress, uint256 originalRollupId) returns (address)",
          ]);
          const deployCalldata = managerIface.encodeFunctionData("createCrossChainProxy", [
            l2ToL1Target, 0n, // originalRollupId=0 for L1 target
          ]);

          // Use admin key for L2 proxy deploys. Do NOT use operator key — the
          // operator nonce is managed by syncrollups_sendSystemTx and will get out
          // of sync if a regular L2TX from the operator is mined.
          const l2Wallet = new Wallet(this.config.adminPrivateKey, fullnodeRpc);
          const l2Nonce = await fullnodeRpc.send("eth_getTransactionCount", [l2Wallet.address, "latest"]);

          // Compute next base fee for the deploy tx
          const latestBlock = await fullnodeRpc.send("eth_getBlockByNumber", ["latest", false]);
          const parentBaseFee = BigInt(latestBlock.baseFeePerGas);
          const parentGasUsed = BigInt(latestBlock.gasUsed);
          const parentGasLimit = BigInt(latestBlock.gasLimit);
          // Simple EIP-1559 next base fee estimate
          const target = parentGasLimit / 2n;
          let nextBaseFee = parentBaseFee;
          if (parentGasUsed > target) {
            nextBaseFee = parentBaseFee + parentBaseFee * (parentGasUsed - target) / target / 8n;
          } else if (parentGasUsed < target) {
            nextBaseFee = parentBaseFee - parentBaseFee * (target - parentGasUsed) / target / 8n;
          }
          if (nextBaseFee < 1n) nextBaseFee = 1n;

          proxyDeploySignedTx = await l2Wallet.signTransaction({
            to: this.config.rollupsAddress, // CrossChainManagerL2 is at the same address on L2
            data: deployCalldata,
            nonce: parseInt(l2Nonce, 16),
            chainId: this.l2ChainId,
            gasLimit: 500_000,
            maxFeePerGas: nextBaseFee * 2n,
            maxPriorityFeePerGas: 0n,
            type: 2,
            value: 0,
          });
          console.log(`[Builder] Signed L2 proxy deploy tx for ${l2ToL1Target} (from builder EOA ${l2Wallet.address})`);
        } else {
          console.log(`[Builder] L2 proxy already deployed at ${tx.to}`);
        }

        const sourceProxyOnL1 = await this.rollupsContract.computeCrossChainProxyAddress(
          tx.from,
          this.config.rollupId,
          l1ChainId
        );
        console.log(
          `[Builder] L2→L1 call: ${tx.to} → L1 target ${l2ToL1Target}`
        );
        console.log(`[Builder] L1 source proxy for sender ${tx.from}: ${sourceProxyOnL1}`);

        plan = await this.planner.planL2ToL1Call(
          signedTx,
          l2ToL1Target,
          tx.data,
          tx.value,
          tx.from,
          sourceProxyOnL1,
          simTimestamp,
          needsStateCorrection ? correctionTargetState : undefined,
          proxyDeploySignedTx
        );
      } else {
        plan = await this.planner.planL2Transaction(signedTx, simTimestamp, needsStateCorrection ? correctionTargetState : undefined);
      }

      entryCount = plan.entries.length;
      console.log(`[Builder] Planned ${entryCount} execution(s)`);

      // Include any pending L1→L2 hints for the proofer. After an L1→L2 call,
      // the proofer's EVM may be behind due to timestamp mismatch during replay.
      const hintsForProof = this.recentL1ToL2Hints.length > 0
        ? [...this.recentL1ToL2Hints]
        : undefined;
      if (hintsForProof) {
        console.log(`[Builder] Including ${hintsForProof.length} L1→L2 hint(s) for proofer`);
      }

      let proof = await this.requestProof(plan, simTimestamp, undefined, undefined, hintsForProof);
      console.log("[Builder] Proof obtained from proofer");

      // Clear hints after successful proof — proofer is now caught up
      if (hintsForProof) {
        this.recentL1ToL2Hints = [];
      }

      await this.planner.notifyExecutions(plan.entries);
      console.log("[Builder] Fullnode notified");

      let entriesData = plan.entries.map((e) => ({
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

      if (this.bundleSubmitter) {
        // Bundle submission: sign all txs and submit atomically via L1 builder.
        // MockBundleSubmitter (Anvil): automine control + timestamp setting.
        // BundleSubmitter (Flashbots/Titan): atomic bundle targeting next block.
        const feeData = await this.l1Provider.getFeeData();
        const basePriority = (() => { const p = feeData.maxPriorityFeePerGas || 0n; const min = 100_000_000n; return p > min ? p : min; })();
        const baseMaxFee = (() => { const f = (feeData.maxFeePerGas || 1_000_000_000n) * 3n; const min = basePriority * 8n; return f > min ? f : min; })();

        let nonce = await this.adminWallet.getNonce("pending");
        const signedRawTxs: string[] = [];

        if (needsStateCorrection) {
          signedRawTxs.push(await this.signContractTx("setStateByOwner",
            [this.config.rollupId, correctionTargetState],
            { gasLimit: 100_000n, maxFeePerGas: baseMaxFee * 2n, maxPriorityFeePerGas: basePriority * 2n, nonce }
          ));
          nonce++;
          this.lastCorrectedState = correctionTargetState;
        }

        // Deploy L1 alias proxy if needed (for L2→L1 scope resolution)
        if (l2ToL1Target) {
          const l1AliasAddress = await this.rollupsContract.computeCrossChainProxyAddress(
            l2ToL1Target, l1ChainId, l1ChainId
          );
          const l1Code = await this.l1Provider.getCode(l1AliasAddress);
          if (l1Code === "0x") {
            signedRawTxs.push(await this.signContractTx("createCrossChainProxy",
              [l2ToL1Target, l1ChainId],
              { gasLimit: 500_000n, maxFeePerGas: baseMaxFee * 2n, maxPriorityFeePerGas: basePriority * 2n, nonce }
            ));
            nonce++;
          }
        }

        signedRawTxs.push(await this.signContractTx("postBatch",
          [entriesData, 0, "0x", proof],
          { gasLimit: this.postBatchGasLimit, maxFeePerGas: baseMaxFee * 2n, maxPriorityFeePerGas: basePriority * 2n, nonce }
        ));
        nonce++;

        // executeL2TX for proxy deploy tx (if L2→L1 with new proxy)
        if (proxyDeploySignedTx) {
          signedRawTxs.push(await this.signContractTx("executeL2TX",
            [this.config.rollupId, proxyDeploySignedTx],
            { gasLimit: this.execL2TXGasLimit, maxFeePerGas: baseMaxFee * 2n, maxPriorityFeePerGas: basePriority * 2n, nonce }
          ));
          nonce++;
        }

        // executeL2TX for user tx
        signedRawTxs.push(await this.signContractTx("executeL2TX",
          [this.config.rollupId, signedTx],
          { gasLimit: this.execL2TXGasLimit, maxFeePerGas: baseMaxFee * 2n, maxPriorityFeePerGas: basePriority * 2n, nonce }
        ));

        console.log(`[Builder] Bundle: ${signedRawTxs.length} signed txs (nonces ${nonce - signedRawTxs.length + 1}..${nonce})`);

        const currentBlock = await this.l1Provider.getBlockNumber();
        const targetBlock = currentBlock + 1;
        const result = await this.bundleSubmitter.submitAndWait(
          signedRawTxs, targetBlock, this.l1Provider, simTimestamp
        );

        if (!result.included) {
          throw new Error(
            `Bundle not included in block ${targetBlock}. ` +
            `Will retry with new simulation on next attempt.`
          );
        }

        execReceiptHash = result.txHashes[result.txHashes.length - 1];

        // Verify the block timestamp matches our simulation
        const bundleBlock = await this.l1Provider.getBlock(result.blockNumber);
        const actualTs = bundleBlock ? Number(bundleBlock.timestamp) : 0;
        if (actualTs !== simTimestamp) {
          console.warn(
            `[Builder] Bundle landed but timestamp mismatch: expected=${simTimestamp}, actual=${actualTs}`
          );
          await this.correctTimestampIfNeeded(
            { blockNumber: result.blockNumber, hash: execReceiptHash } as any,
            simTimestamp,
            [signedTx]
          );
        } else {
          console.log(`[Builder] Bundle included in block ${result.blockNumber} at t=${actualTs}`);
        }
      } else {
        // Beacon chain (Gnosis/other): submit all txs simultaneously to land in
        // the same next block. If state correction is needed, it's included as the
        // first tx (highest priority fee), followed by postBatch, then executeL2TX.
        //
        // Wait ~1 second into the current slot so we have a reliable prediction
        // of the next block's timestamp, then send all txs at once.
        const nextSlotTs = await this.waitForNextSlot();
        if (nextSlotTs !== simTimestamp) {
          console.log(
            `[Builder] Re-targeting: simTimestamp ${simTimestamp} → slot ${nextSlotTs} ` +
            `(${nextSlotTs - simTimestamp}s drift from sim+proof overhead)`
          );
        }

        const feeData = await this.l1Provider.getFeeData();
        const basePriority = (() => { const p = feeData.maxPriorityFeePerGas || 0n; const min = 100_000_000n; return p > min ? p : min; })();
        const baseMaxFee = (() => { const f = (feeData.maxFeePerGas || 1_000_000_000n) * 3n; const min = basePriority * 8n; return f > min ? f : min; })();

        // Fund proxy caller wallet BEFORE signing anything (executeL2TX uses it)
        // May need 2 executeL2TX calls for L2→L1 (proxy deploy + user tx)
        const execCallerBalance = await this.l1Provider.getBalance(this.proxyCallerWallet.address);
        const execTxCount = proxyDeploySignedTx ? 2n : 1n;
        const execMinBalance = baseMaxFee * 2n * BigInt(this.execL2TXGasLimit) * execTxCount;
        if (execCallerBalance < execMinBalance) {
          const fundAmount = execMinBalance * 2n - execCallerBalance;
          console.log(`[Builder] Funding proxy caller for executeL2TX: ${fundAmount} wei`);
          const fundTx = await this.adminWallet.sendTransaction({
            to: this.proxyCallerWallet.address,
            value: fundAmount,
            gasLimit: 21_000n,
            maxFeePerGas: baseMaxFee * 2n,
            maxPriorityFeePerGas: basePriority * 3n,
          });
          await fundTx.wait();
          console.log(`[Builder] Proxy caller funded: ${fundTx.hash}`);
        }

        // Pre-sign all transactions, then broadcast simultaneously for same-block inclusion.
        // Fetch nonces AFTER any funding tx is mined.
        let nonce = await this.adminWallet.getNonce("latest");
        const signedRawTxs: string[] = [];

        // State correction (if needed): highest priority fee → ordered first
        if (needsStateCorrection) {
          signedRawTxs.push(await this.signContractTx("setStateByOwner",
            [this.config.rollupId, correctionTargetState],
            { gasLimit: 100_000n, maxFeePerGas: baseMaxFee * 2n, maxPriorityFeePerGas: basePriority * 5n, nonce }
          ));
          console.log(`[Builder] Signed setStateByOwner (nonce=${nonce})`);
          nonce++;
          this.lastCorrectedState = correctionTargetState;
        }

        // Deploy L1 alias proxy if needed (for L2→L1 scope resolution)
        if (l2ToL1Target) {
          const l1AliasAddress = await this.rollupsContract.computeCrossChainProxyAddress(
            l2ToL1Target, l1ChainId, l1ChainId
          );
          const l1Code = await this.l1Provider.getCode(l1AliasAddress);
          if (l1Code === "0x") {
            signedRawTxs.push(await this.signContractTx("createCrossChainProxy",
              [l2ToL1Target, l1ChainId],
              { gasLimit: 500_000n, maxFeePerGas: baseMaxFee * 2n, maxPriorityFeePerGas: basePriority * 4n, nonce }
            ));
            console.log(`[Builder] Signed createCrossChainProxy for L1 alias (nonce=${nonce})`);
            nonce++;
          }
        }

        // postBatch: high priority fee → ordered after correction
        signedRawTxs.push(await this.signContractTx("postBatch",
          [entriesData, 0, "0x", proof],
          { gasLimit: this.postBatchGasLimit, maxFeePerGas: baseMaxFee * 2n, maxPriorityFeePerGas: basePriority * 3n, nonce }
        ));
        const postBatchNonce = nonce;

        // executeL2TX calls: signed by proxy caller wallet (different sender)
        const rollupsAddr = await this.rollupsContract.getAddress();
        const rollupsIface = this.rollupsContract.interface;
        let execNonce = await this.proxyCallerWallet.getNonce("latest");

        // executeL2TX for proxy deploy tx (if L2→L1 with new proxy)
        if (proxyDeploySignedTx) {
          const deployExecCalldata = rollupsIface.encodeFunctionData("executeL2TX", [this.config.rollupId, proxyDeploySignedTx]);
          signedRawTxs.push(await this.proxyCallerWallet.signTransaction({
            to: rollupsAddr,
            data: deployExecCalldata,
            gasLimit: this.execL2TXGasLimit,
            maxFeePerGas: baseMaxFee * 2n,
            maxPriorityFeePerGas: basePriority * 2n, // Higher priority than user's executeL2TX
            nonce: execNonce,
            chainId: this.l1ChainId,
            type: 2,
          }));
          execNonce++;
        }

        // executeL2TX for user tx
        const execCalldata = rollupsIface.encodeFunctionData("executeL2TX", [this.config.rollupId, signedTx]);
        signedRawTxs.push(await this.proxyCallerWallet.signTransaction({
          to: rollupsAddr,
          data: execCalldata,
          gasLimit: this.execL2TXGasLimit,
          maxFeePerGas: baseMaxFee * 2n,
          maxPriorityFeePerGas: basePriority,
          nonce: execNonce,
          chainId: this.l1ChainId,
          type: 2,
        }));

        // Broadcast all simultaneously
        console.log(`[Builder] Broadcasting ${signedRawTxs.length} txs simultaneously...`);
        const broadcastPromises = signedRawTxs.map((raw, i) =>
          this.l1Provider.broadcastTransaction(raw).then(tx => {
            console.log(`[Builder] Tx #${i + 1} broadcast: ${tx.hash}`);
            return tx;
          })
        );
        const txResponses = await Promise.all(broadcastPromises);

        console.log(
          `[Builder] ${signedRawTxs.length} txs broadcast ` +
          `(${needsStateCorrection ? "correction+" : ""}postBatch nonce=${postBatchNonce}, exec from proxy caller nonce=${execNonce})`
        );

        // Wait for all to confirm
        const pendingTxs = txResponses.map(tx => tx.wait());

        // Wait for all to confirm
        const receipts = await Promise.all(pendingTxs);
        const postBatchReceipt = receipts[needsStateCorrection ? 1 : 0];
        const execReceipt = receipts[receipts.length - 1];
        const postBatchTxResponse = txResponses[needsStateCorrection ? 1 : 0];
        console.log(`[Builder] Executions loaded: ${postBatchTxResponse.hash}`);
        execReceiptHash = execReceipt!.hash;

        // Verify both landed in the same block with the expected timestamp
        if (postBatchReceipt!.blockNumber !== execReceipt!.blockNumber) {
          console.warn(
            `[Builder] WARNING: postBatch and executeL2TX landed in different blocks ` +
            `(${postBatchReceipt!.blockNumber} vs ${execReceipt!.blockNumber}). ` +
            `Timestamp correction may be needed.`
          );
          await this.correctTimestampIfNeeded(execReceipt, simTimestamp, [signedTx]);
        } else {
          // Same block — verify timestamp matches
          const actualBlock = await this.l1Provider.getBlock(execReceipt!.blockNumber);
          const actualTs = actualBlock ? Number(actualBlock.timestamp) : 0;
          if (actualTs !== simTimestamp) {
            console.warn(
              `[Builder] Timestamp mismatch: expected=${simTimestamp}, actual=${actualTs}. ` +
              `Tx landed in wrong slot.`
            );
            await this.correctTimestampIfNeeded(execReceipt, simTimestamp, [signedTx]);
          } else {
            console.log(`[Builder] Timestamp matches! Both txs in block ${execReceipt!.blockNumber} at t=${actualTs}`);
          }
        }
      }
      console.log(`[Builder] L2TX executed: ${execReceiptHash}`);
      snapshotBlock = null; // Success — no rollback needed
    } catch (e) {
      // On non-Anvil chains, roll back the builder's L2 to undo the simulation.
      // The fullnode may be mid-rollback (event processor handling timestamp correction),
      // so retry with backoff until reth is available.
      if (snapshotBlock !== null) {
        console.log(`[Builder] Rolling back builder L2 to block ${snapshotBlock} after failure`);
        for (let attempt = 0; attempt < 15; attempt++) {
          try {
            const fullnodeRpc = new JsonRpcProvider(this.config.fullnodeRpcUrl);
            await fullnodeRpc.send("syncrollups_revertToSnapshot", [snapshotBlock]);
            break;
          } catch (rollbackErr: any) {
            if (attempt < 14 && (rollbackErr.message?.includes("not initialized") || rollbackErr.message?.includes("ECONNREFUSED"))) {
              await new Promise(r => setTimeout(r, 2000));
              continue;
            }
            console.warn(`[Builder] Rollback failed: ${rollbackErr.message}`);
            break;
          }
        }
      }
      throw e;
    }

    // Get new state
    const rollupData = await this.rollupsContract.rollups(this.config.rollupId);

    // Compute the L2 tx hash from the signed transaction — this is what ethers
    // expects as the result of eth_sendRawTransaction on the L2 proxy.
    const l2TxHash = Transaction.from(signedTx).hash;

    return {
      success: true,
      l1TxHash: execReceiptHash,
      l2TxHash: l2TxHash || undefined,
      executionsLoaded: entryCount,
      stateRoot: rollupData.stateRoot,
    };
  }

  /**
   * Process a batch of L2 transactions — all included in a single L2 block.
   * Posts one batch with all entries, then executes all L2TXs in one L1 block.
   */
  private async processL2Batch(signedTxs: string[]): Promise<SubmitResponse> {
    console.log(`[Builder] Processing L2 batch of ${signedTxs.length} transactions...`);

    // Reject any batch containing operator-signed transactions
    for (const stx of signedTxs) {
      const tx = Transaction.from(stx);
      if (tx.from && tx.from.toLowerCase() === this.operatorAddress) {
        console.log(`[Builder] REJECTED batch: contains L2TX from operator address ${tx.from}`);
        return {
          success: false,
          error: "Transactions from the operator address are not allowed. The operator is reserved for system calls only.",
        };
      }
    }

    // Choose timestamp for deterministic state roots
    const simTimestamp = await this.chooseSimTimestamp();
    console.log(`[Builder] Batch simulation timestamp: ${simTimestamp}`);

    // Plan all transactions (simulation uses the chosen timestamp)
    const plan = await this.planner.planL2Batch(signedTxs, simTimestamp);
    console.log(`[Builder] Planned ${plan.entries.length} execution entries`);

    // Request proof from proofer (with batch txs for verification)
    const proof = await this.requestProof(plan, simTimestamp, signedTxs);

    // Notify fullnode
    await this.planner.notifyExecutions(plan.entries);

    const entriesData = plan.entries.map((e) => ({
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

    if (this.bundleSubmitter) {
      // Bundle submission: [postBatch, executeL2TX, ...] atomically.
      const feeData = await this.l1Provider.getFeeData();
      const basePriority = (() => { const p = feeData.maxPriorityFeePerGas || 0n; const min = 100_000_000n; return p > min ? p : min; })();
      const baseMaxFee = (() => { const f = (feeData.maxFeePerGas || 1_000_000_000n) * 3n; const min = basePriority * 8n; return f > min ? f : min; })();

      let nonce = await this.adminWallet.getNonce("pending");
      const signedRawTxs: string[] = [];

      signedRawTxs.push(await this.signContractTx("postBatch",
        [entriesData, 0, "0x", proof],
        { gasLimit: this.postBatchGasLimit, maxFeePerGas: baseMaxFee * 2n, maxPriorityFeePerGas: basePriority * 2n, nonce }
      ));
      nonce++;

      for (const signedTx of signedTxs) {
        signedRawTxs.push(await this.signContractTx("executeL2TX",
          [this.config.rollupId, signedTx],
          { gasLimit: this.execL2TXGasLimit, maxFeePerGas: baseMaxFee * 2n, maxPriorityFeePerGas: basePriority * 2n, nonce }
        ));
        nonce++;
      }

      console.log(`[Builder] Bundle: postBatch + ${signedTxs.length} L2TXs (nonces ${nonce - signedRawTxs.length}..${nonce - 1})`);

      const currentBlock = await this.l1Provider.getBlockNumber();
      const targetBlock = currentBlock + 1;
      const result = await this.bundleSubmitter.submitAndWait(
        signedRawTxs, targetBlock, this.l1Provider, simTimestamp
      );

      if (!result.included) {
        throw new Error(`Batch bundle not included in block ${targetBlock}.`);
      }

      console.log(`[Builder] Batch executed in block ${result.blockNumber}, ${signedTxs.length} L2TXs`);

      // Verify timestamp
      const bundleBlock = await this.l1Provider.getBlock(result.blockNumber);
      const actualTs = bundleBlock ? Number(bundleBlock.timestamp) : 0;
      if (actualTs !== simTimestamp) {
        console.warn(`[Builder] Batch timestamp mismatch: expected=${simTimestamp}, actual=${actualTs}`);
        await this.correctTimestampIfNeeded(
          { blockNumber: result.blockNumber, hash: result.txHashes[result.txHashes.length - 1] } as any,
          simTimestamp,
          signedTxs
        );
      }

      const rollupData = await this.rollupsContract.rollups(this.config.rollupId);

      return {
        success: true,
        l1TxHash: result.txHashes[result.txHashes.length - 1],
        executionsLoaded: plan.entries.length,
        stateRoot: rollupData.stateRoot,
      };
    } else {
      // Beacon chain: wait for the right slot, then submit all txs simultaneously.
      const nextSlotTs = await this.waitForNextSlot();
      if (nextSlotTs !== simTimestamp) {
        console.log(
          `[Builder] Batch re-targeting: simTimestamp ${simTimestamp} → slot ${nextSlotTs}`
        );
      }

      const feeData = await this.l1Provider.getFeeData();
      const baseMaxFee = (() => { const f = feeData.maxFeePerGas || 0n; return f > 10_000_000_000n ? f : 10_000_000_000n; })();
      const basePriority = (() => { const p = feeData.maxPriorityFeePerGas || 0n; return p > 1_000_000_000n ? p : 1_000_000_000n; })();

      let nonce = await this.adminWallet.getNonce("pending");

      // postBatch: highest priority fee → ordered first
      const loadTx = await this.rollupsContract.postBatch(
        entriesData, 0, "0x", proof,
        {
          gasLimit: this.postBatchGasLimit,
          maxFeePerGas: baseMaxFee * 2n,
          maxPriorityFeePerGas: basePriority * 3n,
          nonce,
        }
      );
      nonce++;

      const execTxs = [];
      for (const signedTx of signedTxs) {
        const execTx = await this.rollupsContract.executeL2TX(
          this.config.rollupId, signedTx,
          {
            gasLimit: this.execL2TXGasLimit,
            maxFeePerGas: baseMaxFee * 2n,
            maxPriorityFeePerGas: basePriority,
            nonce,
          }
        );
        execTxs.push(execTx);
        nonce++;
      }

      console.log(`[Builder] Batch submitted: postBatch + ${signedTxs.length} L2TXs (simultaneous)`);

      // Wait for all to confirm
      const allReceipts = await Promise.all([
        loadTx.wait(),
        ...execTxs.map(tx => tx.wait()),
      ]);
      const lastReceipt = allReceipts[allReceipts.length - 1];

      // Check timestamp correctness
      const actualBlock = await this.l1Provider.getBlock(lastReceipt!.blockNumber);
      const actualTs = actualBlock ? Number(actualBlock.timestamp) : 0;
      if (actualTs !== simTimestamp) {
        console.warn(`[Builder] Batch timestamp mismatch: expected=${simTimestamp}, actual=${actualTs}`);
        await this.correctTimestampIfNeeded(lastReceipt, simTimestamp, signedTxs);
      }

      console.log(`[Builder] Batch executed, ${signedTxs.length} L2TXs`);

      const rollupData = await this.rollupsContract.rollups(this.config.rollupId);

      return {
        success: true,
        l1TxHash: lastReceipt!.hash,
        executionsLoaded: plan.entries.length,
        stateRoot: rollupData.stateRoot,
      };
    }
  }

  /**
   * Resolve whether an L2 tx destination is a prepared proxy representing an L1 target.
   * Checks the L2 EVM for the proxy contract's ORIGINAL_ADDRESS and ORIGINAL_ROLLUP_ID.
   * A proxy is L2→L1 if ORIGINAL_ROLLUP_ID == 0 (MAINNET_ROLLUP_ID, representing L1).
   */
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

    // Get L1 chain ID for proxy address computation
    const network = await this.l1Provider.getNetwork();
    const l1ChainId = network.chainId;

    // Check if the target proxy exists
    const proxyAddress = await this.rollupsContract.computeCrossChainProxyAddress(
      l2Target,
      this.config.rollupId,
      l1ChainId
    );
    const proxyCode = await this.l1Provider.getCode(proxyAddress);
    const needsProxyDeploy = proxyCode === "0x";
    if (needsProxyDeploy) {
      console.log(`[Builder] Proxy ${proxyAddress} not deployed, will include in bundle`);
    } else {
      console.log(`[Builder] Proxy ${proxyAddress} already deployed`);
    }

    // Compute the source proxy (for L2 replay: msg.sender during L2 execution)
    const sourceAddress = tx.from || this.adminWallet.address;
    const sourceProxyAddress = await this.rollupsContract.computeCrossChainProxyAddress(
      sourceAddress,
      this.config.rollupId,
      l1ChainId
    );

    // Retry loop: simulate → proof → bundle. If proofer is out of sync or
    // bundle misses, roll back L2, wait, and retry with fresh simulation/timestamp.
    const MAX_L1_TX_ATTEMPTS = 5;
    for (let attempt = 1; attempt <= MAX_L1_TX_ATTEMPTS; attempt++) {
      console.log(`[Builder] L1→L2 attempt ${attempt}/${MAX_L1_TX_ATTEMPTS}`);

      // Snapshot builder's L2 before simulation so we can roll back on failure
      const fullnodeRpc = new JsonRpcProvider(this.config.fullnodeRpcUrl);
      const snapshotBlockHex = await fullnodeRpc.send("eth_blockNumber", []);
      const snapshotBlock = parseInt(snapshotBlockHex, 16);

      // Choose simulation timestamp (fresh each attempt)
      const simTimestamp = await this.chooseSimTimestamp();
      console.log(`[Builder] L1→L2 simulation timestamp: ${simTimestamp}`);

      // Query the proxy's actual originalRollupId
      let proxyRollupId = this.config.rollupId;
      if (!needsProxyDeploy) {
        const proxyInfo = await this.rollupsContract.authorizedProxies(proxyAddress);
        proxyRollupId = BigInt(proxyInfo.originalRollupId);
      }

      // Plan the L1->L2 call execution
      const plan = await this.planner.planL1ToL2CallWithProxy(
        l2Target,
        tx.data,
        tx.value,
        proxyAddress,
        sourceProxyAddress,
        sourceAddress,
        simTimestamp,
        undefined,     // overrideCurrentState
        proxyRollupId
      );
      console.log(`[Builder] Planned ${plan.entries.length} execution(s)`);

      // Check for simulation failure (not retryable)
      const rootExecution = plan.entries[0];
      if (
        rootExecution &&
        rootExecution.nextAction.actionType === ActionType.RESULT &&
        rootExecution.nextAction.failed
      ) {
        const revertData = rootExecution.nextAction.data || "0x";
        const hint = (revertData === "0x" && tx.value > 0n)
          ? " (target function may not be payable)"
          : "";
        throw new Error(
          `L1→L2 simulation failed (revert data: ${revertData})${hint}`
        );
      }

      // Request proof from proofer (pass sourceProxy for CALL verification)
      let proof: string;
      try {
        proof = await this.requestProof(
          plan,
          simTimestamp,
          undefined,
          [sourceProxyAddress]
        );
        console.log("[Builder] Proof obtained from proofer");
      } catch (proofErr: any) {
        // Proofer state mismatch is retryable — roll back L2 and wait for sync
        if (attempt < MAX_L1_TX_ATTEMPTS && (proofErr.message?.includes("State mismatch") || proofErr.message?.includes("state mismatch"))) {
          console.warn(`[Builder] Proofer rejected, rolling back L2 to block ${snapshotBlock}...`);
          try { await fullnodeRpc.send("syncrollups_revertToSnapshot", [snapshotBlock]); } catch {}
          await new Promise(r => setTimeout(r, 15000));
          continue;
        }
        // Non-retryable — still roll back
        try { await fullnodeRpc.send("syncrollups_revertToSnapshot", [snapshotBlock]); } catch {}
        throw proofErr;
      }

      // Notify fullnode
      await this.planner.notifyExecutions(plan.entries);

      // Build entries data for postBatch
      const entriesData = plan.entries.map((e) => ({
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

      if (this.bundleSubmitter) {
        // Bundle submission: [createProxy?, postBatch, userTx] atomically.
        // MockBundleSubmitter (Anvil): automine control + timestamp setting.
        // BundleSubmitter (Flashbots/Titan): atomic bundle targeting next block.
        const feeData = await this.l1Provider.getFeeData();
        const basePriority = (() => { const p = feeData.maxPriorityFeePerGas || 0n; const min = 100_000_000n; return p > min ? p : min; })();
        const baseMaxFee = (() => { const f = (feeData.maxFeePerGas || 1_000_000_000n) * 3n; const min = basePriority * 8n; return f > min ? f : min; })();

        let nonce = await this.adminWallet.getNonce("pending");
        const signedRawTxs: string[] = [];

        // 1. Deploy proxy (if needed)
        if (needsProxyDeploy) {
          signedRawTxs.push(await this.signContractTx("createCrossChainProxy",
            [l2Target, this.config.rollupId],
            { gasLimit: 500_000n, maxFeePerGas: baseMaxFee * 2n, maxPriorityFeePerGas: basePriority * 2n, nonce }
          ));
          console.log(`[Builder] Bundle tx #${signedRawTxs.length}: createCrossChainProxy (nonce=${nonce})`);
          nonce++;
        }

        // 2. Post batch (load execution table)
        signedRawTxs.push(await this.signContractTx("postBatch",
          [entriesData, 0, "0x", proof],
          { gasLimit: this.postBatchGasLimit, maxFeePerGas: baseMaxFee * 2n, maxPriorityFeePerGas: basePriority * 2n, nonce }
        ));
        console.log(`[Builder] Bundle tx #${signedRawTxs.length}: postBatch (nonce=${nonce})`);

        // 3. User's signed transaction (already signed by user)
        signedRawTxs.push(signedTx);
        console.log(`[Builder] Bundle tx #${signedRawTxs.length}: user tx (from ${tx.from})`);

        console.log(`[Builder] Submitting bundle with ${signedRawTxs.length} txs...`);

        const currentBlock = await this.l1Provider.getBlockNumber();
        const targetBlock = currentBlock + 1;
        const result = await this.bundleSubmitter.submitAndWait(
          signedRawTxs, targetBlock, this.l1Provider, simTimestamp
        );

        if (!result.included) {
          if (attempt < MAX_L1_TX_ATTEMPTS) {
            console.warn(`[Builder] Bundle not included in block ${targetBlock}, rolling back L2...`);
            try { await fullnodeRpc.send("syncrollups_revertToSnapshot", [snapshotBlock]); } catch {}
            await new Promise(r => setTimeout(r, 5000));
            continue;
          }
          try { await fullnodeRpc.send("syncrollups_revertToSnapshot", [snapshotBlock]); } catch {}
          throw new Error(
            `Bundle not included after ${MAX_L1_TX_ATTEMPTS} attempts.`
          );
        }

      const userTxHash = Transaction.from(signedTx).hash!;
      console.log(`[Builder] Bundle included in block ${result.blockNumber}`);

      // Get updated state
      let stateRoot: string | undefined;
      try {
        const rollupData = await this.rollupsContract.rollups(this.config.rollupId);
        stateRoot = rollupData.stateRoot;
      } catch {}

      return {
        success: true,
        l1TxHash: userTxHash,
        executionsLoaded: plan.entries.length,
        ...(stateRoot ? { stateRoot } : {}),
      };
    } else {
      // Other beacon chains (Gnosis etc.): deploy proxy, postBatch, broadcast user tx
      if (needsProxyDeploy) {
        await this.deployProxy(l2Target, this.config.rollupId);
        console.log("[Builder] Proxy deployed");
      }

      const loadTxHash = await this.postBatchOnL1(plan.entries, proof);
      console.log(`[Builder] Executions loaded: ${loadTxHash}`);

      const txResponse = await this.l1Provider.broadcastTransaction(signedTx);
      console.log(`[Builder] User transaction broadcast: ${txResponse.hash}`);

      let stateRoot: string | undefined;
      try {
        const receipt = await this.l1Provider.waitForTransaction(txResponse.hash, 1, 5000);
        if (receipt) {
          const rollupData = await this.rollupsContract.rollups(this.config.rollupId);
          stateRoot = rollupData.stateRoot;
        }
      } catch {}

      return {
        success: true,
        l1TxHash: txResponse.hash,
        executionsLoaded: plan.entries.length,
        ...(stateRoot ? { stateRoot } : {}),
      };
    }
    } // end retry loop

    throw new Error(`L1→L2 transaction failed after ${MAX_L1_TX_ATTEMPTS} attempts`);
  }

  /**
   * Handle L1→L2 call preparation
   * This is the "hint" API - user tells us about upcoming L1→L2 call
   */
  private async handlePrepareL1Call(
    request: PrepareL1CallRequest
  ): Promise<PrepareL1CallResponse> {
    const { l2Target, value, data, sourceAddress, deferMine } = request;

    console.log(`[Builder] Preparing L1→L2 call:`);
    console.log(`  Source: ${sourceAddress}`);
    console.log(`  Target: ${l2Target}`);
    console.log(`  Value: ${value}`);

    try {
      this.prunePrepareL1Cache();

      // Check sync status (tracked state only — the builder's L2 EVM may be
      // temporarily ahead from a previous simulateL1ToL2Call pre-execution).
      const synced = await this.planner.isTrackedStateSynced();
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
      const proxyAddress = await this.rollupsContract.computeCrossChainProxyAddress(
        l2Target,
        this.config.rollupId,  // Target rollup
        l1ChainId              // Domain is L1 chain ID
      );
      console.log(`[Builder] Computed proxy address: ${proxyAddress}`);

      // Compute the L2 sender proxy from the original L1 caller.
      // This is the address used as msg.sender during L2 execution/replay.
      const sourceProxyAddress = await this.rollupsContract.computeCrossChainProxyAddress(
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

      // Non-Anvil with bundle submitter: postBatch + proxy call MUST be in the
      // same block (ExecutionNotInCurrentBlock). Use atomic bundle submission:
      // plan → prove → bundle [correction? + postBatch + proxyCall] → submit.
      if (!this.isAnvilL1) {
        console.log("[Builder] Non-Anvil L1→L2 call flow (mempool broadcast)");

        const MAX_PREP_ATTEMPTS = 5;
        for (let attempt = 1; attempt <= MAX_PREP_ATTEMPTS; attempt++) {
          console.log(`[Builder] L1→L2 bundle attempt ${attempt}/${MAX_PREP_ATTEMPTS}`);

          // Snapshot builder's L2 for rollback on failure
          const fullnodeRpc = new JsonRpcProvider(this.config.fullnodeRpcUrl);
          const snapshotBlockHex = await fullnodeRpc.send("eth_blockNumber", []);
          const snapshotBlock = parseInt(snapshotBlockHex, 16);

          // Ensure EVM matches tracked state
          const evmState = await fullnodeRpc.send("syncrollups_getActualStateRoot", []);
          const trackedState = await fullnodeRpc.send("syncrollups_getStateRoot", []);
          if (evmState !== trackedState) {
            const trackedL2BlockHex = await fullnodeRpc.send("syncrollups_getTrackedL2Block", []);
            const trackedL2Block = parseInt(trackedL2BlockHex, 16);
            console.log(`[Builder] EVM ahead of tracked, rolling back to L2 block ${trackedL2Block}`);
            try { await fullnodeRpc.send("syncrollups_revertToSnapshot", [`0x${trackedL2Block.toString(16)}`]); } catch {}
            for (let i = 0; i < 60; i++) {
              await new Promise(r => setTimeout(r, 2000));
              try {
                const newRpc = new JsonRpcProvider(this.config.fullnodeRpcUrl);
                const newEvm = await newRpc.send("syncrollups_getActualStateRoot", []);
                if (newEvm === trackedState) break;
                const newTracked = await newRpc.send("syncrollups_getStateRoot", []);
                if (newEvm === newTracked) break;
              } catch {}
            }
          }

          // Check if state correction is needed
          let needsCorrection = false;
          let correctionTarget = "";
          const currentRollup = await this.rollupsContract.rollups(this.config.rollupId);
          const currentL1State = currentRollup.stateRoot;
          const currentTracked = await fullnodeRpc.send("syncrollups_getStateRoot", []);
          if (currentTracked !== currentL1State) {
            needsCorrection = true;
            correctionTarget = currentTracked;
            console.log(`[Builder] State correction needed: L1=${(currentL1State as string).slice(0, 12)}... vs tracked=${correctionTarget.slice(0, 12)}...`);
          }

          // Choose timestamp
          const simTimestamp = await this.chooseSimTimestamp();
          console.log(`[Builder] Simulation timestamp: ${simTimestamp}`);

          // Query proxy rollupId
          const proxyInfo = await this.rollupsContract.authorizedProxies(proxyAddress);
          const proxyRollupId = BigInt(proxyInfo.originalRollupId);

          // Plan execution
          // On non-Anvil chains, the proxy caller wallet calls the proxy,
          // so msg.sender (used as sourceAddress in the CALL action) is the
          // proxy caller wallet, not the original user.
          const effectiveSourceAddress = this.isAnvilL1 ? sourceAddress : this.proxyCallerWallet.address;
          let plan;
          try {
            plan = await this.planner.planL1ToL2CallWithProxy(
              l2Target, data, BigInt(value),
              proxyAddress, sourceProxyAddress, effectiveSourceAddress,
              simTimestamp,
              needsCorrection ? correctionTarget : undefined,
              proxyRollupId
            );
          } catch (planErr: any) {
            console.warn(`[Builder] Planning failed: ${planErr.message}`);
            try { await fullnodeRpc.send("syncrollups_revertToSnapshot", [`0x${snapshotBlock.toString(16)}`]); } catch {}
            if (attempt < MAX_PREP_ATTEMPTS) { await new Promise(r => setTimeout(r, 5000)); continue; }
            throw planErr;
          }
          console.log(`[Builder] Planned ${plan.entries.length} execution(s)`);

          // Check for simulation failure
          const rootExec = plan.entries[0];
          if (rootExec?.nextAction.actionType === ActionType.RESULT && rootExec.nextAction.failed) {
            const revertData = rootExec.nextAction.data || "0x";
            const hint = (revertData === "0x" && BigInt(value) > 0n) ? " (target function may not be payable)" : "";
            throw new Error(`L1→L2 simulation failed (revert data: ${revertData})${hint}`);
          }

          // Request proof
          let proof;
          try {
            proof = await this.requestProof(plan, simTimestamp, undefined, [sourceProxyAddress]);
          } catch (proofErr: any) {
            console.warn(`[Builder] Proofer rejected: ${proofErr.message}`);
            try { await fullnodeRpc.send("syncrollups_revertToSnapshot", [`0x${snapshotBlock.toString(16)}`]); } catch {}
            if (attempt < MAX_PREP_ATTEMPTS) { await new Promise(r => setTimeout(r, 5000)); continue; }
            throw proofErr;
          }
          console.log("[Builder] Proof obtained from proofer");

          // Notify fullnode
          await this.planner.notifyExecutions(plan.entries);

          // Build entries data for postBatch
          const entriesData = plan.entries.map((e) => ({
            stateDeltas: e.stateDeltas.map((d) => ({
              rollupId: d.rollupId, currentState: d.currentState,
              newState: d.newState, etherDelta: d.etherDelta,
            })),
            actionHash: e.actionHash,
            nextAction: {
              actionType: e.nextAction.actionType, rollupId: e.nextAction.rollupId,
              destination: e.nextAction.destination, value: e.nextAction.value,
              data: e.nextAction.data, failed: e.nextAction.failed,
              sourceAddress: e.nextAction.sourceAddress, sourceRollup: e.nextAction.sourceRollup,
              scope: e.nextAction.scope,
            },
          }));

          // Build atomic bundle: [correction?] + postBatch + proxyCall (from separate wallet)
          const feeData = await this.l1Provider.getFeeData();
          const basePriority = (() => { const p = feeData.maxPriorityFeePerGas || 0n; const min = 100_000_000n; return p > min ? p : min; })();
          const baseMaxFee = (() => { const f = (feeData.maxFeePerGas || 1_000_000_000n) * 3n; const min = basePriority * 8n; return f > min ? f : min; })();
          // Fund the proxy caller wallet FIRST (before signing the bundle txs).
          // The proxy call comes from proxyCallerWallet (different sender) so that
          // postBatch + proxy call can land in the same block.
          const proxyCallerBalance = await this.l1Provider.getBalance(this.proxyCallerWallet.address);
          const callValue = BigInt(value);
          const minBalance = callValue + baseMaxFee * 2n * 500_000n;
          if (proxyCallerBalance < minBalance) {
            const fundAmount = minBalance * 2n - proxyCallerBalance;
            console.log(`[Builder] Funding proxy caller ${this.proxyCallerWallet.address} with ${fundAmount} wei`);
            const fundTx = await this.adminWallet.sendTransaction({
              to: this.proxyCallerWallet.address,
              value: fundAmount,
              gasLimit: 21_000n,
              maxFeePerGas: baseMaxFee * 2n,
              maxPriorityFeePerGas: basePriority * 3n,
            });
            await fundTx.wait();
            console.log(`[Builder] Proxy caller funded: ${fundTx.hash}`);
          }

          // Fetch admin nonce AFTER any funding tx is mined, to ensure accuracy
          let nonce = await this.adminWallet.getNonce("latest");

          const signedRawTxs: string[] = [];

          if (needsCorrection) {
            signedRawTxs.push(await this.signContractTx("setStateByOwner",
              [this.config.rollupId, correctionTarget],
              { gasLimit: 100_000n, maxFeePerGas: baseMaxFee * 2n, maxPriorityFeePerGas: basePriority * 5n, nonce }
            ));
            console.log(`[Builder] Bundle tx #${signedRawTxs.length}: setStateByOwner (nonce=${nonce})`);
            nonce++;
            this.lastCorrectedState = correctionTarget;
          }

          signedRawTxs.push(await this.signContractTx("postBatch",
            [entriesData, 0, "0x", proof],
            { gasLimit: this.postBatchGasLimit, maxFeePerGas: baseMaxFee * 2n, maxPriorityFeePerGas: basePriority * 2n, nonce }
          ));
          console.log(`[Builder] Bundle tx #${signedRawTxs.length}: postBatch (nonce=${nonce})`);
          nonce++;

          const proxyCallerNonce = await this.proxyCallerWallet.getNonce("pending");
          const proxyCallTx = {
            to: proxyAddress,
            value: callValue,
            data: data,
            gasLimit: 500_000n,
            maxFeePerGas: baseMaxFee * 2n,
            maxPriorityFeePerGas: basePriority,
            nonce: proxyCallerNonce,
            chainId: this.l1ChainId,
            type: 2,
          };
          signedRawTxs.push(await this.proxyCallerWallet.signTransaction(proxyCallTx));
          console.log(`[Builder] Bundle tx #${signedRawTxs.length}: proxy call from ${this.proxyCallerWallet.address} (nonce=${proxyCallerNonce})`);

          // Broadcast all txs to mempool simultaneously. With explicit nonces
          // the miner orders them correctly. On low-traffic chains (Chiado, testnets)
          // they'll typically land in the same block.
          console.log(`[Builder] Broadcasting ${signedRawTxs.length} txs to mempool...`);
          const broadcastPromises = signedRawTxs.map((raw, i) =>
            this.l1Provider.broadcastTransaction(raw).then(tx => {
              console.log(`[Builder] Tx #${i + 1} broadcast: ${tx.hash}`);
              return tx;
            })
          );
          const txResponses = await Promise.all(broadcastPromises);

          // Wait for the last tx (proxy call) to be mined
          const lastTx = txResponses[txResponses.length - 1];
          console.log(`[Builder] Waiting for proxy call tx ${lastTx.hash} to be mined...`);
          const receipt = await lastTx.wait();

          if (!receipt || receipt.status === 0) {
            console.warn(`[Builder] Proxy call tx reverted in block ${receipt?.blockNumber}`);
            try { await fullnodeRpc.send("syncrollups_revertToSnapshot", [`0x${snapshotBlock.toString(16)}`]); } catch {}
            if (attempt < MAX_PREP_ATTEMPTS) { await new Promise(r => setTimeout(r, 5000)); continue; }
            throw new Error(`Proxy call tx reverted after ${MAX_PREP_ATTEMPTS} attempts`);
          }

          // Verify postBatch was in the same block
          const postBatchTx = txResponses[signedRawTxs.length - 2]; // tx before proxy call
          const postBatchReceipt = await postBatchTx.wait();
          if (postBatchReceipt?.blockNumber !== receipt.blockNumber) {
            console.warn(`[Builder] WARNING: postBatch in block ${postBatchReceipt?.blockNumber}, proxy call in block ${receipt.blockNumber} — different blocks!`);
            try { await fullnodeRpc.send("syncrollups_revertToSnapshot", [`0x${snapshotBlock.toString(16)}`]); } catch {}
            if (attempt < MAX_PREP_ATTEMPTS) { await new Promise(r => setTimeout(r, 5000)); continue; }
            throw new Error(`postBatch and proxy call landed in different blocks`);
          }

          console.log(`[Builder] All txs included in block ${receipt.blockNumber}`);

          // Store hint for the proofer — after L1→L2 calls, the proofer's EVM may
          // lag behind (timestamp mismatch causes state divergence). When the builder
          // later requests proof for a subsequent L2TX, it sends these as hints.
          if (plan.rootActions.length > 0) {
            this.recentL1ToL2Hints.push({
              action: plan.rootActions[0],
              timestamp: simTimestamp,
              sourceProxy: sourceProxyAddress,
            });
            console.log(`[Builder] Stored L1→L2 hint for proofer (${this.recentL1ToL2Hints.length} pending)`);
          }

          return {
            success: true,
            proxyAddress,
            sourceProxyAddress,
            proxyDeployed,
            executionsLoaded: plan.entries.length,
            bundleIncluded: true,
            l1BlockNumber: receipt.blockNumber,
          };
        }
      }

      // On real L1 (no bundle submitter): ensure EVM matches tracked state, then check if L1 correction needed.
      let prepNeedsCorrection = false;
      let prepCorrectionTarget = "";
      if (!this.isAnvilL1) {
        const fullnodeRpc = new JsonRpcProvider(this.config.fullnodeRpcUrl);
        const evmState = await fullnodeRpc.send("syncrollups_getActualStateRoot", []);
        const trackedState = await fullnodeRpc.send("syncrollups_getStateRoot", []);
        if (evmState !== trackedState) {
          const trackedL2BlockHex = await fullnodeRpc.send("syncrollups_getTrackedL2Block", []);
          const trackedL2Block = parseInt(trackedL2BlockHex, 16);
          console.log(`[Builder] L1→L2: EVM ahead of tracked, rolling back to L2 block ${trackedL2Block}`);
          try {
            await fullnodeRpc.send("syncrollups_revertToSnapshot", [`0x${trackedL2Block.toString(16)}`]);
          } catch { /* Rollback may fail */ }
          for (let i = 0; i < 60; i++) {
            await new Promise(r => setTimeout(r, 2000));
            try {
              const newRpc = new JsonRpcProvider(this.config.fullnodeRpcUrl);
              const newEvm = await newRpc.send("syncrollups_getActualStateRoot", []);
              if (newEvm === trackedState) break;
              const newTracked = await newRpc.send("syncrollups_getStateRoot", []);
              if (newEvm === newTracked) break;
            } catch { /* reth restarting */ }
          }
        }
        const currentRollup2 = await this.rollupsContract.rollups(this.config.rollupId);
        const currentL1 = currentRollup2.stateRoot;
        if (trackedState !== currentL1) {
          console.log(
            `[Builder] State correction needed: L1=${currentL1.slice(0, 12)}... vs tracked=${trackedState.slice(0, 12)}... (will submit with batch)`
          );
          prepNeedsCorrection = true;
          prepCorrectionTarget = trackedState;
        }
      }

      // Choose timestamp for deterministic state roots.
      // The L1 block containing the user's proxy call will be forced to this timestamp.
      const simTimestamp = await this.chooseSimTimestamp();
      console.log(`[Builder] L1→L2 simulation timestamp: ${simTimestamp}`);

      // 3. Query the proxy's actual originalRollupId (may differ from config.rollupId
      //    if the proxy was created by a different endpoint, e.g. prepare-l2-call)
      const proxyInfo = await this.rollupsContract.authorizedProxies(proxyAddress);
      const proxyRollupId = BigInt(proxyInfo.originalRollupId);
      if (proxyRollupId !== this.config.rollupId) {
        console.log(`[Builder] Proxy rollupId=${proxyRollupId} differs from config=${this.config.rollupId}`);
      }

      // 3b. Plan the execution with proper source context
      let plan = await this.planner.planL1ToL2CallWithProxy(
        l2Target,
        data,
        BigInt(value),
        proxyAddress,
        sourceProxyAddress,
        sourceAddress,  // Original L1 sender for L2 proxy deployment
        simTimestamp,
        prepNeedsCorrection ? prepCorrectionTarget : undefined,
        proxyRollupId
      );
      console.log(`[Builder] Planned ${plan.entries.length} execution(s)`);

      // Do not load failing plans as "prepared executions" on L1.
      // This prevents spammy PREP txs on repeated invalid attempts.
      const rootExecution = plan.entries[0];
      if (
        rootExecution &&
        rootExecution.nextAction.actionType === ActionType.RESULT &&
        rootExecution.nextAction.failed
      ) {
        const revertData = rootExecution.nextAction.data || "0x";
        const hint = (revertData === "0x" && BigInt(value) > 0n)
          ? " (target function may not be payable)"
          : "";
        throw new Error(
          `L1→L2 simulation failed (revert data: ${revertData})${hint}; execution plan was not loaded`
        );
      }

      // 4. Request proof from proofer (pass sourceProxy for CALL verification)
      let proof = await this.requestProof(
        plan,
        simTimestamp,
        undefined,
        [sourceProxyAddress]
      );
      console.log("[Builder] Proof obtained from proofer");

      // 5. Notify fullnode of executions
      await this.planner.notifyExecutions(plan.entries);
      console.log("[Builder] Fullnode notified");

      // 6. Load executions on L1
      let postBatchEntriesData = plan.entries.map((e) => ({
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

      let postBatchTxHash: string | undefined;
      if (this.isAnvilL1) {
        // Anvil: disable automine so the postBatch block doesn't consume our timestamp
        await this.l1Provider.send("evm_setAutomine", [false]);
        try {
          const nonce = await this.adminWallet.getNonce();
          const postBatchTx = await this.rollupsContract.postBatch(
            postBatchEntriesData, 0, "0x", proof,
            { nonce, gasLimit: this.postBatchGasLimit }
          );
          postBatchTxHash = postBatchTx.hash;

          // Set the next block timestamp for when mining happens
          await this.l1Provider.send("evm_setNextBlockTimestamp", [simTimestamp]);

          if (deferMine) {
            // deferMine: leave postBatch in mempool, caller will mine
            console.log(`[Builder] postBatch sent (deferred mine): ${postBatchTx.hash}`);
            // NOTE: automine stays OFF — caller must mine and re-enable
          } else {
            // Non-deferMine: postBatch is in mempool with automine OFF.
            // The user's tx will arrive shortly. Poll for it and mine both together.
            // (ExecutionNotInCurrentBlock requires postBatch + consumption in same block)
            console.log(`[Builder] postBatch in mempool, waiting for user tx to co-mine...`);
            this.waitForUserTxAndMine(postBatchTx.hash);
          }
        } catch (e) {
          // On error, restore automine
          if (!deferMine) {
            await this.l1Provider.send("evm_setAutomine", [true]);
          }
          throw e;
        }
      } else {
        // Real L1: submit correction (if needed) + postBatch simultaneously
        const feeData = await this.l1Provider.getFeeData();
        const basePriority = (() => { const p = feeData.maxPriorityFeePerGas || 0n; const min = 100_000_000n; return p > min ? p : min; })();
        const baseMaxFee = (() => { const f = (feeData.maxFeePerGas || 1_000_000_000n) * 3n; const min = basePriority * 8n; return f > min ? f : min; })();
        let nonce = await this.adminWallet.getNonce("pending");
        const pendingBatchTxs: Promise<any>[] = [];

        if (prepNeedsCorrection) {
          const corrTx = await this.rollupsContract.setStateByOwner(
            this.config.rollupId, prepCorrectionTarget,
            {
              gasLimit: 100_000n,
              maxFeePerGas: baseMaxFee * 2n,
              maxPriorityFeePerGas: basePriority * 5n,
              nonce,
            }
          );
          pendingBatchTxs.push(corrTx.wait());
          console.log(`[Builder] State correction tx submitted (nonce=${nonce})`);
          nonce++;
          this.lastCorrectedState = prepCorrectionTarget;
        }

        const postBatchTx = await this.rollupsContract.postBatch(
          postBatchEntriesData, 0, "0x", proof,
          {
            gasLimit: this.postBatchGasLimit,
            maxFeePerGas: baseMaxFee * 2n,
            maxPriorityFeePerGas: basePriority * 3n,
            nonce,
          }
        );
        pendingBatchTxs.push(postBatchTx.wait());
        await Promise.all(pendingBatchTxs);
        console.log(`[Builder] Executions loaded on L1: ${postBatchTx.hash}`);
      }

      if (!deferMine) {
        this.prepareL1Cache.set(prepareCacheKey, {
          stateRoot: currentL1StateRoot,
          proxyAddress,
          sourceProxyAddress,
          createdAtMs: Date.now(),
        });
      }

      return {
        success: true,
        proxyAddress,
        sourceProxyAddress,
        proxyDeployed,
        executionsLoaded: plan.entries.length,
        ...(postBatchTxHash ? { postBatchTxHash } : {}),
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
  /**
   * Register an L2→L1 hint. Computes the deterministic L2 proxy address for the
   * given L1 target and stores it in the hint table. No deployment or state changes.
   */
  private async handleRegisterL2Hint(
    request: RegisterL2HintRequest
  ): Promise<RegisterL2HintResponse> {
    const { l1Target } = request;
    console.log(`[Builder] Registering L2→L1 hint for L1 target: ${l1Target}`);

    try {
      // Compute deterministic L2 proxy address via CrossChainManagerL2
      const fullnodeRpc = new JsonRpcProvider(this.config.fullnodeRpcUrl);
      const managerIface = new (await import("ethers")).Interface([
        "function computeCrossChainProxyAddress(address, uint256, uint256) view returns (address)",
      ]);
      const computeCalldata = managerIface.encodeFunctionData("computeCrossChainProxyAddress", [
        l1Target, 0n, this.l2ChainId, // originalRollupId=0 (L1), domain=L2 chain ID
      ]);
      const result = await fullnodeRpc.send("eth_call", [
        { to: this.config.rollupsAddress, data: computeCalldata },
        "latest",
      ]);
      const proxyAddress = "0x" + result.slice(26);

      // Store in hint table
      this.l2HintTable.set(proxyAddress.toLowerCase(), l1Target);
      console.log(`[Builder] L2 hint registered: proxy ${proxyAddress} → L1 target ${l1Target}`);

      return {
        success: true,
        proxyAddress,
      };
    } catch (error: any) {
      console.error("[Builder] Register L2 hint error:", error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Deploy a CrossChainProxy contract for a given original address
   */
  private async deployProxy(
    originalAddress: string,
    originalRollupId: bigint
  ): Promise<string> {
    const tx = await this.rollupsContract.createCrossChainProxy(
      originalAddress,
      originalRollupId
    );
    const receipt = await tx.wait();

    // Extract proxy address from CrossChainProxyCreated event
    const iface = this.rollupsContract.interface;
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog(log);
        if (parsed && parsed.name === "CrossChainProxyCreated") {
          return parsed.args.proxy;
        }
      } catch {
        // Not our event
      }
    }

    throw new Error("CrossChainProxyCreated event not found in receipt");
  }

  /**
   * Wait for the proofer's fullnode to be synced with L1 state.
   * This is critical on non-Anvil chains where timestamp corrections cause
   * the proofer fullnode to temporarily diverge from the builder's state.
   */
  private async waitForProoferSync(timeoutMs: number = 120_000): Promise<void> {
    if (this.isAnvilL1) return; // Anvil is always in sync

    const start = Date.now();
    for (let attempt = 0; Date.now() - start < timeoutMs; attempt++) {
      try {
        const response = await fetch(`${this.config.prooferUrl}/status`);
        const status = await response.json() as { isSynced: boolean; prooferState?: string };
        if (status.isSynced) {
          if (attempt > 0) {
            console.log(`[Builder] Proofer fullnode synced (waited ${attempt} attempts)`);
          }
          return;
        }
        if (attempt === 0) {
          console.log(`[Builder] Waiting for proofer fullnode to sync...`);
        }
      } catch {
        // Proofer may be temporarily unavailable during rollback
      }
      await new Promise(r => setTimeout(r, 3000));
    }
    console.warn(`[Builder] Proofer fullnode did not sync within ${timeoutMs / 1000}s, proceeding anyway`);
  }

  /**
   * Request proof from the proofer service.
   * The proofer independently verifies the state transition and signs if valid.
   */
  private async requestProof(
    plan: ExecutionPlan,
    timestamp?: number,
    batchSignedTxs?: string[],
    sourceProxies?: (string | null)[],
    hints?: Array<{ action: any; timestamp: number; sourceProxy?: string }>
  ): Promise<string> {
    // Wait for proofer fullnode to catch up before requesting proof
    await this.waitForProoferSync();

    // Format hints for the proofer protocol
    const formattedHints = hints?.map(h => ({
      action: typeof h.action === 'object' && 'actionType' in h.action && typeof h.action.actionType === 'number'
        ? actionToJson(h.action)
        : h.action, // already in JSON format
      timestamp: h.timestamp,
      sourceProxy: h.sourceProxy,
    }));

    const body = JSON.stringify({
      entries: plan.entries.map(executionEntryToJson),
      rootActions: plan.rootActions.map(actionToJson),
      timestamp,
      batchSignedTxs,
      sourceProxies,
      hints: formattedHints,
      preloadSystemCalls: plan.preloadSystemCalls,
    });

    const response = await fetch(`${this.config.prooferUrl}/prove`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    const result = await response.json() as {
      success: boolean;
      proof?: string;
      error?: string;
      prooferState?: string;
    };

    if (!result.success) {
      throw new Error(
        `Proofer rejected: ${result.error}${result.prooferState ? ` (proofer state: ${result.prooferState})` : ""}`
      );
    }

    return result.proof!;
  }

  /**
   * Choose a simulation timestamp for the L2 block.
   *
   * Anvil mode: We control timestamps precisely. We need at least 2 blocks
   * (postBatch at simTimestamp-1, execute at simTimestamp), both strictly
   * greater than the current head.
   *
   * Real chain mode: We target an anticipated future block. For Gnosis (5s
   * blocks), we aim ~5s ahead so the postBatch and executeL2TX land in blocks
   * whose timestamps are close to our simulation timestamp. The actual L1
   * block timestamp may differ slightly — this is acceptable since
   * block.timestamp is not part of the state root (unless a contract reads it
   * and writes to storage, which we skip checking for now per user direction).
   */
  /** Beacon chain slot duration (Ethereum = 12s, Gnosis = 5s) */
  private get SLOT_DURATION(): number {
    return (this.l1ChainId === 1n || this.l1ChainId === 11155111n) ? 12 : 5;
  }

  private async chooseSimTimestamp(): Promise<number> {
    // Use raw RPC call to bypass ethers' internal block number cache,
    // which can return a stale block when blocks were recently mined.
    const latestBlock = await this.l1Provider.send("eth_getBlockByNumber", ["latest", false]);
    const latestTimestamp = latestBlock ? parseInt(latestBlock.timestamp, 16) : 0;

    if (this.isAnvilL1) {
      // Anvil: +2 margin for 2 intermediate blocks
      const wallClock = Math.floor(Date.now() / 1000);
      const minTimestamp = latestTimestamp + 2;
      return Math.max(wallClock + 2, minTimestamp);
    } else {
      // Beacon chain (Gnosis/Ethereum): predictable slot timestamps.
      // Target the next block. After simulation+proof, we'll wait for
      // the right slot and re-check before sending.
      return latestTimestamp + this.SLOT_DURATION;
    }
  }

  /**
   * Wait until ~1 second into the current L1 block, then return the
   * confirmed next block timestamp.  On beacon chains with fixed slot
   * times this gives us a reliable prediction window: txs sent now
   * should land in the next block whose timestamp we know exactly.
   *
   * @returns the next block's timestamp
   */
  /**
   * Wait for the optimal moment to submit txs targeting the next slot.
   * On Gnosis (5s slots), we want to submit ~1 second into the current slot
   * so the txs are in the mempool well before the next block is proposed.
   * If we're too late in the current slot (>3s), wait for the next slot + 1s.
   * Returns the predicted timestamp of the target block.
   */
  private async waitForNextSlot(): Promise<number> {
    const latestBlock = await this.l1Provider.send("eth_getBlockByNumber", ["latest", false]);
    const latestTimestamp = latestBlock ? parseInt(latestBlock.timestamp, 16) : 0;
    const now = Date.now();
    const wallClock = now / 1000;

    // How far are we into the current slot?
    const elapsed = wallClock - latestTimestamp;

    if (elapsed < 1) {
      // Too early — wait until 1s into the slot
      const waitMs = Math.ceil((1 - elapsed) * 1000);
      console.log(`[Builder] Waiting ${waitMs}ms (${elapsed.toFixed(1)}s into slot → 1s)`);
      await new Promise(r => setTimeout(r, waitMs));
    } else if (elapsed > 3) {
      // Too late in this slot — txs might not make it to the next block.
      // Wait for the next slot boundary + 1s.
      const nextSlotStart = latestTimestamp + this.SLOT_DURATION;
      const waitMs = Math.ceil((nextSlotStart + 1 - wallClock) * 1000);
      console.log(`[Builder] Late in slot (${elapsed.toFixed(1)}s), waiting ${waitMs}ms for next slot + 1s`);
      await new Promise(r => setTimeout(r, Math.max(0, waitMs)));
    } else {
      console.log(`[Builder] Good timing: ${elapsed.toFixed(1)}s into slot`);
    }

    // Re-read latest block after waiting
    const freshBlock = await this.l1Provider.send("eth_getBlockByNumber", ["latest", false]);
    const freshTimestamp = freshBlock ? parseInt(freshBlock.timestamp, 16) : 0;
    return freshTimestamp + this.SLOT_DURATION;
  }

  /**
   * Sign a contract method call as a raw transaction (without broadcasting).
   * Used for building Flashbots bundles.
   */
  private async signContractTx(
    method: string,
    args: any[],
    overrides: {
      gasLimit: bigint;
      maxFeePerGas: bigint;
      maxPriorityFeePerGas: bigint;
      nonce: number;
    }
  ): Promise<string> {
    const unsignedTx = await this.rollupsContract[method].populateTransaction(
      ...args,
      {
        gasLimit: overrides.gasLimit,
        maxFeePerGas: overrides.maxFeePerGas,
        maxPriorityFeePerGas: overrides.maxPriorityFeePerGas,
        nonce: overrides.nonce,
      }
    );
    unsignedTx.chainId = this.l1ChainId;
    return await this.adminWallet.signTransaction(unsignedTx);
  }

  /**
   * Maximum number of bundle submission attempts before giving up.
   * Each attempt re-simulates, re-proofs, and targets the next block.
   */
  private readonly MAX_BUNDLE_ATTEMPTS = 5;

  // Used by inline state correction to avoid redundant corrections
  private lastCorrectedState = "";

  // Background state correction loop — REMOVED.
  // The loop created StateUpdated events that confused fullnodes (false reorgs,
  // state divergence, invalidated entries). Inline correction before each
  // postBatch + correctTimestampIfNeeded after L2TX handle all cases.
  //
  /**
   * On real chains (non-Anvil), the builder simulates L2 blocks with a predicted
   * timestamp (simTimestamp) that may differ from the actual L1 block timestamp.
   * If any contract reads block.timestamp and writes to storage (e.g. Uniswap V2
   * oracle), this causes the state root to diverge between builder and fullnodes.
   *
   * This method corrects the state after L1 confirmation:
   * 1. Gets the actual L1 block timestamp from the executeL2TX receipt
   * 2. If it matches simTimestamp, no correction needed
   * 3. If it differs, rolls back the builder's reth, re-mines with the correct
   *    timestamp, and calls setStateByOwner to update the L1 state root
   *
   * @param execReceipt The receipt from the executeL2TX L1 transaction
   * @param simTimestamp The timestamp used during simulation
   * @param signedTxs The raw signed L2 transactions to replay (for re-mining)
   */
  private async correctTimestampIfNeeded(
    execReceipt: any,
    simTimestamp: number,
    signedTxs: string[]
  ): Promise<void> {
    // Only needed on real chains
    if (this.isAnvilL1) return;

    const l1Block = await this.l1Provider.getBlock(execReceipt.blockNumber);
    if (!l1Block) {
      console.warn("[Builder] Could not fetch L1 block for timestamp correction");
      return;
    }

    const actualTimestamp = Number(l1Block.timestamp);
    if (actualTimestamp === simTimestamp) {
      console.log(`[Builder] L1 block timestamp matches simulation (${simTimestamp})`);
      return;
    }

    // Timestamp mismatch is expected on real chains — the builder simulates with
    // a predicted timestamp, but the actual L1 block may land in a different slot.
    // The event processor now accepts pre-executed state regardless of timestamp,
    // so no correction is needed. The next transaction will include a setStateByOwner
    // correction if the L1 state diverged.
    console.log(
      `[Builder] Timestamp mismatch: simulated=${simTimestamp}, actual=${actualTimestamp}. ` +
      `Event processors accept pre-executed state for consistency.`
    );
  }

  /**
   * Anvil helper: poll pending txs and mine when user's tx arrives alongside postBatch.
   * This ensures postBatch + user tx land in the same block (ExecutionNotInCurrentBlock).
   * Runs asynchronously (fire-and-forget from handlePrepareL1Call).
   */
  private waitForUserTxAndMine(postBatchTxHash: string): void {
    const POLL_INTERVAL = 200; // ms
    const TIMEOUT = 60_000; // 60s max wait
    const startTime = Date.now();

    const poll = async () => {
      let pollCount = 0;
      while (Date.now() - startTime < TIMEOUT) {
        try {
          // Check pending tx count — Anvil's pending block includes mempool txs
          const countHex = await this.l1Provider.send("eth_getBlockTransactionCountByNumber", ["pending"]);
          const txCount = parseInt(countHex, 16);
          if (pollCount % 25 === 0) {
            console.log(`[Builder] Poller: ${txCount} pending tx(s) (poll #${pollCount})`);
          }
          pollCount++;
          if (txCount >= 2) {
            // User tx arrived — mine both together
            await this.l1Provider.send("evm_mine", []);
            await this.l1Provider.send("evm_setAutomine", [true]);
            console.log(`[Builder] Co-mined postBatch + user tx in same block`);
            return;
          }
        } catch (err: any) {
          console.warn(`[Builder] Poller error: ${err.message}`);
        }
        await new Promise(r => setTimeout(r, POLL_INTERVAL));
      }
      // Timeout — mine whatever is pending and restore automine
      console.warn(`[Builder] Timed out waiting for user tx, mining postBatch alone`);
      try {
        await this.l1Provider.send("evm_mine", []);
        await this.l1Provider.send("evm_setAutomine", [true]);
      } catch {}
    };

    poll().catch((err) => {
      console.error(`[Builder] waitForUserTxAndMine error:`, err);
      this.l1Provider.send("evm_setAutomine", [true]).catch(() => {});
    });
  }

  /**
   * Load execution entries on L1 via Rollups.postBatch
   */
  private async postBatchOnL1(
    entries: ExecutionEntry[],
    proof: string,
    nonce?: number
  ): Promise<string> {
    // Convert entries to contract format
    const entriesData = entries.map((e) => ({
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
    const tx = await this.rollupsContract.postBatch(
      entriesData,
      0,    // blobCount = 0 (no blobs for local dev)
      "0x", // callData = empty
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

  const config: BuilderConfig = {
    l1RpcUrl: getArg("l1-rpc", "http://localhost:8545"),
    rollupsAddress: getArg("rollups"),
    adminPrivateKey: getArg("admin-key"),
    fullnodeRpcUrl: getArg("fullnode", "http://localhost:9550"),
    prooferUrl: getArg("proofer", "http://localhost:3300"),
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
