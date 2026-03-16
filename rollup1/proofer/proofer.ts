#!/usr/bin/env node
/**
 * Proofer for sync-rollups
 *
 * Logically separated from the builder: receives proof requests, independently
 * verifies state transitions on its own L2 fullnode, and only signs if valid.
 *
 * The builder plans execution entries and asks the proofer to verify and sign.
 * The proofer re-executes the claimed transitions on its own L2 EVM and rejects
 * invalid claims. For the POC, "signing" is an admin wallet signature checked
 * by MockZKVerifier; in production this would be a ZK proof.
 *
 * If the proofer's L2 state doesn't match the entry's currentState, the builder
 * must provide hints (signed transactions + timestamps) to advance the proofer's
 * L2 to the required state. The proofer doesn't validate that the hints are
 * legitimate rollup transitions — it only uses them to reach the required state
 * so it can verify the claimed transition from that state.
 */

import { createServer, IncomingMessage, ServerResponse } from "http";
import { JsonRpcProvider, keccak256, AbiCoder } from "ethers";
import { ProofGenerator, ProofGeneratorConfig } from "../builder/proof-generator.js";
import {
  Action,
  ActionType,
  ExecutionEntry,
  ActionJson,
  ExecutionEntryJson,
  actionFromJson,
  actionToJson,
  executionEntryFromJson,
  ACTION_TUPLE_TYPE,
} from "../reth-fullnode/types.js";

// ── Config ──────────────────────────────────────────────────────────────────

export interface ProoferConfig {
  proofSignerPrivateKey: string;
  l1RpcUrl: string;
  rollupsAddress: string;
  fullnodeRpcUrl: string; // Proofer's own fullnode
  port: number;
}

// ── Request / Response types ────────────────────────────────────────────────

/**
 * A hint describes a state transition the proofer should apply to reach the
 * required currentState.  Hints do NOT need to be signed by the user — the
 * proofer doesn't validate their legitimacy, only uses them to advance its L2.
 *
 * Two flavours:
 *  - L2TX:  `action.actionType === L2TX`, `action.data` contains the
 *           RLP-encoded (already-signed) L2 transaction.
 *  - CALL:  `action.actionType === CALL`, describes an L1→L2 cross-chain call.
 *           `sourceProxy` is the L2 address that acts as msg.sender.
 */
export interface Hint {
  /** The action that was performed (L2TX or CALL). */
  action: ActionJson;
  /** Block timestamp used when this action was originally mined. */
  timestamp: number;
  /** For CALL actions: the L2 source proxy address (msg.sender on L2). */
  sourceProxy?: string;
}

export interface ProveRequest {
  /** Execution entries to verify and sign */
  entries: ExecutionEntryJson[];
  /** Root actions corresponding to each entry (needed for re-execution) */
  rootActions: ActionJson[];
  /** Simulation timestamp for deterministic state roots */
  timestamp?: number;
  /** Hints to advance proofer's L2 from its current state to the required currentState */
  hints?: Hint[];
  /**
   * For batch verification: all signed txs in the batch.
   * When present, entries are verified as a batch (all txs in one block).
   */
  batchSignedTxs?: string[];
  /**
   * For CALL entries: the L2 source proxy address for each entry.
   * Only needed when rootAction is a CALL (L1→L2). null for non-CALL entries.
   */
  sourceProxies?: (string | null)[];
  /**
   * System calls to execute on the proofer's L2 before verifying specific entries.
   * Used for L2→L1 calls: the builder pre-loads execution entries into
   * CrossChainManagerL2 so the proxy call can consume them during simulation.
   */
  preloadSystemCalls?: { entryIndex: number; to: string; data: string }[];
}

export interface ProveResponse {
  success: boolean;
  proof?: string;
  error?: string;
  /** Proofer's L2 state root (for diagnostics) */
  prooferState?: string;
}

export interface ProoferStatusResponse {
  prooferState: string;
  l1StateRoot: string;
  isSynced: boolean;
  signerAddress: string;
}

// ── Proofer ─────────────────────────────────────────────────────────────────

export class Proofer {
  private config: ProoferConfig;
  private proofGenerator: ProofGenerator;
  private fullnodeProvider: JsonRpcProvider;
  private abiCoder: AbiCoder;
  private server: ReturnType<typeof createServer> | null = null;

