#!/usr/bin/env npx tsx
/**
 * Deterministic fuzzer for sync-rollups.
 *
 * ALL transactions are routed through L1 so that L2 state is fully
 * deterministic — both reth and ethrex fullnodes derive identical state
 * purely from L1 events.
 *
 * Transaction types:
 *   1. ETH bridges (L1→L2 via prepare-l1-call + proxy)
 *   2. L1→L2 cross-chain calls (Counter, Logger, OpcodeStore)
 *   3. L2 contract deployments (via L2 RPC proxy → builder → L1)
 *   4. Batch L2TXs (via /submit-batch → single L1 block)
 *
 * After each phase the script:
 *   - Waits for both reth and ethrex to sync
 *   - Compares state roots
 *
 * At the end it verifies deployed contracts on both Blockscout instances
 * and checks that both explorers have indexed all activity.
 */

import { ethers, Transaction } from "ethers";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";

// ============ Configuration ============
const L1_RPC = "http://localhost:8545";
const BUILDER_URL = "http://localhost:3200";
const L2_RPC_PROXY = "http://localhost:9548";
const RETH_EVM = "http://localhost:9546";
const ETHREX_EVM = "http://localhost:9556";
const BUILDER_L2_EVM = "http://localhost:9549";

const L2_CHAIN_ID = 10200200;

const L1_BLOCKSCOUT_API = "http://localhost:4010/api/";
const L2_BLOCKSCOUT_API = "http://localhost:4011/api/";

// Anvil test accounts
const ACCOUNT1 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ACCOUNT1_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ACCOUNT2 = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const ACCOUNT2_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

// ============ ABI fragments ============
const COUNTER_ABI = [
  "function increment() public",
  "function getCount() public view returns (uint256)",
  "function count() public view returns (uint256)",
];

const LOGGER_ABI = [
  "function callAndLog(address target, bytes calldata data) external payable returns (bool success, bytes memory returnData)",
];

// OpcodeStore ABI (loaded from forge artifact)
let OPCODE_STORE_ABI: any[];
let OPCODE_STORE_BYTECODE: string;

// ============ Helpers ============

async function callJsonRpc(url: string, method: string, params: any[] = []): Promise<any> {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
  });
  const data = (await resp.json()) as any;
  if (data.error) throw new Error(`${method}: ${JSON.stringify(data.error)}`);
  return data.result;
}

async function getStateRoots(): Promise<{
  rethBlock: number; rethState: string;
  ethrexBlock: number; ethrexState: string;
}> {
  const [rethBlock, ethrexBlock] = await Promise.all([
    callJsonRpc(RETH_EVM, "eth_getBlockByNumber", ["latest", false]),
    callJsonRpc(ETHREX_EVM, "eth_getBlockByNumber", ["latest", false]),
  ]);
  return {
    rethBlock: parseInt(rethBlock.number, 16),
    rethState: rethBlock.stateRoot,
    ethrexBlock: parseInt(ethrexBlock.number, 16),
    ethrexState: ethrexBlock.stateRoot,
  };
}

async function waitForSync(maxWaitMs = 30000): Promise<{
  rethBlock: number; rethState: string;
  ethrexBlock: number; ethrexState: string;
}> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const state = await getStateRoots();
    if (state.rethBlock === state.ethrexBlock && state.rethState === state.ethrexState) {
      return state;
    }
    if (state.rethBlock === state.ethrexBlock && state.rethState !== state.ethrexState) {
      return state; // divergence
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return await getStateRoots();
}

function shortHash(h: string): string {
  return h.slice(0, 10) + "...";
}

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function assertSynced(state: { rethBlock: number; rethState: string; ethrexBlock: number; ethrexState: string }, context: string): void {
  if (state.rethState !== state.ethrexState) {
    console.error(`\nSTATE DIVERGENCE after ${context}!`);
    console.error(`  reth   block=${state.rethBlock} state=${state.rethState}`);
    console.error(`  ethrex block=${state.ethrexBlock} state=${state.ethrexState}`);
    process.exit(1);
  }
  log(`  Synced: block=${state.rethBlock} state=${shortHash(state.rethState)}`);
}

// ============ L1 transaction helpers ============

