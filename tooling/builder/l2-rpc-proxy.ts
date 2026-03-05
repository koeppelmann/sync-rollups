/**
 * L2 RPC Proxy Server
 *
 * A proxy that sits between the wallet and the L2 fullnode.
 * It forwards all READ requests to the fullnode, but intercepts:
 * - eth_sendRawTransaction: Routes through the Builder API which wraps
 *   the transaction in executeL2TX() on L1
 *
 * This ensures the L2 state is ONLY derived from L1, not from direct
 * transaction submission to the L2 node.
 *
 * Usage:
 *   npx tsx builder/l2-rpc-proxy.ts [options]
 *
 * Options:
 *   --port <port>       Proxy port (default: 9548)
 *   --rpc <url>         L2 Fullnode RPC URL (default: http://localhost:9547)
 *   --builder <url>     Builder API URL (default: http://localhost:3200)
 */

import * as http from "http";
import { ethers, Transaction } from "ethers";

// ============ Configuration ============

interface Config {
  port: number;
  rpcUrl: string;
  builderUrl: string;
}

function parseArgs(): Config {
  const args = process.argv.slice(2);
  const config: Config = {
    port: 9548,
    rpcUrl: "http://localhost:9547",
    builderUrl: "http://localhost:3200",
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
    }
  }

  return config;
}

// ============ Constants ============

// Magic address for L2 proxy detection
// When eth_getBalance is called for this address, the proxy returns a magic value
const L2_PROXY_DETECTION_ADDRESS = "0x0000000000000000000000004c3250524f585952"; // "L2PROXYR" in hex
const L2_PROXY_DETECTION_MAGIC_BALANCE = "0x4c3250524f585952"; // "L2PROXYR" in hex

// ============ Globals ============

let config: Config;
let provider: ethers.JsonRpcProvider;

// Pending hints keyed by sender address (lowercase) - consumed on next eth_sendRawTransaction
const pendingHints: Map<string, any> = new Map();

// ============ Logging ============

function log(component: string, message: string) {
  const timestamp = new Date().toISOString().split("T")[1].split(".")[0];
  console.log(`[${timestamp}] [${component}] ${message}`);
}

// ============ Builder Integration ============

interface BuilderSubmitRequest {
  signedTx: string;
  sourceChain: "L1" | "L2";
  hints?: any;
}

