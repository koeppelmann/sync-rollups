#!/usr/bin/env npx tsx
/**
 * Compute the L2 genesis state root for a given rollup configuration.
 *
 * The operator key is derived deterministically from public parameters
 * (rollupsAddress, rollupId, chainId) — no private key input needed.
 *
 * Usage:
 *   npx tsx scripts/compute-genesis-root.ts \
 *     --rollups 0x... \
 *     --contracts-out /path/to/sync-rollups/out
 *
 * Prints the genesis state root (hex) to stdout.
 * All other logging goes to stderr so the script can be used in $(...).
 */

import { ChildProcess, spawn } from "child_process";
import { Wallet, solidityPackedKeccak256 } from "ethers";
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

const OPERATOR_INITIAL_BALANCE = "0xc9f2c9cd04674edea40000000"; // 10^30

function log(msg: string) {
  process.stderr.write(`[genesis-root] ${msg}\n`);
}

function loadContractArtifact(outDir: string, contractName: string, fileName: string): any | null {
  const artifactPath = join(outDir, fileName, `${contractName}.json`);
  if (!existsSync(artifactPath)) {
    log(`WARNING: artifact not found: ${artifactPath}`);
    return null;
  }
  return JSON.parse(readFileSync(artifactPath, "utf-8"));
}

/**
 * Get deployed bytecode with immutables spliced in.
 */
