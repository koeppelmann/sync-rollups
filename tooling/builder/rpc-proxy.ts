/**
 * L1 RPC Proxy Server
 *
 * A proxy that sits between the wallet and the real L1 RPC node.
 * It forwards all requests to the underlying RPC, EXCEPT:
 * - eth_sendRawTransaction: Intercepts signed transactions and routes them
 *   through the Builder API instead of directly to the node.
 *
 * This allows wallets like Rabby (that don't support eth_signTransaction)
 * to work with the sync-rollups system by using their normal eth_sendTransaction flow.
 *
 * Usage:
 *   npx tsx builder/rpc-proxy.ts [options]
 *
 * Options:
 *   --port <port>       Proxy port (default: 8546)
 *   --rpc <url>         Underlying L1 RPC URL (default: http://localhost:8545)
 *   --builder <url>     Builder API URL (default: http://localhost:3200)
 *   --rollups <addr>    Rollups contract address (for proxy detection)
 */

import * as http from "http";
import { ethers, Transaction } from "ethers";

// ============ Configuration ============

interface Config {
  port: number;
  rpcUrl: string;
  builderUrl: string;
  rollupsAddress: string;
}

function parseArgs(): Config {
  const args = process.argv.slice(2);
  const config: Config = {
    port: 8546,
    rpcUrl: "http://localhost:8545",
    builderUrl: "http://localhost:3200",
    rollupsAddress: "",
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--port":
        config.port = parseInt(args[++i]);
        break;
      case "--rpc":
        config.rpcUrl = args[++i];
        break;
      case "--builder":
        config.builderUrl = args[++i];
        break;
      case "--rollups":
        config.rollupsAddress = args[++i];
        break;
    }
  }

  return config;
}

// ============ Constants ============

// Magic address for proxy detection
// When eth_getBalance is called for this address, the proxy returns a magic value
const PROXY_DETECTION_ADDRESS = "0x00000000000000000000000050524f5859525043"; // "PROXYRPC" in hex
const PROXY_DETECTION_MAGIC_BALANCE = "0x50524f5859525043"; // "PROXYRPC" in hex

// ============ Globals ============

let config: Config;
let provider: ethers.JsonRpcProvider;

// Cache of proxy address -> L2 address mappings (for hints)
const proxyToL2Cache: Map<string, string> = new Map();

// ============ Logging ============

function log(component: string, message: string) {
  const timestamp = new Date().toISOString().split("T")[1].split(".")[0];
  console.log(`[${timestamp}] [${component}] ${message}`);
}

// ============ Builder Integration ============

interface BuilderSubmitRequest {
  signedTx: string;
  hints?: {
    l2TargetAddress?: string;
    description?: string;
  };
  sourceChain: "L1" | "L2";
}

