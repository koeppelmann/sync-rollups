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
            result = await this.stateManager.takeSnapshot();
            break;

          case "syncrollups_revertToSnapshot":
            const snapshotId = params?.[0] as string;
            if (!snapshotId) {
              throw new Error("Missing snapshotId parameter");
            }
            await this.stateManager.revertToSnapshot(snapshotId);
            result = true;
            break;

          case "syncrollups_simulateL1Call":
            // Simulate an L1→L2 call (used by /prepare-l1-call endpoint)
            const callParams = params?.[0] as {
              from: string;
              to: string;
              value: string;
              data: string;
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
   * Simulate an L1→L2 call
   * Impersonates the proxy address and executes on Anvil
   */
  private async simulateL1ToL2Call(params: {
    from: string;
    to: string;
    value: string;
    data: string;
  }): Promise<{
    returnData: string;
    failed: boolean;
    stateDeltas: { rollupId: string; currentState: string; newState: string; etherDelta: string }[];
    newState: string;
  }> {
    const provider = this.stateManager.getL2Provider();
    const currentState = this.stateManager.getStateRoot();
    const rollupId = this.stateManager.getRollupId();

    // Take snapshot before simulation
    const snapshotId = await this.stateManager.takeSnapshot();

    try {
      // Fund the from address (proxy) so it can send the value
      const value = BigInt(params.value);
      const fundAmount = value + BigInt("1000000000000000000"); // value + 1 ETH for gas
      await provider.send("anvil_setBalance", [
        params.from,
        "0x" + fundAmount.toString(16),
      ]);

      let returnData = "0x";
      let failed = false;

      try {
        // First try as eth_call to get return data
        returnData = await provider.send("eth_call", [
          {
            from: params.from,
            to: params.to,
            value: params.value,
            data: params.data,
          },
          "latest",
        ]);

        // Then execute as transaction to get actual state changes
        await provider.send("anvil_impersonateAccount", [params.from]);

        const txHash = await provider.send("eth_sendTransaction", [
          {
            from: params.from,
            to: params.to,
            value: params.value,
            data: params.data,
            gas: "0x1000000", // High gas limit
          },
        ]);

        await provider.send("anvil_stopImpersonatingAccount", [params.from]);

        // Mine the block
        await this.stateManager.mineBlock();

        // Check receipt
        const receipt = await provider.getTransactionReceipt(txHash);
        failed = receipt?.status !== 1;

      } catch (e: any) {
        console.error("[RpcServer] L1→L2 call simulation error:", e.message);
        failed = true;
        // Try to extract revert data
        if (e.data) {
          returnData = e.data;
        }
      }

      // Get new state after execution
      const newState = await this.stateManager.getActualStateRoot();

      // Build state deltas
      const stateDeltas: { rollupId: string; currentState: string; newState: string; etherDelta: string }[] = [];
      if (newState !== currentState || value > 0n) {
        stateDeltas.push({
          rollupId: "0x" + rollupId.toString(16),
          currentState,
          newState,
          etherDelta: "0x" + value.toString(16), // Positive = ETH deposited
        });
      }

      return {
        returnData,
        failed,
        stateDeltas,
        newState,
      };

    } finally {
      // Revert to snapshot (simulation only, don't persist)
      await this.stateManager.revertToSnapshot(snapshotId);
    }
  }

  /**
   * Simulate an action on the L2 EVM
   * This is a simplified simulation - full implementation would trace calls
   */
  private async simulateAction(action: Action): Promise<SimulationResult> {
    const provider = this.stateManager.getL2Provider();
    const currentState = this.stateManager.getStateRoot();

    // Take snapshot before simulation
    const snapshotId = await this.stateManager.takeSnapshot();

    try {
      let success = true;
      let error: string | undefined;
      let returnData = "0x";

      if (action.actionType === ActionType.L2TX) {
        // Execute L2 transaction
        try {
          const txHash = await provider.send("eth_sendRawTransaction", [
            action.data,
          ]);
          await this.stateManager.mineBlock();
          const receipt = await provider.getTransactionReceipt(txHash);
          success = receipt?.status === 1;
          if (!success) {
            error = "Transaction reverted";
          }
        } catch (e: any) {
          success = false;
          error = e.message;
        }
      } else if (action.actionType === ActionType.CALL) {
        // Simulate a call
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

      // Get new state after simulation
      const newState = await this.stateManager.getActualStateRoot();

      // Build state delta
      const stateDeltas: StateDelta[] = [];
      if (newState !== currentState) {
        stateDeltas.push({
          rollupId: action.rollupId,
          currentState,
          newState,
          etherDelta: 0n, // Would need to track actual ETH changes
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
    } finally {
      // Revert to snapshot (simulation only, don't persist changes)
      await this.stateManager.revertToSnapshot(snapshotId);
    }
  }
}