function getDeployedBytecodeWithImmutables(
  artifact: any,
  immutableValues: Record<string, string>
): string | null {
  const bytecodeHex = artifact.deployedBytecode?.object;
  if (!bytecodeHex) return null;

  let code = bytecodeHex.startsWith("0x") ? bytecodeHex.slice(2) : bytecodeHex;

  const immutableRefs = artifact.deployedBytecode?.immutableReferences;
  if (!immutableRefs) return "0x" + code;

  // Map AST IDs to variable names
  const astIdToName: Record<string, string> = {};
  const ast = artifact.ast;
  if (ast) {
    const findImmutables = (node: any) => {
      if (node.nodeType === "VariableDeclaration" && node.mutability === "immutable") {
        astIdToName[node.id.toString()] = node.name;
      }
      if (node.nodes) node.nodes.forEach(findImmutables);
      if (node.body?.statements) node.body.statements.forEach(findImmutables);
    };
    findImmutables(ast);
  }

  for (const [astId, refs] of Object.entries(immutableRefs) as [string, any[]]) {
    const name = astIdToName[astId];
    if (!name) { log(`Unknown immutable AST ID ${astId}`); continue; }
    const value = immutableValues[name];
    if (!value) { log(`No value for immutable ${name}`); continue; }
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
 * Derive operator key deterministically — same logic as state-manager.ts.
 */
function deriveOperatorKey(rollupsAddress: string, rollupId: number, l2ChainId: number): string {
  return solidityPackedKeccak256(
    ["string", "address", "uint256", "uint256"],
    ["sync-rollups-operator", rollupsAddress, rollupId, l2ChainId]
  );
}

async function main() {
  const args = process.argv.slice(2);
  const getArg = (name: string): string => {
    const idx = args.indexOf(`--${name}`);
    if (idx !== -1 && args[idx + 1]) return args[idx + 1];
    throw new Error(`Missing required argument: --${name}`);
  };

  const rollupsAddress = getArg("rollups");
  const contractsOutDir = getArg("contracts-out");
  const rollupId = parseInt(args.indexOf("--rollup-id") !== -1 ? getArg("rollup-id") : "0");
  const l2ChainId = parseInt(args.indexOf("--l2-chain-id") !== -1 ? getArg("l2-chain-id") : "10200200");

  // Derive operator key deterministically
  const operatorKey = deriveOperatorKey(rollupsAddress, rollupId, l2ChainId);
  const operatorWallet = new Wallet(operatorKey);
  log(`Operator address: ${operatorWallet.address} (deterministic)`);

  // Build genesis alloc
  const alloc: Record<string, any> = {};

  // Fund operator
  alloc[operatorWallet.address.toLowerCase()] = {
    balance: OPERATOR_INITIAL_BALANCE,
  };

  // CrossChainManagerL2 at Rollups address (with immutables spliced in)
  const artifact = loadContractArtifact(contractsOutDir, "CrossChainManagerL2", "CrossChainManagerL2.sol");
  if (artifact) {
    const bytecode = getDeployedBytecodeWithImmutables(artifact, {
      ROLLUP_ID: rollupId.toString(16).padStart(64, "0"),
      SYSTEM_ADDRESS: operatorWallet.address.slice(2).toLowerCase().padStart(64, "0"),
    });

    if (bytecode) {
      alloc[rollupsAddress.toLowerCase()] = {
        code: bytecode,
        balance: "0x0",
      };
      log(`CrossChainManagerL2 at ${rollupsAddress} (SYSTEM_ADDRESS=${operatorWallet.address})`);
    }
  }

  const genesis = {
    config: {
      chainId: l2ChainId,
      homesteadBlock: 0, eip150Block: 0, eip155Block: 0, eip158Block: 0,
      byzantiumBlock: 0, constantinopleBlock: 0, petersburgBlock: 0,
      istanbulBlock: 0, berlinBlock: 0, londonBlock: 0,
      shanghaiTime: 0, cancunTime: 0,
      terminalTotalDifficulty: 0, terminalTotalDifficultyPassed: true,
    },
    nonce: "0x0", timestamp: "0x0", extraData: "0x",
    gasLimit: "0x1c9c380", difficulty: "0x0",
    mixHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
    coinbase: "0x0000000000000000000000000000000000000000",
    baseFeePerGas: "0x3B9ACA00", number: "0x0", gasUsed: "0x0",
    parentHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
    alloc,
  };

  // Write genesis to a temp directory
  const tmpDir = join("/tmp", `genesis-root-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  const genesisPath = join(tmpDir, "genesis.json");
  writeFileSync(genesisPath, JSON.stringify(genesis, null, 2));

  // Start a temporary reth instance to compute the state root
  const httpPort = 19999;
  const p2pPort = 39999;
  const authPort = 18999;
  const rethBinary = process.env.SYNC_ROLLUPS_RETH || "reth";

  log("Starting temporary reth to compute genesis state root...");
  const rethProcess: ChildProcess = spawn(
    rethBinary,
    [
      "node", "--dev",
      "--http", "--http.port", httpPort.toString(),
      "--http.api", "eth",
      "--chain", genesisPath,
      "--datadir", join(tmpDir, "reth"),
      "--log.stdout.filter", "error",
      "--disable-discovery",
      "--port", p2pPort.toString(),
      "--authrpc.port", authPort.toString(),
    ],
    { stdio: ["ignore", "ignore", "pipe"], detached: true }
  );

  rethProcess.stderr?.on("data", (data: Buffer) => {
    const msg = data.toString().trim();
    if (msg) log(`[reth] ${msg}`);
  });

  try {
    // Wait for reth to start
    const startTime = Date.now();
    while (Date.now() - startTime < 30000) {
      try {
        const resp = await fetch(`http://localhost:${httpPort}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method: "eth_blockNumber", params: [], id: 1 }),
        });
        if (resp.ok) break;
      } catch {}
      await new Promise(r => setTimeout(r, 200));
    }

    // Get block 0 state root
    const resp = await fetch(`http://localhost:${httpPort}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "eth_getBlockByNumber",
        params: ["0x0", false],
        id: 1,
      }),
    });
    const data = await resp.json() as any;
    const stateRoot: string = data.result.stateRoot;

    log(`Genesis state root: ${stateRoot}`);

    // Print ONLY the state root to stdout (for use in scripts)
    process.stdout.write(stateRoot);
  } finally {
    // Clean up
    rethProcess.kill();
    await new Promise(r => setTimeout(r, 500));
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

main().catch((e) => {
  log(`ERROR: ${e.message}`);
  process.exit(1);
});