async function submitToBuilder(request: BuilderSubmitRequest): Promise<any> {
  log("L1Proxy", `Submitting to builder at ${config.builderUrl}/submit`);

  try {
    const response = await fetch(`${config.builderUrl}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const error = await response.text();
      log("L1Proxy", `Builder returned error: ${error}`);
      throw new Error(`Builder error: ${error}`);
    }

    const result = await response.json();
    log("L1Proxy", `Builder response: ${JSON.stringify(result).slice(0, 200)}`);
    return result;
  } catch (err: any) {
    log("L1Proxy", `Failed to submit to builder: ${err.message}`);
    throw err;
  }
}

// ============ RPC Forwarding ============

async function forwardToRpc(body: any): Promise<any> {
  try {
    const response = await fetch(config.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      const snippet = text.slice(0, 120);
      log(
        "L1Proxy",
        `Upstream RPC returned non-JSON (status ${response.status}): ${snippet}`
      );
      return {
        jsonrpc: "2.0",
        id: body?.id ?? null,
        error: {
          code: -32000,
          message: `Upstream RPC returned non-JSON (HTTP ${response.status})`,
        },
      };
    }
  } catch (err: any) {
    log("L1Proxy", `Upstream RPC request failed: ${err.message}`);
    return {
      jsonrpc: "2.0",
      id: body?.id ?? null,
      error: {
        code: -32000,
        message: `Upstream RPC request failed: ${err.message}`,
      },
    };
  }
}

// ============ Hint Registration ============

/**
 * Register a hint for an upcoming L1→L2 transaction
 * Called by the UI before sending the transaction
 */
function registerHint(proxyAddress: string, l2TargetAddress: string): void {
  proxyToL2Cache.set(proxyAddress.toLowerCase(), l2TargetAddress.toLowerCase());
  log("L1Proxy", `Registered hint: ${proxyAddress} -> ${l2TargetAddress}`);
}

// ============ Transaction Interception ============

/**
 * Handle eth_sendRawTransaction by routing through builder
 *
 * The builder will:
 * 1. Simulate the transaction to detect any L2 proxy calls
 * 2. If L2 calls are detected: pre-register responses and broadcast
 * 3. If no L2 calls: just forward to L1 node
 */
async function handleSendRawTransaction(
  signedTx: string,
  id: number | string
): Promise<any> {
  try {
    // Parse the transaction for logging purposes
    const tx = Transaction.from(signedTx);
    log("L1Proxy", `Intercepted tx from ${tx.from} to ${tx.to}`);
    log("L1Proxy", `  Value: ${ethers.formatEther(tx.value)} ETH`);

    // Check if we have a hint for the destination (L2 target for direct calls)
    const l2Target = tx.to ? proxyToL2Cache.get(tx.to.toLowerCase()) : null;

    if (l2Target) {
      // Route through builder — builder needs to prepare L1→L2 execution
      log("L1Proxy", `  Hint found: L2 target ${l2Target}, routing through builder...`);

      const hints: BuilderSubmitRequest["hints"] = {
        l2TargetAddress: l2Target,
        description: `L1→L2 transaction to ${l2Target}`,
      };

      const result = await submitToBuilder({
        signedTx,
        hints,
        sourceChain: "L1",
      });

      if (!result.success) {
        log("L1Proxy", `  Builder rejected: ${result.error}`);
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32000,
            message: result.error || "Builder rejected transaction",
          },
        };
      }

      log("L1Proxy", `  Builder accepted: ${result.l1TxHash}`);
      return {
        jsonrpc: "2.0",
        id,
        result: result.l1TxHash,
      };
    } else {
      // No hint — forward directly to L1 node.
      // This handles the common case where /prepare-l1-call already loaded
      // executions on L1. The user's tx just needs to reach Anvil directly.
      log("L1Proxy", `  No hint, forwarding directly to L1...`);

      const rpcResult = await forwardToRpc({
        jsonrpc: "2.0",
        method: "eth_sendRawTransaction",
        params: [signedTx],
        id,
      });

      if (rpcResult.result) {
        log("L1Proxy", `  L1 accepted: ${rpcResult.result}`);
      } else if (rpcResult.error) {
        log("L1Proxy", `  L1 error: ${rpcResult.error.message}`);
      }

      return rpcResult;
    }
  } catch (err: any) {
    log("L1Proxy", `Error handling tx: ${err.message}`);
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32000,
        message: err.message,
      },
    };
  }
}

// ============ HTTP Server ============

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
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

  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  // Handle hint registration endpoint
  if (url.pathname === "/register-hint" && req.method === "POST") {
    const body = await readBody(req);
    const { proxyAddress, l2TargetAddress } = JSON.parse(body);

    if (proxyAddress && l2TargetAddress) {
      registerHint(proxyAddress, l2TargetAddress);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
    } else {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing proxyAddress or l2TargetAddress" }));
    }
    return;
  }

  // Status endpoint
  if (url.pathname === "/status" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      proxy: true,
      type: "L1",
      rpcUrl: config.rpcUrl,
      builderUrl: config.builderUrl,
      registeredHints: proxyToL2Cache.size,
    }));
    return;
  }

  // Handle JSON-RPC requests
  if (req.method !== "POST") {
    res.writeHead(405);
    res.end("Method not allowed");
    return;
  }

  try {
    const body = await readBody(req);
    let request: any;
    try {
      request = JSON.parse(body);
    } catch {
      const snippet = body.slice(0, 120).replace(/\s+/g, " ");
      log("L1Proxy", `Invalid JSON-RPC payload (non-JSON body): ${snippet}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        })
      );
      return;
    }

    // Handle batch requests
    if (Array.isArray(request)) {
      const results = await Promise.all(
        request.map((r) => handleRpcRequest(r))
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(results));
      return;
    }

    // Handle single request
    const result = await handleRpcRequest(request);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  } catch (err: any) {
    log("L1Proxy", `Request error: ${err.message}`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32603, message: "Internal error" },
      })
    );
  }
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
  });
}

