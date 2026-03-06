/**
 * RPC Server for sync-rollups fullnode
 * Provides JSON-RPC interface for L2 queries and builder coordination
 */

import { createServer, IncomingMessage, ServerResponse } from "http";
import { StateManager } from "./state-manager.js";
import { EventProcessor } from "./event-processor.js";
import {
  Action,
  Execution,
  SimulationResult,
  StateDelta,
  ActionType,
  ActionJson,
  ExecutionJson,
  actionFromJson,
  actionToJson,
  stateDeltaToJson,
  executionFromJson,
  executionToJson,
} from "./types.js";

export interface RpcServerConfig {
  port: number;
}

interface JsonRpcRequest {
  jsonrpc: string;
  method: string;
  params?: any[];
  id: number | string;
}

interface JsonRpcResponse {
  jsonrpc: string;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
  id: number | string | null;
}

export class RpcServer {
  private config: RpcServerConfig;
  private stateManager: StateManager;
  private eventProcessor: EventProcessor;
  private server: ReturnType<typeof createServer> | null = null;

  constructor(
    config: RpcServerConfig,
    stateManager: StateManager,
    eventProcessor: EventProcessor
  ) {
    this.config = config;
    this.stateManager = stateManager;
    this.eventProcessor = eventProcessor;
  }