  constructor(config: ProoferConfig) {
    this.config = config;
    this.fullnodeProvider = new JsonRpcProvider(config.fullnodeRpcUrl);
    this.abiCoder = AbiCoder.defaultAbiCoder();
    this.proofGenerator = new ProofGenerator({
      adminPrivateKey: config.proofSignerPrivateKey,
      l1RpcUrl: config.l1RpcUrl,
      rollupsAddress: config.rollupsAddress,
    });
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  async start(): Promise<void> {
    console.log("=== sync-rollups Proofer ===");
    console.log(`L1 RPC: ${this.config.l1RpcUrl}`);
    console.log(`Fullnode RPC: ${this.config.fullnodeRpcUrl}`);
    console.log(`Proof signer: ${this.proofGenerator.getAdminAddress()}`);
    console.log("");

    this.server = createServer((req, res) => this.handleRequest(req, res));

    return new Promise((resolve) => {
      this.server!.listen(this.config.port, () => {
        console.log(
          `[Proofer] API listening on http://localhost:${this.config.port}`
        );
        console.log("");
        console.log("Endpoints:");
        console.log("  POST /prove    - Verify and sign execution entries");
        console.log("  POST /rollback - Roll back EVM to tracked state");
        console.log("  GET  /status   - Get proofer status");
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => {
          console.log("[Proofer] Stopped");
          resolve();
        });
      });
    }
  }

  // ── HTTP routing ────────────────────────────────────────────────────────

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(
      req.url || "/",
      `http://localhost:${this.config.port}`
    );

    try {
      if (url.pathname === "/status" && req.method === "GET") {
        const status = await this.getStatus();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(status));
      } else if (url.pathname === "/prove" && req.method === "POST") {
        let body = "";
        for await (const chunk of req) {
          body += chunk;
        }
        const request: ProveRequest = JSON.parse(body);
        const response = await this.handleProve(request);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(response));
      } else if (url.pathname === "/rollback" && req.method === "POST") {
        // Roll back proofer's EVM to tracked state (used by builder after L1 revert)
        const trackedState = await this.fullnodeProvider.send("syncrollups_getStateRoot", []);
        const currentState = await this.fullnodeProvider.send("syncrollups_getActualStateRoot", []);
        if (currentState !== trackedState) {
          const trackedL2Block = await this.fullnodeProvider.send("syncrollups_getTrackedL2Block", []);
          console.log(`[Proofer] Rollback requested: EVM ${currentState.slice(0, 18)}... → tracked ${trackedState.slice(0, 18)}... (L2 block ${trackedL2Block})`);
          await this.rollback(parseInt(trackedL2Block, 16));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, rolledBackTo: trackedState }));
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, message: "Already at tracked state" }));
        }
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    } catch (error: any) {
      console.error("[Proofer] Request error:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    }
  }

  // ── Status ──────────────────────────────────────────────────────────────

  private async getStatus(): Promise<ProoferStatusResponse> {
    const prooferState = await this.fullnodeProvider.send(
      "syncrollups_getActualStateRoot",
      []
    );
    const trackedState = await this.fullnodeProvider.send(
      "syncrollups_getStateRoot",
      []
    );
    const l1State = await this.fullnodeProvider.send(
      "syncrollups_getL1State",
      []
    );
    return {
      prooferState,
      l1StateRoot: l1State.stateRoot,
      // Use tracked state for sync check — EVM may differ due to timestamp mismatches
      isSynced: trackedState === l1State.stateRoot,
      signerAddress: this.proofGenerator.getAdminAddress(),
    };
  }

  // ── Core prove logic ──────────────────────────────────────────────────

  private async handleProve(request: ProveRequest): Promise<ProveResponse> {
    const { entries: entriesJson, rootActions: rootActionsJson } = request;

    // Validate request shape
    if (
      !entriesJson ||
      !rootActionsJson ||
      entriesJson.length !== rootActionsJson.length
    ) {
      return {
        success: false,
        error: "entries and rootActions must be arrays of equal length",
      };
    }

    if (entriesJson.length === 0) {
      return { success: false, error: "No entries to prove" };
    }

    // Deserialize
    const entries = entriesJson.map(executionEntryFromJson);
    const rootActions = rootActionsJson.map(actionFromJson);

    console.log(`[Proofer] Prove request: ${entries.length} entries`);

    // Verify action hashes match root actions
    for (let i = 0; i < entries.length; i++) {
      const computedHash = this.computeActionHash(rootActions[i]);
      if (computedHash !== entries[i].actionHash) {
        return {
          success: false,
          error: `Entry ${i}: actionHash mismatch. Computed ${computedHash.slice(0, 18)}... from rootAction, entry claims ${entries[i].actionHash.slice(0, 18)}...`,
        };
      }
    }

    // Get required currentState from the first non-identity entry
    const requiredState = entries[0]?.stateDeltas[0]?.currentState;
    if (!requiredState) {
      return {
        success: false,
        error: "First entry has no state delta",
      };
    }

    // Save pre-verification block number for rollback on failure.
    // On success, we KEEP the simulation state (like the builder does).
    // The event processor will later see the L1 event and skip replay
    // since the L2 state already matches.
    const rollbackBlock = await this.fullnodeProvider.send(
      "syncrollups_takeSnapshot",
      []
    );
    const rollbackBlockNum = parseInt(rollbackBlock, 16);

    try {
      // Check if proofer's L2 is at the required state.
      // First check tracked state (event-processor-committed) — EVM may differ
      // due to timestamp mismatches on real chains.
      const trackedState = await this.fullnodeProvider.send(
        "syncrollups_getStateRoot",
        []
      );
      let currentState = await this.fullnodeProvider.send(
        "syncrollups_getActualStateRoot",
        []
      );

      // If tracked matches required but EVM doesn't, roll back EVM to tracked state
      if (trackedState === requiredState && currentState !== requiredState) {
        console.log(
          `[Proofer] EVM ${currentState.slice(0, 18)}... != tracked ${trackedState.slice(0, 18)}..., rolling back`
        );
        const trackedL2BlockHex = await this.fullnodeProvider.send(
          "syncrollups_getTrackedL2Block",
          []
        );
        try {
          await this.fullnodeProvider.send(
            "syncrollups_revertToSnapshot",
            [trackedL2BlockHex]
          );
        } catch { /* rollback may fail on undershoot */ }

        // Wait for reth to restart
        for (let i = 0; i < 30; i++) {
          await new Promise(r => setTimeout(r, 2000));
          try {
            currentState = await this.fullnodeProvider.send(
              "syncrollups_getActualStateRoot",
              []
            );
            if (currentState === requiredState) {
              console.log(`[Proofer] EVM rolled back to tracked state`);
              break;
            }
          } catch { /* reth restarting */ }
        }
      }

      if (currentState !== requiredState) {
        console.log(
          `[Proofer] State mismatch: at ${currentState.slice(0, 18)}..., need ${requiredState.slice(0, 18)}...`
        );

        if (!request.hints || request.hints.length === 0) {
          return {
            success: false,
            error: `State mismatch: proofer at ${currentState}, entry requires ${requiredState}. Provide hints to advance state.`,
            prooferState: currentState,
          };
        }

        console.log(
          `[Proofer] Applying ${request.hints.length} hints to advance state...`
        );

        // Apply hints to advance to required state.
        // Each hint can be an L2TX (signed tx) or a CALL (L1→L2 cross-chain call).
        // On success these persist (event processor will skip replay later).
        for (let i = 0; i < request.hints.length; i++) {
          const hint = request.hints[i];
          try {
            await this.applyHint(hint, i);
          } catch (e: any) {
            // Hint failed — rollback everything
            await this.rollback(rollbackBlockNum);
            return {
              success: false,
              error: `Hint ${i} failed: ${e.message}`,
              prooferState: currentState,
            };
          }
        }

        // Verify we reached the required state
        const stateAfterHints = await this.fullnodeProvider.send(
          "syncrollups_getActualStateRoot",
          []
        );
        if (stateAfterHints !== requiredState) {
          await this.rollback(rollbackBlockNum);
          return {
            success: false,
            error: `Hints did not produce required state. Got ${stateAfterHints}, need ${requiredState}`,
            prooferState: stateAfterHints,
          };
        }
        console.log("[Proofer] Hints applied successfully, reached required state");
      }

      // ── Batch verification path ───────────────────────────────────────
      if (request.batchSignedTxs && request.batchSignedTxs.length > 0) {
        const batchResult = await this.verifyBatch(
          entries,
          request.batchSignedTxs,
          request.timestamp
        );
        if (!batchResult.success) {
          await this.rollback(rollbackBlockNum);
          return batchResult;
        }
      } else {
        // ── Individual entry verification ─────────────────────────────
        // Build lookup for preload system calls by entry index
        const preloadsByEntry = new Map<number, { to: string; data: string }[]>();
        if (request.preloadSystemCalls) {
          for (const pc of request.preloadSystemCalls) {
            const list = preloadsByEntry.get(pc.entryIndex) || [];
            list.push({ to: pc.to, data: pc.data });
            preloadsByEntry.set(pc.entryIndex, list);
          }
        }

        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i];
          const rootAction = rootActions[i];

          // Skip identity transitions (newState == currentState, no state change to verify)
          const isIdentity = entry.stateDeltas.every(
            (sd) => sd.currentState === sd.newState
          );
          if (isIdentity) {
            console.log(`[Proofer] Entry ${i}: identity transition, skipped`);
            continue;
          }

          // Apply any preload system calls for this entry (e.g., loadExecutionTable
          // for L2→L1 proxy calls that need execution entries during simulation).
          // Uses systemCall (mines its own block) so the preload executes before
          // the user's L2TX — reth orders by gas price within a block, so
          // co-mining would let the user tx run first.
          const preloads = preloadsByEntry.get(i);
          let entryTimestamp = request.timestamp;
          if (preloads) {
            for (const pc of preloads) {
              console.log(`[Proofer] Pre-loading system tx for entry ${i}`);
              await this.fullnodeProvider.send("syncrollups_systemCall", [
                pc.to, pc.data, "0x0", entryTimestamp,
              ]);
              // Each systemCall mines its own block with entryTimestamp,
              // so the next block must use a later timestamp.
              if (entryTimestamp !== undefined) entryTimestamp = entryTimestamp + 1;
            }
          }

          // Simulate the root action on our L2
          const sourceProxy = request.sourceProxies?.[i] ?? null;
          const verifyResult = await this.verifyEntry(entry, rootAction, entryTimestamp, i, sourceProxy);
          if (!verifyResult.success) {
            await this.rollback(rollbackBlockNum);
            return verifyResult;
          }
        }
      }

      // All checks passed — keep the simulation state and sign.
      // The proofer's L2 now mirrors the builder's L2 (both ahead of L1).
      // When the builder posts the batch to L1, the event processor will
      // detect "L2 state already matches" and skip replay.
      const proof = await this.proofGenerator.signPostBatchProof(entries);
      console.log("[Proofer] Verification passed, proof signed");

      return {
        success: true,
        proof,
      };
    } catch (error: any) {
      console.error("[Proofer] Prove error:", error);
      // Rollback on unexpected errors
      try {
        await this.rollback(rollbackBlockNum);
      } catch {
        // Best effort
      }
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Rollback the proofer's L2 to a previous block.
   * Uses reth stage unwind (stops and restarts reth) — heavy but reliable.
   * Only called on verification failure to undo simulation blocks.
   */
  private async rollback(targetBlock: number): Promise<void> {
    try {
      console.log(`[Proofer] Rolling back L2 to block ${targetBlock}...`);
      await this.fullnodeProvider.send("syncrollups_revertToSnapshot", [
        "0x" + targetBlock.toString(16),
      ]);
      console.log("[Proofer] Rollback complete");
    } catch (e: any) {
      console.error(`[Proofer] Rollback failed: ${e.message}`);
    }
  }

  // ── Verify a single entry ─────────────────────────────────────────────

  private async verifyEntry(
    entry: ExecutionEntry,
    rootAction: Action,
    timestamp: number | undefined,
    index: number,
    sourceProxy?: string | null
  ): Promise<ProveResponse> {
    console.log(
      `[Proofer] Verifying entry ${index}: ${ActionType[rootAction.actionType]}`
    );

    let simResultJson: any;

    if (rootAction.actionType === ActionType.CALL) {
      // CALL actions (L1→L2) need simulateL1Call which properly deploys
      // the source proxy and sends the call from it.
      if (!sourceProxy) {
        return {
          success: false,
          error: `Entry ${index}: CALL action requires sourceProxy in prove request`,
        };
      }

      simResultJson = await this.fullnodeProvider.send(
        "syncrollups_simulateL1Call",
        [
          {
            from: sourceProxy,
            to: rootAction.destination,
            value: "0x" + rootAction.value.toString(16),
            data: rootAction.data,
            originalSender: rootAction.sourceAddress,
          },
          timestamp,
        ]
      );

      // simulateL1Call returns a different shape; normalize it
      const newState = simResultJson.newState;
      const claimedNewState = entry.stateDeltas[0]?.newState;

      if (newState !== claimedNewState) {
        return {
          success: false,
          error: `Entry ${index}: state mismatch. Simulation produced ${newState}, entry claims ${claimedNewState}`,
          prooferState: newState,
        };
      }
      console.log(
        `[Proofer] Entry ${index}: L1→L2 CALL state verified ✓ (${newState.slice(0, 18)}...)`
      );

      // Check return data / failed status
      if (
        simResultJson.failed !== entry.nextAction.failed
      ) {
        return {
          success: false,
          error: `Entry ${index}: CALL failed mismatch. Simulation: ${simResultJson.failed}, entry: ${entry.nextAction.failed}`,
        };
      }

      return { success: true };
    }

    // For L2TX and other action types, use simulateAction
    simResultJson = await this.fullnodeProvider.send(
      "syncrollups_simulateAction",
      [actionToJson(rootAction), timestamp]
    );

    if (!simResultJson.success) {
      // Simulation failed — check if the entry also claims failure
      if (entry.nextAction.failed) {
        console.log(
          `[Proofer] Entry ${index}: both simulation and entry claim failure — consistent`
        );
        return { success: true };
      }
      return {
        success: false,
        error: `Entry ${index}: simulation failed: ${simResultJson.error || "unknown error"}`,
      };
    }

    // Verify state transition
    if (simResultJson.stateDeltas && simResultJson.stateDeltas.length > 0) {
      const simNewState = simResultJson.stateDeltas[0].newState;
      const claimedNewState = entry.stateDeltas[0]?.newState;

      if (simNewState !== claimedNewState) {
        return {
          success: false,
          error: `Entry ${index}: state mismatch. Simulation produced ${simNewState}, entry claims ${claimedNewState}`,
          prooferState: simNewState,
        };
      }
      console.log(
        `[Proofer] Entry ${index}: state verified ✓ (${simNewState.slice(0, 18)}...)`
      );
    }

    // Verify nextAction matches (skip for L2→L1 entries where nextAction is CALL).
    // For L2→L1, the entry's nextAction is a CALL to L1 (used by L1's scope resolution),
    // but the L2 simulation returns a RESULT (the proxy consumed the execution entry locally).
    // The proofer's job is only to verify the state transition, not the L1 continuation.
    if (entry.nextAction.actionType === ActionType.CALL) {
      console.log(
        `[Proofer] Entry ${index}: nextAction is CALL (L2→L1), skipping nextAction comparison`
      );
    } else {
      const simNextAction = actionFromJson(simResultJson.nextAction);
      const mismatch = this.compareActions(simNextAction, entry.nextAction);
      if (mismatch) {
        return {
          success: false,
          error: `Entry ${index}: nextAction mismatch on field '${mismatch}'`,
        };
      }
    }

    return { success: true };
  }

  // ── Verify a batch ────────────────────────────────────────────────────

  private async verifyBatch(
    entries: ExecutionEntry[],
    batchSignedTxs: string[],
    timestamp: number | undefined
  ): Promise<ProveResponse> {
    console.log(
      `[Proofer] Verifying batch of ${batchSignedTxs.length} transactions`
    );

    const simResult = await this.fullnodeProvider.send(
      "syncrollups_simulateBatch",
      [batchSignedTxs, timestamp]
    );

    if (!simResult.success) {
      return {
        success: false,
        error: `Batch simulation failed: ${simResult.error || "unknown"}`,
      };
    }

    // The first entry should carry the state transition from currentState→newState
    const claimedNewState = entries[0].stateDeltas[0]?.newState;
    if (simResult.newState !== claimedNewState) {
      return {
        success: false,
        error: `Batch state mismatch: simulation produced ${simResult.newState}, entry 0 claims ${claimedNewState}`,
        prooferState: simResult.newState,
      };
    }

    console.log(
      `[Proofer] Batch verified ✓ (${simResult.newState.slice(0, 18)}...)`
    );
    return { success: true };
  }

  // ── Hint application ───────────────────────────────────────────────────

  /**
   * Apply a single hint to advance the proofer's L2 state.
   *
   *  - L2TX hints: broadcast the signed transaction embedded in action.data
   *  - CALL hints: execute an L1→L2 cross-chain call via simulateL1Call
   */
  private async applyHint(hint: Hint, index: number): Promise<void> {
    const action = actionFromJson(hint.action);

    if (action.actionType === ActionType.L2TX) {
      // L2TX: action.data contains the RLP-encoded signed transaction
      console.log(`[Proofer] Hint ${index}: L2TX`);
      await this.fullnodeProvider.send("syncrollups_simulateAction", [
        hint.action,
        hint.timestamp,
      ]);
    } else if (action.actionType === ActionType.CALL) {
      // CALL: L1→L2 cross-chain call
      if (!hint.sourceProxy) {
        throw new Error(
          `Hint ${index}: CALL hint requires sourceProxy`
        );
      }
      console.log(
        `[Proofer] Hint ${index}: CALL ${action.sourceAddress.slice(0, 10)}→${action.destination.slice(0, 10)}`
      );
      await this.fullnodeProvider.send("syncrollups_simulateL1Call", [
        {
          from: hint.sourceProxy,
          to: action.destination,
          value: "0x" + action.value.toString(16),
          data: action.data,
          originalSender: action.sourceAddress,
        },
        hint.timestamp,
      ]);
    } else {
      throw new Error(
        `Hint ${index}: unsupported action type ${ActionType[action.actionType]}`
      );
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private computeActionHash(action: Action): string {
    const encoded = this.abiCoder.encode(
      [ACTION_TUPLE_TYPE],
      [
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
      ]
    );
    return keccak256(encoded);
  }

  /**
   * Compare two actions field-by-field. Returns null if equal, or the
   * first mismatching field name.
   */
  private compareActions(a: Action, b: Action): string | null {
    if (a.actionType !== b.actionType) return "actionType";
    if (a.rollupId !== b.rollupId) return "rollupId";
    if (a.destination.toLowerCase() !== b.destination.toLowerCase())
      return "destination";
    if (a.value !== b.value) return "value";
    if (a.data.toLowerCase() !== b.data.toLowerCase()) return "data";
    if (a.failed !== b.failed) return "failed";
    if (a.sourceAddress.toLowerCase() !== b.sourceAddress.toLowerCase())
      return "sourceAddress";
    if (a.sourceRollup !== b.sourceRollup) return "sourceRollup";
    if (a.scope.length !== b.scope.length) return "scope.length";
    for (let i = 0; i < a.scope.length; i++) {
      if (a.scope[i] !== b.scope[i]) return `scope[${i}]`;
    }
    return null;
  }
}

// ── CLI entry point ─────────────────────────────────────────────────────────

async function main() {
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

  const config: ProoferConfig = {
    proofSignerPrivateKey: getArg("proof-key"),
    l1RpcUrl: getArg("l1-rpc", "http://localhost:8545"),
    rollupsAddress: getArg("rollups"),
    fullnodeRpcUrl: getArg("fullnode"),
    port: parseInt(getArg("port", "3300")),
  };

  const proofer = new Proofer(config);

  const shutdown = async () => {
    console.log("\nShutdown signal received");
    await proofer.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    await proofer.start();
  } catch (error) {
    console.error("Failed to start proofer:", error);
    process.exit(1);
  }
}

const isMainModule =
  process.argv[1]?.endsWith("proofer.ts") ||
  process.argv[1]?.endsWith("proofer.js");
if (isMainModule) {
  main().catch(console.error);
}