async function handleRpcRequest(request: any): Promise<any> {
  const { method, params, id } = request;

  // Intercept eth_getBalance for magic proxy detection address
  if (method === "eth_getBalance" && params?.[0]) {
    const address = params[0].toLowerCase();
    if (address === PROXY_DETECTION_ADDRESS.toLowerCase()) {
      log("L1Proxy", `Proxy detection check received`);
      return {
        jsonrpc: "2.0",
        id,
        result: PROXY_DETECTION_MAGIC_BALANCE,
      };
    }
  }

  // Intercept eth_getCode for magic proxy detection address
  if (method === "eth_getCode" && params?.[0]) {
    const address = params[0].toLowerCase();
    if (address === PROXY_DETECTION_ADDRESS.toLowerCase()) {
      log("L1Proxy", `Proxy detection check (code) received`);
      return {
        jsonrpc: "2.0",
        id,
        result: "0x50524f5859525043", // "PROXYRPC" in hex
      };
    }
  }

  // Intercept eth_sendRawTransaction
  if (method === "eth_sendRawTransaction" && params?.[0]) {
    return handleSendRawTransaction(params[0], id);
  }

  // Forward all other requests to the underlying RPC
  return forwardToRpc(request);
}

// ============ Main ============

async function main() {
  config = parseArgs();

  log("L1Proxy", "=== L1 RPC Proxy Server ===");
  log("L1Proxy", `Underlying RPC: ${config.rpcUrl}`);
  log("L1Proxy", `Builder API: ${config.builderUrl}`);
  if (config.rollupsAddress) {
    log("L1Proxy", `Rollups: ${config.rollupsAddress}`);
  }

  // Initialize provider
  provider = new ethers.JsonRpcProvider(config.rpcUrl);

  // Verify connection to underlying RPC
  try {
    const blockNumber = await provider.getBlockNumber();
    log("L1Proxy", `Connected to L1 RPC. Block: ${blockNumber}`);
  } catch (err: any) {
    log("L1Proxy", `Warning: Could not connect to L1 RPC: ${err.message}`);
  }

  // Verify connection to builder
  try {
    const response = await fetch(`${config.builderUrl}/status`);
    if (response.ok) {
      const status = await response.json();
      log("L1Proxy", `Connected to Builder. Synced: ${status.isSynced}`);
    }
  } catch (err: any) {
    log("L1Proxy", `Warning: Could not connect to Builder: ${err.message}`);
  }

  // Start server
  const server = http.createServer(handleRequest);
  server.listen(config.port, () => {
    log("L1Proxy", "");
    log("L1Proxy", `L1 Proxy listening on http://localhost:${config.port}`);
    log("L1Proxy", "");
    log("L1Proxy", "Configure your wallet to use this RPC URL for L1:");
    log("L1Proxy", `  http://localhost:${config.port}`);
    log("L1Proxy", "");
    log("L1Proxy", "Endpoints:");
    log("L1Proxy", `  POST /                 - JSON-RPC (proxied)`);
    log("L1Proxy", `  POST /register-hint    - Register L1→L2 hint`);
    log("L1Proxy", `  GET  /status           - Proxy status`);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