  /**
   * Start the RPC server
   */
  async start(): Promise<void> {
    this.server = createServer(async (req, res) => {
      try {
        await this.handleRequest(req, res);
      } catch (error: any) {
        console.error("[RpcServer] Unhandled error:", error);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: error.message }));
        }
      }
    });

    return new Promise((resolve) => {
      this.server!.listen(this.config.port, () => {
        console.log(
          `[RpcServer] Listening on http://localhost:${this.config.port}`
        );
        resolve();
      });
    });
  }

  /**
   * Stop the RPC server
   */
  async stop(): Promise<void> {
    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => {
          console.log("[RpcServer] Stopped");
          resolve();
        });
      });
    }
  }

  /**
   * Handle incoming HTTP request
   */
  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405);
      res.end("Method not allowed");
      return;
    }

    // Read body
    let body = "";
    for await (const chunk of req) {
      body += chunk;
    }

    try {
      const parsed = JSON.parse(body);

      // Handle batch requests (array of requests)
      if (Array.isArray(parsed)) {
        const responses = await Promise.all(
          parsed.map((req: JsonRpcRequest) => this.handleRpcRequest(req))
        );
        if (!res.headersSent) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(responses));
        }
      } else {
        const response = await this.handleRpcRequest(parsed);
        if (!res.headersSent) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(response));
        }
      }
    } catch (error: any) {
      if (!res.headersSent) {
        const response: JsonRpcResponse = {
          jsonrpc: "2.0",
          error: {
            code: -32700,
            message: "Parse error",
            data: error.message,
          },
          id: null,
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(response));
      }
    }
  }

  /**
   * Handle JSON-RPC request
   */
  private async handleRpcRequest(
    request: JsonRpcRequest
  ): Promise<JsonRpcResponse> {
    const { method, params, id } = request;

    try {
      let result: any;

      // Standard Ethereum methods - proxy to L2 Anvil
      if (method.startsWith("eth_") || method.startsWith("net_")) {
        result = await this.proxyToL2(method, params || []);
      }
      // sync-rollups specific methods
      else {
        switch (method) {
          case "syncrollups_getStateRoot":
            result = this.stateManager.getStateRoot();
            break;

          case "syncrollups_getActualStateRoot":
            result = await this.stateManager.getActualStateRoot();
            break;

          case "syncrollups_getEtherBalance":
            result = "0x" + this.stateManager.getEtherBalance().toString(16);
            break;

          case "syncrollups_isSynced":
            result = await this.eventProcessor.isSynced();
            break;

          case "syncrollups_getL1State":
            result = await this.eventProcessor.getL1State();
            break;

          case "syncrollups_loadExecutions":
            // Builder notifies us of executions to cache
            const executionsJson = params?.[0] as ExecutionJson[];
            if (!executionsJson || !Array.isArray(executionsJson)) {
              throw new Error("Invalid executions parameter");
            }
            // Convert from JSON to native types
            const executions = executionsJson.map(executionFromJson);
            this.stateManager.cacheExecutions(executions);
            result = { cached: executions.length };
            break;

          case "syncrollups_getExecutions":
            // Get cached executions for an action hash
            const actionHash = params?.[0] as string;
            if (!actionHash) {
              throw new Error("Missing actionHash parameter");
            }
            result = this.stateManager.getExecutions(actionHash);
            break;

          case "syncrollups_simulateAction":
            // Simulate an action and return the result
            const actionJson = params?.[0] as ActionJson;
            if (!actionJson) {
              throw new Error("Missing action parameter");
            }
            // Convert from JSON format to native types
            const action = actionFromJson(actionJson);
            const simResult = await this.simulateAction(action);
            // Convert back to JSON-safe format
            result = {
              nextAction: actionToJson(simResult.nextAction),
              stateDeltas: simResult.stateDeltas.map(stateDeltaToJson),
              success: simResult.success,
              error: simResult.error,
            };
            break;

          case "syncrollups_takeSnapshot":
            // Returns current block number as hex string (replaces anvil_snapshot)
            result = await this.stateManager.saveHead();
            break;

          case "syncrollups_revertToSnapshot":
            // Accepts a block number hex string (replaces anvil_revert)
            const blockHex = params?.[0] as string;
            if (!blockHex) {
              throw new Error("Missing block number parameter");
            }
            await this.stateManager.revertToBlock(blockHex);
            result = true;
            break;

          case "syncrollups_simulateL1Call":
            // Execute an L1→L2 call on the builder's L2 (used by /prepare-l1-call endpoint)
            const callParams = params?.[0] as {
              from: string;
              to: string;
              value: string;
              data: string;
              originalSender?: string;
            };
            if (!callParams) {
              throw new Error("Missing call parameters");
            }
            result = await this.simulateL1ToL2Call(callParams);
            break;

          default:
            throw new Error(`Unknown method: ${method}`);
        }
      }

      return {
        jsonrpc: "2.0",
        result,
        id,
      };
    } catch (error: any) {
      return {
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: error.message || "Internal error",
        },
        id,
      };
    }
  }

  /**
   * Proxy request to L2 Anvil
   */
  private async proxyToL2(method: string, params: any[]): Promise<any> {
    const provider = this.stateManager.getL2Provider();
    return await provider.send(method, params);
  }

  /**
   * Execute an L1→L2 call on the builder's private L2 and return the actual
   * post-execution state root.
   *
   * This MODIFIES the L2 state (not read-only). The builder's fullnode
   * pre-executes the call so the planner can include the correct newState
   * in the execution plan loaded on L1. When the L1 event is later replayed,
   * the event processor detects the L2 state already matches and skips
   * re-execution.
   */
  private async simulateL1ToL2Call(params: {
    from: string;
    to: string;
    value: string;
    data: string;
    originalSender?: string;
  }): Promise<{
    returnData: string;
    failed: boolean;
    stateDeltas: { rollupId: string; currentState: string; newState: string; etherDelta: string }[];
    newState: string;
  }> {
    const currentState = this.stateManager.getStateRoot();
    const rollupId = this.stateManager.getRollupId();

    const value = BigInt(params.value);
    let returnData = "0x";
    let failed = false;

    try {
      // Ensure the source proxy is deployed on L2 using the original sender address
      const originalSender = params.originalSender || params.from;
      const l1ChainId = await this.getL1ChainId();
      await this.stateManager.ensureProxyDeployed(
        originalSender,
        rollupId,
        BigInt(l1ChainId)
      );

      // Execute the call via systemCall: sourceProxy.executeOnBehalf(target, data)
      const { Interface } = await import("ethers");
      const proxyIface = new Interface([
        "function executeOnBehalf(address destination, bytes calldata data) payable returns (bool, bytes)"
      ]);
      const execCalldata = proxyIface.encodeFunctionData("executeOnBehalf", [
        params.to,
        params.data,
      ]);

      const txHash = await this.stateManager.systemCall(
        params.from,   // sourceProxy address on L2
        execCalldata,
        "0x" + value.toString(16)
      );
      console.log(`[RpcServer] L1→L2 call pre-executed: ${txHash}`);

      // Read the return data from the receipt logs if needed
      // For now, return "0x" as returnData — the important thing is the state root
    } catch (e: any) {
      console.error("[RpcServer] L1→L2 call execution error:", e.message);
      failed = true;
      if (e.data) {
        returnData = e.data;
      }
    }

    // Get the actual L2 state root after execution
    const newState = failed
      ? currentState
      : await this.stateManager.getActualStateRoot();

    const stateDeltas: { rollupId: string; currentState: string; newState: string; etherDelta: string }[] = [];
    stateDeltas.push({
      rollupId: "0x" + rollupId.toString(16),
      currentState,
      newState,
      etherDelta: "0x0", // etherDelta is 0 for L1→L2 calls (L2Proxy.depositEther handles it)
    });

    return {
      returnData,
      failed,
      stateDeltas,
      newState,
    };
  }

  /**
   * Get the L1 chain ID (cached after first call)
   */
  private l1ChainIdCache: string | null = null;
  private async getL1ChainId(): Promise<string> {
    if (!this.l1ChainIdCache) {
      const l1RpcUrl = this.eventProcessor?.getL1RpcUrl?.() ||
        (this.stateManager as any).config?.l1RpcUrl;
      if (l1RpcUrl) {
        const { JsonRpcProvider } = await import("ethers");
        const l1Provider = new JsonRpcProvider(l1RpcUrl);
        const network = await l1Provider.getNetwork();
        this.l1ChainIdCache = network.chainId.toString();
      } else {
        this.l1ChainIdCache = "31337"; // fallback for local dev
      }
    }
    return this.l1ChainIdCache;
  }

  /**
   * Simulate an action on the L2 EVM.
   *
   * For L2TX actions: Actually sends the raw transaction to reth (state-changing).
   * This gives us the real post-execution state root, which is then included in
   * the execution plan loaded on L1. Same pattern as simulateL1ToL2Call.
   * Only the builder's private fullnode runs this, so state mutation is safe.
   * When the L1 event is later replayed, the event processor detects that the
   * L2 state already matches and skips re-execution.
   *
   * For CALL actions: Uses eth_call (read-only). CALL simulations are only used
   * for return data; actual L1→L2 call execution goes through simulateL1ToL2Call.
   */
  private async simulateAction(action: Action): Promise<SimulationResult> {
    const provider = this.stateManager.getL2Provider();
    const currentState = this.stateManager.getStateRoot();

    let success = true;
    let error: string | undefined;
    let returnData = "0x";

    if (action.actionType === ActionType.L2TX) {
      // Actually execute the L2TX on the builder's L2 (not read-only).
      // This gives us the real post-execution state root.
      try {
        const txHash = await this.stateManager.sendRawTransaction(action.data);
        const receipt = await this.stateManager.waitForReceipt(txHash);

        if (receipt.status === 0) {
          success = false;
          error = `L2 transaction reverted (tx: ${txHash})`;
        }
      } catch (e: any) {
        success = false;
        error = e.message;
      }
    } else if (action.actionType === ActionType.CALL) {
      // Simulate a call using eth_call (read-only, no state changes)
      try {
        returnData = await provider.send("eth_call", [
          {
            from: action.sourceAddress,
            to: action.destination,
            value: "0x" + action.value.toString(16),
            data: action.data,
          },
          "latest",
        ]);
      } catch (e: any) {
        success = false;
        error = e.message;
      }
    }

    // Build state deltas
    const stateDeltas: StateDelta[] = [];
    if (success) {
      // Read actual state root after execution
      const actualNewState = await this.stateManager.getActualStateRoot();
      stateDeltas.push({
        rollupId: action.rollupId,
        currentState,
        newState: actualNewState,
        etherDelta: 0n,
      });
    }

    // Build next action (RESULT)
    const nextAction: Action = {
      actionType: ActionType.RESULT,
      rollupId: action.rollupId,
      destination: "0x0000000000000000000000000000000000000000",
      value: 0n,
      data: returnData,
      failed: !success,
      sourceAddress: "0x0000000000000000000000000000000000000000",
      sourceRollup: 0n,
      scope: [],
    };

    return {
      nextAction,
      stateDeltas,
      success,
      error,
    };
  }
}