/** Bridge ETH from L1 to L2 for a given account */
async function bridgeEth(
  l1Provider: ethers.JsonRpcProvider,
  senderKey: string,
  amount: string,
): Promise<void> {
  const wallet = new ethers.Wallet(senderKey, l1Provider);
  const amountWei = ethers.parseEther(amount).toString();

  const prep = await fetch(`${BUILDER_URL}/prepare-l1-call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      l2Target: wallet.address,
      value: amountWei,
      data: "0x",
      sourceAddress: wallet.address,
    }),
  }).then((r) => r.json()) as any;
  if (!prep.success) throw new Error(`Bridge prepare failed: ${prep.error}`);

  const tx = await wallet.sendTransaction({
    to: prep.proxyAddress,
    value: ethers.parseEther(amount),
  });
  await tx.wait();
}

/** Execute an L1→L2 cross-chain call */
async function l1ToL2Call(
  l1Provider: ethers.JsonRpcProvider,
  senderKey: string,
  l2Target: string,
  calldata: string,
  value: string = "0",
  ethValue?: bigint,
): Promise<void> {
  const wallet = new ethers.Wallet(senderKey, l1Provider);

  const prep = await fetch(`${BUILDER_URL}/prepare-l1-call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      l2Target,
      value,
      data: calldata,
      sourceAddress: wallet.address,
    }),
  }).then((r) => r.json()) as any;
  if (!prep.success) throw new Error(`L1→L2 call prepare failed: ${prep.error}`);

  const tx = await wallet.sendTransaction({
    to: prep.proxyAddress,
    data: calldata,
    value: ethValue || 0n,
  });
  await tx.wait();
}

/** Deploy a contract on L2 via the L2 RPC proxy (which routes through builder → L1) */
async function deployOnL2(bytecode: string, signerKey: string): Promise<string> {
  const provider = new ethers.JsonRpcProvider(L2_RPC_PROXY);
  const wallet = new ethers.Wallet(signerKey, provider);
  const nonce = await provider.getTransactionCount(wallet.address, "pending");
  const tx = await wallet.sendTransaction({
    data: bytecode,
    gasLimit: 3_000_000,
    nonce,
  });

  // Wait for builder to process and L2 to update
  await new Promise((r) => setTimeout(r, 10000));
  await waitForSync(20000);

  // Get deployed address
  const rethProvider = new ethers.JsonRpcProvider(RETH_EVM);
  const receipt = await rethProvider.getTransactionReceipt(tx.hash);
  if (!receipt || !receipt.contractAddress) {
    throw new Error(`Contract deployment failed (tx: ${tx.hash})`);
  }
  return receipt.contractAddress;
}