async function submitToBuilder(request: BuilderSubmitRequest): Promise<any> {
  log("L2Proxy", `Submitting L2 tx to builder at ${config.builderUrl}/submit`);

  try {
    const response = await fetch(`${config.builderUrl}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const error = await response.text();
      log("L2Proxy", `Builder returned error: ${error}`);
      throw new Error(`Builder error: ${error}`);
    }

    const result = await response.json();
    log("L2Proxy", `Builder response: ${JSON.stringify(result).slice(0, 200)}`);
    return result;
  } catch (err: any) {
    log("L2Proxy", `Failed to submit to builder: ${err.message}`);
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
        "L2Proxy",
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
    log("L2Proxy", `Upstream RPC request failed: ${err.message}`);
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

// ============ Transaction Handling ============

async function handleSendRawTransaction(
  signedTx: string,
  id: number | string
): Promise<any> {
  try {
    // Parse the transaction to log details
    const tx = Transaction.from(signedTx);
    log("L2Proxy", `Intercepted L2 tx from ${tx.from} to ${tx.to}`);
    log("L2Proxy", `  Value: ${ethers.formatEther(tx.value)} ETH`);
    log("L2Proxy", `  Routing through builder (executeL2TX)...`);

    // Check for pre-registered hints for this sender
    const senderKey = tx.from?.toLowerCase();
    const hints = senderKey ? pendingHints.get(senderKey) : undefined;
    if (hints) {
      pendingHints.delete(senderKey!);
      log("L2Proxy", `  Using pre-registered hints: ${JSON.stringify(hints)}`);
    }

    // Submit to builder with sourceChain: L2
    const result = await submitToBuilder({
      signedTx,
      sourceChain: "L2",
      ...(hints ? { hints } : {}),
    });

    log("L2Proxy", `  L1 tx hash: ${result.l1TxHash}`);

    // Return the L1 tx hash (represents the L2 tx being included)
    // The wallet will see this as the tx hash
    return {
      jsonrpc: "2.0",
      id,
      result: result.l1TxHash,
    };
  } catch (err: any) {
    log("L2Proxy", `Error handling L2 tx: ${err.message}`);
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

  // Hint registration endpoint
  if (url.pathname === "/register-hint" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const hint = JSON.parse(body);
      // Store hint keyed by sender address
      if (hint.sender) {
        const key = hint.sender.toLowerCase();
        pendingHints.set(key, hint);
        log("L2Proxy", `Registered hint for ${key}: ${JSON.stringify(hint)}`);
        // Auto-expire after 60 seconds
        setTimeout(() => pendingHints.delete(key), 60000);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (err: any) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Status endpoint
  if (url.pathname === "/status" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      proxy: true,
      type: "L2",
      rpcUrl: config.rpcUrl,
      builderUrl: config.builderUrl,
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
      log("L2Proxy", `Invalid JSON-RPC payload (non-JSON body): ${snippet}`);
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
    log("L2Proxy", `Request error: ${err.message}`);
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

  // Intercept eth_getBalance for magic L2 proxy detection address
  if (method === "eth_getBalance" && params?.[0]) {
    const address = params[0].toLowerCase();
    if (address === L2_PROXY_DETECTION_ADDRESS.toLowerCase()) {
      log("L2Proxy", `L2 Proxy detection check received`);
      return {
        jsonrpc: "2.0",
        id,
        result: L2_PROXY_DETECTION_MAGIC_BALANCE,
      };
    }
  }

  // Intercept eth_getCode for magic proxy detection address
  if (method === "eth_getCode" && params?.[0]) {
    const address = params[0].toLowerCase();
    if (address === L2_PROXY_DETECTION_ADDRESS.toLowerCase()) {
      log("L2Proxy", `L2 Proxy detection check (code) received`);
      return {
        jsonrpc: "2.0",
        id,
        result: "0x4c3250524f585952", // "L2PROXYR" in hex
      };
    }
  }

  // Intercept eth_sendRawTransaction - route through builder
  if (method === "eth_sendRawTransaction" && params?.[0]) {
    return handleSendRawTransaction(params[0], id);
  }

  // Forward all other requests (reads) to the L2 fullnode
  return forwardToRpc(request);
}

// ============ Main ============

async function main() {
  config = parseArgs();

  log("L2Proxy", "=== L2 RPC Proxy Server ===");
  log("L2Proxy", `L2 Fullnode RPC: ${config.rpcUrl}`);
  log("L2Proxy", `Builder API: ${config.builderUrl}`);

  // Initialize provider
  provider = new ethers.JsonRpcProvider(config.rpcUrl);

  // Verify connection to L2 fullnode
  try {
    const blockNumber = await provider.getBlockNumber();
    log("L2Proxy", `Connected to L2 fullnode. Block: ${blockNumber}`);
  } catch (err: any) {
    log("L2Proxy", `Warning: Could not connect to L2 fullnode: ${err.message}`);
  }

  // Verify connection to builder
  try {
    const response = await fetch(`${config.builderUrl}/status`);
    if (response.ok) {
      const status = await response.json();
      log("L2Proxy", `Connected to Builder. Synced: ${status.isSynced}`);
    }
  } catch (err: any) {
    log("L2Proxy", `Warning: Could not connect to Builder: ${err.message}`);
  }

  // Start server
  const server = http.createServer(handleRequest);
  server.listen(config.port, () => {
    log("L2Proxy", "");
    log("L2Proxy", `L2 Proxy listening on http://localhost:${config.port}`);
    log("L2Proxy", "");
    log("L2Proxy", "Configure your wallet to use this RPC URL for L2:");
    log("L2Proxy", `  http://localhost:${config.port}`);
    log("L2Proxy", "");
    log("L2Proxy", "All L2 transactions will be routed through the builder,");
    log("L2Proxy", "ensuring L2 state is derived only from L1.");
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