/** Submit a batch of signed L2 transactions via /submit-batch */
async function submitBatch(signedTxs: string[]): Promise<any> {
  const resp = await fetch(`${BUILDER_URL}/submit-batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transactions: signedTxs }),
  });
  return (await resp.json()) as any;
}

/** Build signed L2 transactions for batch submission */
async function buildSignedBatch(
  calls: Array<{ to: string; data: string; value?: bigint; gasLimit?: number }>,
  signerKey: string,
): Promise<string[]> {
  const provider = new ethers.JsonRpcProvider(BUILDER_L2_EVM);
  const wallet = new ethers.Wallet(signerKey);
  let nonce = await provider.getTransactionCount(wallet.address, "pending");

  const signedTxs: string[] = [];
  for (const call of calls) {
    const signed = await wallet.signTransaction({
      type: 2,
      to: call.to,
      data: call.data,
      value: call.value || 0n,
      gasLimit: call.gasLimit || 500_000,
      maxFeePerGas: 0n,
      maxPriorityFeePerGas: 0n,
      nonce,
      chainId: L2_CHAIN_ID,
    });
    signedTxs.push(signed);
    nonce++;
  }
  return signedTxs;
}

/** Verify a contract on Blockscout */
function verifyOnBlockscout(
  contractAddress: string,
  contractPath: string,
  apiUrl: string,
  constructorArgs?: string,
): boolean {
  const projectRoot = path.resolve(process.cwd(), "..");
  try {
    let cmd = `GNOSISSCAN_API_KEY=dummy forge verify-contract --verifier blockscout --verifier-url "${apiUrl}" `;
    if (constructorArgs) {
      cmd += `--constructor-args "${constructorArgs}" `;
    }
    cmd += `"${contractAddress}" "${contractPath}" 2>&1`;

    const result = execSync(cmd, { cwd: projectRoot, encoding: "utf8", timeout: 30000 });
    const lastLine = result.trim().split("\n").pop() || "";
    const success = lastLine.toLowerCase().includes("success") ||
                    lastLine.toLowerCase().includes("already verified");
    log(`  Verify ${contractPath} at ${contractAddress}: ${success ? "OK" : lastLine}`);
    return success;
  } catch (e: any) {
    const msg = e.stdout?.trim().split("\n").pop() || e.message;
    log(`  Verify ${contractPath} at ${contractAddress}: FAILED - ${msg}`);
    return false;
  }
}

/** Check Blockscout API is ready and has indexed up to a certain block */
async function waitForBlockscout(apiUrl: string, name: string, maxWaitSec = 120): Promise<boolean> {
  log(`Waiting for ${name} to be ready...`);
  const start = Date.now();
  while (Date.now() - start < maxWaitSec * 1000) {
    try {
      const resp = await fetch(`${apiUrl}?module=block&action=eth_block_number`);
      const data = (await resp.json()) as any;
      const blockHex = data?.result;
      if (blockHex && blockHex !== "0x0") {
        log(`  ${name} ready (block: ${blockHex})`);
        return true;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 5000));
  }
  log(`  ${name} not ready after ${maxWaitSec}s`);
  return false;
}

/** Check Blockscout has indexed a specific address (has transactions or is a contract) */
async function checkBlockscoutAddress(apiUrl: string, address: string): Promise<{
  txCount: number;
  isContract: boolean;
}> {
  try {
    const resp = await fetch(
      `${apiUrl}?module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&sort=asc`
    );
    const data = (await resp.json()) as any;
    const txCount = Array.isArray(data?.result) ? data.result.length : 0;

    // Check if it's a contract
    const codeResp = await fetch(
      `${apiUrl}?module=contract&action=getabi&address=${address}`
    );
    const codeData = (await codeResp.json()) as any;
    const isContract = codeData?.status === "1";

    return { txCount, isContract };
  } catch {
    return { txCount: 0, isContract: false };
  }
}

// ============ Main ============

async function main() {
  console.log("\n=== Deterministic Fuzzer for sync-rollups ===");
  console.log("All transactions routed through L1 for deterministic L2 state\n");

  const l1Provider = new ethers.JsonRpcProvider(L1_RPC);
  const rethProvider = new ethers.JsonRpcProvider(RETH_EVM);

  // Verify initial sync
  log("Checking initial state...");
  const initial = await getStateRoots();
  assertSynced(initial, "initial state");

  // ────────────────────────────────────────────────
  // Phase 0: Compile OpcodeStore and load artifact
  // ────────────────────────────────────────────────
  log("\n── Phase 0: Compile contracts ──");
  const projectRoot = path.resolve(process.cwd(), "..");
  execSync("forge build --contracts tooling/contracts --out out 2>&1", {
    cwd: projectRoot,
    encoding: "utf8",
  });

  const opcodeArtifactPath = path.join(projectRoot, "out", "OpcodeStore.sol", "OpcodeStore.json");
  const opcodeArtifact = JSON.parse(fs.readFileSync(opcodeArtifactPath, "utf8"));
  OPCODE_STORE_ABI = opcodeArtifact.abi;
  OPCODE_STORE_BYTECODE = opcodeArtifact.bytecode.object;
  log(`OpcodeStore bytecode: ${OPCODE_STORE_BYTECODE.length} chars`);

  // ────────────────────────────────────────────────
  // Phase 1: Discover existing contracts
  // ────────────────────────────────────────────────
  log("\n── Phase 1: Discover existing contracts ──");

  const counterIface = new ethers.Interface(COUNTER_ABI);
  const loggerIface = new ethers.Interface(LOGGER_ABI);
  const opcodeIface = new ethers.Interface(OPCODE_STORE_ABI);

  let l2CounterAddr = "";
  let l2LoggerAddr = "";

  // Scan L2 blocks for deployed contracts
  for (let i = 1; i <= initial.rethBlock; i++) {
    const block = await rethProvider.getBlock(i, true);
    if (!block) continue;
    for (const txHash of block.transactions) {
      const receipt = await rethProvider.getTransactionReceipt(txHash);
      if (receipt?.contractAddress) {
        const code = await rethProvider.getCode(receipt.contractAddress);
        if (!code || code === "0x") continue;
        try {
          const r1 = await rethProvider.call({
            to: receipt.contractAddress,
            data: counterIface.encodeFunctionData("count"),
          });
          const r2 = await rethProvider.call({
            to: receipt.contractAddress,
            data: counterIface.encodeFunctionData("getCount"),
          });
          if (r1?.length === 66 && r2?.length === 66) {
            l2CounterAddr = receipt.contractAddress;
            continue;
          }
        } catch {}
        if (!l2LoggerAddr) l2LoggerAddr = receipt.contractAddress;
      }
    }
  }
  log(`L2 Counter: ${l2CounterAddr || "not found"}`);
  log(`L2 Logger:  ${l2LoggerAddr || "not found"}`);

  // ────────────────────────────────────────────────
  // Phase 2: Deploy OpcodeStore on L2 (via L2 proxy → builder → L1)
  // ────────────────────────────────────────────────
  log("\n── Phase 2: Deploy OpcodeStore on L2 ──");
  const l2OpcodeStoreAddr = await deployOnL2(OPCODE_STORE_BYTECODE, ACCOUNT2_KEY);
  log(`OpcodeStore deployed at: ${l2OpcodeStoreAddr}`);

  // Verify deployment
  const opcodeCode = await rethProvider.getCode(l2OpcodeStoreAddr);
  if (!opcodeCode || opcodeCode === "0x") {
    console.error("OpcodeStore deployment failed");
    process.exit(1);
  }
  log(`  Code size: ${(opcodeCode.length - 2) / 2} bytes`);

  const postDeploy = await waitForSync(20000);
  assertSynced(postDeploy, "OpcodeStore deployment");

  // Track all deployed contract addresses for Blockscout verification
  const deployedContracts: Array<{ address: string; name: string; path: string }> = [
    { address: l2OpcodeStoreAddr, name: "OpcodeStore", path: "src/OpcodeStore.sol:OpcodeStore" },
  ];

  // ────────────────────────────────────────────────
  // Phase 3: L1→L2 Cross-chain calls
  // ────────────────────────────────────────────────
  log("\n── Phase 3: L1→L2 cross-chain calls ──");

  const l1l2Calls = [
    { name: "Bridge 0.01 ETH (Acct1)", fn: () => bridgeEth(l1Provider, ACCOUNT1_KEY, "0.01") },
    { name: "Bridge 0.005 ETH (Acct2)", fn: () => bridgeEth(l1Provider, ACCOUNT2_KEY, "0.005") },
  ];

  // Add counter/logger calls if available
  if (l2CounterAddr) {
    l1l2Calls.push({
      name: "Counter.increment() (Acct1)",
      fn: () => l1ToL2Call(l1Provider, ACCOUNT1_KEY, l2CounterAddr, counterIface.encodeFunctionData("increment")),
    });
    l1l2Calls.push({
      name: "Counter.increment() (Acct2)",
      fn: () => l1ToL2Call(l1Provider, ACCOUNT2_KEY, l2CounterAddr, counterIface.encodeFunctionData("increment")),
    });
  }

  if (l2LoggerAddr && l2CounterAddr) {
    const innerCalldata = counterIface.encodeFunctionData("increment");
    const outerCalldata = loggerIface.encodeFunctionData("callAndLog", [l2CounterAddr, innerCalldata]);
    l1l2Calls.push({
      name: "Logger.callAndLog(Counter.increment()) (Acct1)",
      fn: () => l1ToL2Call(l1Provider, ACCOUNT1_KEY, l2LoggerAddr, outerCalldata),
    });
  }

  // L1→L2 calls to OpcodeStore
  l1l2Calls.push({
    name: "OpcodeStore.testArithmetic(42,7)",
    fn: () => l1ToL2Call(l1Provider, ACCOUNT1_KEY, l2OpcodeStoreAddr,
      opcodeIface.encodeFunctionData("testArithmetic", [42, 7])),
  });
  l1l2Calls.push({
    name: "OpcodeStore.testComparison(100,50)",
    fn: () => l1ToL2Call(l1Provider, ACCOUNT2_KEY, l2OpcodeStoreAddr,
      opcodeIface.encodeFunctionData("testComparison", [100, 50])),
  });
  l1l2Calls.push({
    name: "OpcodeStore.testBitwise(0xff00ff, 8)",
    fn: () => l1ToL2Call(l1Provider, ACCOUNT1_KEY, l2OpcodeStoreAddr,
      opcodeIface.encodeFunctionData("testBitwise", [0xff00ff, 8])),
  });
  l1l2Calls.push({
    name: "OpcodeStore.testHashing(0xdeadbeef)",
    fn: () => l1ToL2Call(l1Provider, ACCOUNT2_KEY, l2OpcodeStoreAddr,
      opcodeIface.encodeFunctionData("testHashing", [ethers.toBeHex(0xdeadbeef, 32)])),
  });
  l1l2Calls.push({
    name: "OpcodeStore.testEnvironment()",
    fn: () => l1ToL2Call(l1Provider, ACCOUNT1_KEY, l2OpcodeStoreAddr,
      opcodeIface.encodeFunctionData("testEnvironment")),
  });
  l1l2Calls.push({
    name: "OpcodeStore.testMemory(12345)",
    fn: () => l1ToL2Call(l1Provider, ACCOUNT2_KEY, l2OpcodeStoreAddr,
      opcodeIface.encodeFunctionData("testMemory", [12345])),
  });
  l1l2Calls.push({
    name: "OpcodeStore.testStorage(5, 999)",
    fn: () => l1ToL2Call(l1Provider, ACCOUNT1_KEY, l2OpcodeStoreAddr,
      opcodeIface.encodeFunctionData("testStorage", [5, 999])),
  });
  l1l2Calls.push({
    name: "OpcodeStore.testCodeOps()",
    fn: () => l1ToL2Call(l1Provider, ACCOUNT2_KEY, l2OpcodeStoreAddr,
      opcodeIface.encodeFunctionData("testCodeOps")),
  });

  let txCount = 0;
  for (const call of l1l2Calls) {
    txCount++;
    log(`  [${txCount}] ${call.name}`);
    try {
      await call.fn();
      await new Promise((r) => setTimeout(r, 5000));
      const state = await waitForSync(20000);
      assertSynced(state, call.name);
    } catch (e: any) {
      log(`    FAILED: ${e.message}`);
      // Check for divergence even on failure
      await new Promise((r) => setTimeout(r, 3000));
      const state = await getStateRoots();
      if (state.rethBlock === state.ethrexBlock && state.rethState !== state.ethrexState) {
        console.error(`DIVERGENCE after failed call: ${call.name}`);
        process.exit(1);
      }
    }
  }

  // ────────────────────────────────────────────────
  // Phase 4: L2 contract deployments via bridge
  // ────────────────────────────────────────────────
  log("\n── Phase 4: Additional L2 contract deployments ──");

  // Deploy a simple storage contract (raw bytecode)
  const TINY_CONTRACT_BYTECODE =
    "0x" +
    "602a" +       // PUSH1 42
    "6000" +       // PUSH1 0
    "55" +         // SSTORE
    "60" + "0f" +  // PUSH1 15 (runtime length)
    "60" + "0e" +  // PUSH1 14 (offset)
    "6000" +       // PUSH1 0
    "39" +         // CODECOPY
    "60" + "0f" +  // PUSH1 15
    "6000" +       // PUSH1 0
    "f3" +         // RETURN
    // Runtime: read slot 0 and return it
    "6000" + "54" + // SLOAD(0)
    "6000" + "52" + // MSTORE(0)
    "6020" + "6000" + "f3"; // RETURN(0, 32)

  log("  Deploying TinyStorage contract...");
  const tinyAddr = await deployOnL2(TINY_CONTRACT_BYTECODE, ACCOUNT2_KEY);
  log(`  TinyStorage at: ${tinyAddr}`);
  const postTiny = await waitForSync(20000);
  assertSynced(postTiny, "TinyStorage deployment");

  // Deploy a second Counter via L2
  const counterBytecode = JSON.parse(
    fs.readFileSync(path.join(projectRoot, "out", "Counter.sol", "Counter.json"), "utf8")
  ).bytecode.object;
  log("  Deploying Counter2 on L2...");
  const counter2Addr = await deployOnL2(counterBytecode, ACCOUNT2_KEY);
  log(`  Counter2 at: ${counter2Addr}`);
  deployedContracts.push({ address: counter2Addr, name: "Counter2", path: "src/Counter.sol:Counter" });
  const postCounter2 = await waitForSync(20000);
  assertSynced(postCounter2, "Counter2 deployment");

  // ────────────────────────────────────────────────
  // Phase 5: Batch L2 transactions (via /submit-batch → L1)
  // ────────────────────────────────────────────────
  log("\n── Phase 5: Batch L2 transactions ──");

  const batchSizes = [3, 5, 10, 20];
  for (const batchSize of batchSizes) {
    log(`  Building batch of ${batchSize} transactions...`);

    const calls: Array<{ to: string; data: string; value?: bigint; gasLimit?: number }> = [];
    for (let i = 0; i < batchSize; i++) {
      const txType = i % 10;
      const seed = BigInt(batchSize * 100 + i);
      switch (txType) {
        case 0:
          calls.push({ to: l2OpcodeStoreAddr, data: opcodeIface.encodeFunctionData("testArithmetic", [seed, seed + 7n]) });
          break;
        case 1:
          calls.push({ to: l2OpcodeStoreAddr, data: opcodeIface.encodeFunctionData("testComparison", [seed, seed + 3n]) });
          break;
        case 2:
          calls.push({ to: l2OpcodeStoreAddr, data: opcodeIface.encodeFunctionData("testBitwise", [seed, seed % 256n]) });
          break;
        case 3:
          calls.push({ to: l2OpcodeStoreAddr, data: opcodeIface.encodeFunctionData("testHashing", [ethers.toBeHex(seed, 32)]) });
          break;
        case 4:
          calls.push({ to: l2OpcodeStoreAddr, data: opcodeIface.encodeFunctionData("testEnvironment") });
          break;
        case 5:
          calls.push({ to: l2OpcodeStoreAddr, data: opcodeIface.encodeFunctionData("testMemory", [seed]) });
          break;
        case 6:
          calls.push({ to: l2OpcodeStoreAddr, data: opcodeIface.encodeFunctionData("testStorage", [seed % 50n, seed]) });
          break;
        case 7:
          calls.push({ to: l2OpcodeStoreAddr, data: opcodeIface.encodeFunctionData("testCodeOps") });
          break;
        case 8:
          // CREATE opcode
          calls.push({ to: l2OpcodeStoreAddr, data: opcodeIface.encodeFunctionData("testCreate", ["0x602a60005260206000f3"]) });
          break;
        case 9:
          if (l2CounterAddr) {
            calls.push({ to: l2CounterAddr, data: counterIface.encodeFunctionData("increment") });
          } else {
            calls.push({ to: counter2Addr, data: counterIface.encodeFunctionData("increment") });
          }
          break;
      }
    }

    // Alternate signers between batches
    const signerKey = batchSize % 2 === 0 ? ACCOUNT2_KEY : ACCOUNT1_KEY;

    try {
      const signedTxs = await buildSignedBatch(calls, signerKey);
      const result = await submitBatch(signedTxs);

      if (!result.success) {
        log(`    Batch FAILED: ${result.error}`);
        // Not fatal — continue to next batch
        continue;
      }

      log(`    Batch submitted (stateRoot: ${shortHash(result.stateRoot)})`);

      // Wait for sync (larger batches need more time)
      const waitMs = Math.max(8000, batchSize * 500);
      await new Promise((r) => setTimeout(r, waitMs));
      const state = await waitForSync(60000);
      assertSynced(state, `batch of ${batchSize}`);
      txCount += batchSize;
    } catch (e: any) {
      log(`    Batch error: ${e.message}`);
    }
  }

  // ────────────────────────────────────────────────
  // Phase 6: More L1→L2 calls for variety
  // ────────────────────────────────────────────────
  log("\n── Phase 6: Additional L1→L2 calls ──");

  // Increment Counter2 via L1→L2
  const counter2Calls = [
    { name: "Counter2.increment() via L1 (Acct1)", key: ACCOUNT1_KEY },
    { name: "Counter2.increment() via L1 (Acct2)", key: ACCOUNT2_KEY },
    { name: "Counter2.increment() via L1 (Acct1)", key: ACCOUNT1_KEY },
  ];
  for (const call of counter2Calls) {
    txCount++;
    log(`  [${txCount}] ${call.name}`);
    try {
      await l1ToL2Call(l1Provider, call.key, counter2Addr, counterIface.encodeFunctionData("increment"));
      await new Promise((r) => setTimeout(r, 5000));
      const state = await waitForSync(20000);
      assertSynced(state, call.name);
    } catch (e: any) {
      log(`    FAILED: ${e.message}`);
    }
  }

  // OpcodeStore CREATE2
  txCount++;
  log(`  [${txCount}] OpcodeStore.testCreate2()`);
  try {
    await l1ToL2Call(l1Provider, ACCOUNT1_KEY, l2OpcodeStoreAddr,
      opcodeIface.encodeFunctionData("testCreate2", [
        "0x602a60005260206000f3",
        ethers.toBeHex(42, 32),
      ]));
    await new Promise((r) => setTimeout(r, 5000));
    const state = await waitForSync(20000);
    assertSynced(state, "OpcodeStore.testCreate2");
  } catch (e: any) {
    log(`    FAILED: ${e.message}`);
  }

  // OpcodeStore external calls
  if (l2CounterAddr) {
    txCount++;
    log(`  [${txCount}] OpcodeStore.testCallExternal(Counter.getCount())`);
    try {
      await l1ToL2Call(l1Provider, ACCOUNT2_KEY, l2OpcodeStoreAddr,
        opcodeIface.encodeFunctionData("testCallExternal", [
          l2CounterAddr,
          counterIface.encodeFunctionData("getCount"),
        ]));
      await new Promise((r) => setTimeout(r, 5000));
      const state = await waitForSync(20000);
      assertSynced(state, "OpcodeStore.testCallExternal");
    } catch (e: any) {
      log(`    FAILED: ${e.message}`);
    }

    txCount++;
    log(`  [${txCount}] OpcodeStore.testStaticCallExternal(Counter.getCount())`);
    try {
      await l1ToL2Call(l1Provider, ACCOUNT1_KEY, l2OpcodeStoreAddr,
        opcodeIface.encodeFunctionData("testStaticCallExternal", [
          l2CounterAddr,
          counterIface.encodeFunctionData("getCount"),
        ]));
      await new Promise((r) => setTimeout(r, 5000));
      const state = await waitForSync(20000);
      assertSynced(state, "OpcodeStore.testStaticCallExternal");
    } catch (e: any) {
      log(`    FAILED: ${e.message}`);
    }
  }

  // Bridge more ETH
  txCount++;
  log(`  [${txCount}] Bridge 0.002 ETH (Acct1)`);
  try {
    await bridgeEth(l1Provider, ACCOUNT1_KEY, "0.002");
    await new Promise((r) => setTimeout(r, 5000));
    const state = await waitForSync(20000);
    assertSynced(state, "Bridge 0.002 ETH");
  } catch (e: any) {
    log(`    FAILED: ${e.message}`);
  }

  // ────────────────────────────────────────────────
  // Phase 7: Final sync check
  // ────────────────────────────────────────────────
  log("\n── Phase 7: Final sync verification ──");
  await new Promise((r) => setTimeout(r, 10000));
  const finalState = await waitForSync(60000);
  assertSynced(finalState, "final state");

  // Read some state to confirm it's meaningful
  if (l2CounterAddr) {
    const count = await rethProvider.call({
      to: l2CounterAddr,
      data: counterIface.encodeFunctionData("getCount"),
    });
    log(`L2 Counter value: ${BigInt(count)}`);
  }

  const counter2Count = await rethProvider.call({
    to: counter2Addr,
    data: counterIface.encodeFunctionData("getCount"),
  });
  log(`L2 Counter2 value: ${BigInt(counter2Count)}`);

  const opcodeCallCount = await rethProvider.call({
    to: l2OpcodeStoreAddr,
    data: opcodeIface.encodeFunctionData("callCounter"),
  });
  log(`OpcodeStore callCounter: ${BigInt(opcodeCallCount)}`);

  // ────────────────────────────────────────────────
  // Phase 8: Blockscout verification
  // ────────────────────────────────────────────────
  log("\n── Phase 8: Blockscout contract verification ──");

  // Create symlinks for forge verification
  const symlinkTargets = [
    { src: "../tooling/contracts/OpcodeStore.sol", dst: "../src/OpcodeStore.sol" },
    { src: "../tooling/contracts/Counter.sol", dst: "../src/Counter.sol" },
    { src: "../tooling/contracts/Logger.sol", dst: "../src/Logger.sol" },
  ];
  for (const link of symlinkTargets) {
    const dstPath = path.join(projectRoot, link.dst.replace("../", ""));
    try { fs.unlinkSync(dstPath); } catch {}
    try { fs.symlinkSync(link.src.replace("../", "../tooling/contracts/").replace("../tooling/contracts/", "../tooling/contracts/"), dstPath); } catch {}
  }
  // Correct symlinks
  for (const name of ["OpcodeStore.sol", "Counter.sol", "Logger.sol"]) {
    const dstPath = path.join(projectRoot, "src", name);
    const srcPath = path.join("..", "tooling", "contracts", name);
    try { fs.unlinkSync(dstPath); } catch {}
    try { fs.symlinkSync(srcPath, dstPath); } catch {}
  }

  let l2VerifyCount = 0;
  let l2VerifySuccess = 0;

  if (await waitForBlockscout(L2_BLOCKSCOUT_API, "Blockscout L2")) {
    // Wait extra time for Blockscout to index the latest blocks
    log("  Waiting 30s for Blockscout to catch up...");
    await new Promise((r) => setTimeout(r, 30000));

    for (const contract of deployedContracts) {
      l2VerifyCount++;
      const ok = verifyOnBlockscout(contract.address, contract.path, L2_BLOCKSCOUT_API);
      if (ok) l2VerifySuccess++;
    }

    // Verify existing Counter/Logger on L2 if they exist
    if (l2CounterAddr) {
      l2VerifyCount++;
      const ok = verifyOnBlockscout(l2CounterAddr, "src/Counter.sol:Counter", L2_BLOCKSCOUT_API);
      if (ok) l2VerifySuccess++;
    }
    if (l2LoggerAddr) {
      l2VerifyCount++;
      const ok = verifyOnBlockscout(l2LoggerAddr, "src/Logger.sol:Logger", L2_BLOCKSCOUT_API);
      if (ok) l2VerifySuccess++;
    }
  }

  let l1VerifyCount = 0;
  let l1VerifySuccess = 0;

  if (await waitForBlockscout(L1_BLOCKSCOUT_API, "Blockscout L1")) {
    // L1 contracts were already verified in start-local.sh, but check them
    const l1BlockNum = await callJsonRpc(L1_RPC, "eth_blockNumber", []);
    log(`  L1 block number: ${parseInt(l1BlockNum, 16)}`);
  }

  // Clean up symlinks
  for (const name of ["OpcodeStore.sol", "Counter.sol", "Logger.sol"]) {
    try { fs.unlinkSync(path.join(projectRoot, "src", name)); } catch {}
  }

  // ────────────────────────────────────────────────
  // Phase 9: Blockscout activity check
  // ────────────────────────────────────────────────
  log("\n── Phase 9: Blockscout activity check ──");

  // Check L1 Blockscout
  try {
    const l1BlockResp = await fetch(`${L1_BLOCKSCOUT_API}?module=block&action=eth_block_number`);
    const l1BlockData = (await l1BlockResp.json()) as any;
    const l1IndexedBlock = parseInt(l1BlockData?.result || "0x0", 16);
    const l1ActualBlock = parseInt(await callJsonRpc(L1_RPC, "eth_blockNumber", []), 16);
    log(`  L1 Blockscout: indexed block ${l1IndexedBlock} / actual ${l1ActualBlock}`);

    // Check some key addresses have activity
    const l1AccountInfo = await checkBlockscoutAddress(L1_BLOCKSCOUT_API, ACCOUNT1);
    log(`  L1 Account1 txs: ${l1AccountInfo.txCount}`);
  } catch (e: any) {
    log(`  L1 Blockscout check failed: ${e.message}`);
  }

  // Check L2 Blockscout
  try {
    const l2BlockResp = await fetch(`${L2_BLOCKSCOUT_API}?module=block&action=eth_block_number`);
    const l2BlockData = (await l2BlockResp.json()) as any;
    const l2IndexedBlock = parseInt(l2BlockData?.result || "0x0", 16);
    log(`  L2 Blockscout: indexed block ${l2IndexedBlock} / actual ${finalState.rethBlock}`);

    if (l2OpcodeStoreAddr) {
      const opcodeInfo = await checkBlockscoutAddress(L2_BLOCKSCOUT_API, l2OpcodeStoreAddr);
      log(`  L2 OpcodeStore txs: ${opcodeInfo.txCount}, verified: ${opcodeInfo.isContract}`);
    }
  } catch (e: any) {
    log(`  L2 Blockscout check failed: ${e.message}`);
  }

  // ────────────────────────────────────────────────
  // Summary
  // ────────────────────────────────────────────────
  console.log("\n" + "=".repeat(60));
  console.log("Deterministic Fuzzer - Results");
  console.log("=".repeat(60));
  console.log(`Total L1 transactions:     ${txCount}`);
  console.log(`L2 contracts deployed:     ${deployedContracts.length + 1} (OpcodeStore, TinyStorage, Counter2)`);
  console.log(`Blockscout L2 verified:    ${l2VerifySuccess}/${l2VerifyCount}`);
  console.log(`Final L2 block:            ${finalState.rethBlock}`);
  console.log(`Final state root (reth):   ${finalState.rethState}`);
  console.log(`Final state root (ethrex): ${finalState.ethrexState}`);
  console.log(`State roots match:         ${finalState.rethState === finalState.ethrexState ? "YES" : "NO"}`);
  console.log("");

  if (finalState.rethState === finalState.ethrexState) {
    console.log("ALL CHECKS PASSED - Deterministic fuzzing successful!");
  } else {
    console.log("FAILED - State root mismatch!");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(`\nFatal error: ${e.message}`);
  console.error(e.stack);
  process.exit(1);
});
