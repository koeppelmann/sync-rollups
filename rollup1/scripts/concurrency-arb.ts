#!/usr/bin/env npx tsx
/**
 * Concurrency Scenario: Front-Running an Atomic Arbitrage
 *
 * Demonstrates a concurrency issue where:
 * 1. An L1 transaction swaps on the L1 Uniswap pool (front-run)
 * 2. An L2 arb tx (submitted as executeL2TX on L1) tries to arb the L2 pool
 *    but its pre-computed execution entry becomes invalid because another L2 tx
 *    already changed the L2 state root in the same L1 block.
 *
 * Result: The arb's executeL2TX REVERTS on L1 (state root mismatch).
 *
 * All three transactions land in the same L1 block:
 *   - Tx 1: L1 Uniswap swap (succeeds)
 *   - Tx 2: Spoiler L2 swap postBatch + executeL2TX (succeeds, changes L2 state)
 *   - Tx 3: Arb L2 swap executeL2TX (REVERTS - state root mismatch)
 */

import { ethers, keccak256, AbiCoder, solidityPacked, Wallet, Transaction } from "ethers";

// ============ Configuration ============
const L1_RPC = "http://localhost:8545";
const BUILDER_URL = "http://localhost:3200";
const L2_RPC_PROXY = "http://localhost:9548";
const RETH_EVM = "http://localhost:9546";
const ETHREX_EVM = "http://localhost:9556";
const BUILDER_L2_EVM = "http://localhost:9549";
const BUILDER_FULLNODE_RPC = "http://localhost:9550";
const L2_CHAIN_ID = 10200200;
const ROLLUP_ID = 0n;

const ACCOUNT1 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ACCOUNT1_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ACCOUNT2 = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const ACCOUNT2_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

const BLOCKSCOUT_L1 = "http://217.182.199.45:4000";
const BLOCKSCOUT_L2 = "http://217.182.199.45:4001";

// Read env
const dotenv = (await import("fs")).readFileSync(
  new URL("../.env.local", import.meta.url), "utf8"
);
const ROLLUPS_ADDRESS = dotenv.match(/ROLLUPS_ADDRESS=(.+)/)?.[1]?.trim()!;

// ============ Known Contract Addresses ============
// L1 tokens
const ALPHA_L1  = "0x959922bE3CAee4b8Cd9a407cc3ac1C251C2007B1";
const BETA_L1   = "0x9A9f2CCfdE556A7E9Ff0848998Aa4a0CFD8863AE";
const GAMMA_L1  = "0x68B1D87F95878fE05B998F19b66F4baba5De1aed";

// L2 wrapped tokens
const wALPHA_L2 = "0x948B3c65b89DF0B4894ABE91E6D02FE579834F8F";
const wBETA_L2  = "0x712516e61C8B383dF4A63CFe83d7701Bce54B03e";
const wGAMMA_L2 = "0xbCF26943C0197d2eE0E5D05c716Be60cc2761508";

// Uniswap routers
const L1_ROUTER = "0x82e01223d51Eb87e16A03E24687EDF0F294da6f1";
const L2_ROUTER = "0x90118d110b07abb82ba8980d1c5cc96eea810d2c";

// Arbitrageur on L2
const ARBITRAGEUR_L2 = "0x381445710b5e73d34aF196c53A3D5cDa58EDBf7A";

// ============ ABIs ============
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

const ROUTER_ABI = [
  "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline) returns (uint[] amounts)",
  "function getAmountsOut(uint amountIn, address[] path) view returns (uint[] amounts)",
];

const ARBITRAGEUR_ABI = [
  "function executeSwap(address router, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOutMin) returns (uint256)",
  "function previewSwap(address router, address tokenIn, address tokenOut, uint256 amountIn) view returns (uint256)",
];

const ROLLUPS_ABI = [
  "function rollups(uint256) view returns (address owner, bytes32 verificationKey, bytes32 stateRoot, uint256 etherBalance)",
  "function postBatch((tuple(uint256 rollupId, bytes32 currentState, bytes32 newState, int256 etherDelta)[] stateDeltas, bytes32 actionHash, tuple(uint8 actionType, uint256 rollupId, address destination, uint256 value, bytes data, bool failed, address sourceAddress, uint256 sourceRollup, uint256[] scope) nextAction)[] entries, uint256 blobCount, bytes callData, bytes proof)",
  "function executeL2TX(uint256 rollupId, bytes rlpEncodedTx) returns (bytes)",
];

const PAIR_ABI = [
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
];

// ============ Types matching Rollups.sol ============
const ACTION_TUPLE_TYPE =
  "tuple(uint8 actionType, uint256 rollupId, address destination, uint256 value, bytes data, bool failed, address sourceAddress, uint256 sourceRollup, uint256[] scope)";

const STATE_DELTA_TUPLE_TYPE =
  "tuple(uint256 rollupId, bytes32 currentState, bytes32 newState, int256 etherDelta)";

// ============ Helpers ============
function log(msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

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

async function getStateRoots() {
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

async function waitForSync(maxWaitMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const state = await getStateRoots();
    if (state.rethBlock === state.ethrexBlock && state.rethState === state.ethrexState) return state;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return await getStateRoots();
}

function createL2TXAction(rollupId: bigint, rlpEncodedTx: string) {
  return {
    actionType: 2, // L2TX
    rollupId,
    destination: "0x0000000000000000000000000000000000000000",
    value: 0n,
    data: rlpEncodedTx,
    failed: false,
    sourceAddress: "0x0000000000000000000000000000000000000000",
    sourceRollup: 0n,
    scope: [] as bigint[],
  };
}

function createResultAction(rollupId: bigint, data: string, failed: boolean) {
  return {
    actionType: 1, // RESULT
    rollupId,
    destination: "0x0000000000000000000000000000000000000000",
    value: 0n,
    data,
    failed,
    sourceAddress: "0x0000000000000000000000000000000000000000",
    sourceRollup: 0n,
    scope: [] as bigint[],
  };
}

function computeActionHash(action: any): string {
  const abiCoder = AbiCoder.defaultAbiCoder();
  const encoded = abiCoder.encode([ACTION_TUPLE_TYPE], [[
    action.actionType,
    action.rollupId,
    action.destination,
    action.value,
    action.data,
    action.failed,
    action.sourceAddress,
    action.sourceRollup,
    action.scope,
  ]]);
  return keccak256(encoded);
}

function computeEntryHash(entry: any, verificationKeys: string[]): string {
  const abiCoder = AbiCoder.defaultAbiCoder();
  const stateDeltas = entry.stateDeltas.map((d: any) => [
    d.rollupId, d.currentState, d.newState, d.etherDelta,
  ]);
  const nextAction = [
    entry.nextAction.actionType,
    entry.nextAction.rollupId,
    entry.nextAction.destination,
    entry.nextAction.value,
    entry.nextAction.data,
    entry.nextAction.failed,
    entry.nextAction.sourceAddress,
    entry.nextAction.sourceRollup,
    entry.nextAction.scope,
  ];
  const encoded = solidityPacked(
    ["bytes", "bytes", "bytes32", "bytes"],
    [
      abiCoder.encode([`${STATE_DELTA_TUPLE_TYPE}[]`], [stateDeltas]),
      abiCoder.encode(["bytes32[]"], [verificationKeys]),
      entry.actionHash,
      abiCoder.encode([ACTION_TUPLE_TYPE], [nextAction]),
    ]
  );
  return keccak256(encoded);
}

async function signProof(entries: any[], adminKey: string, rollupsAddr: string): Promise<string> {
  const l1Provider = new ethers.JsonRpcProvider(L1_RPC);
  const adminWallet = new Wallet(adminKey, l1Provider);
  const rollupsContract = new ethers.Contract(rollupsAddr, ROLLUPS_ABI, l1Provider);
  const abiCoder = AbiCoder.defaultAbiCoder();

  const entryHashes: string[] = [];
  for (const entry of entries) {
    const verificationKeys: string[] = [];
    for (const delta of entry.stateDeltas) {
      const rollupData = await rollupsContract.rollups(delta.rollupId);
      verificationKeys.push(rollupData.verificationKey);
    }
    entryHashes.push(computeEntryHash(entry, verificationKeys));
  }

  const dataHash = keccak256(abiCoder.encode(["bytes32[]"], [entryHashes]));
  return await adminWallet.signMessage(ethers.getBytes(dataHash));
}

// ============ Main Script ============
async function main() {
  const l1Provider = new ethers.JsonRpcProvider(L1_RPC);
  const adminWallet = new Wallet(ACCOUNT1_KEY, l1Provider);
  const rollupsContract = new ethers.Contract(ROLLUPS_ADDRESS, ROLLUPS_ABI, adminWallet);
  const builderL2Provider = new ethers.JsonRpcProvider(BUILDER_L2_EVM);

  log("=== Concurrency Scenario: Front-Running an Atomic Arb ===\n");

  // ────────────────────────────────────────────────
  // Step 1: Check current state
  // ────────────────────────────────────────────────
  const rollupData = await rollupsContract.rollups(ROLLUP_ID);
  const currentStateRoot = rollupData.stateRoot;
  log(`Current L2 state root on L1: ${currentStateRoot.slice(0, 18)}...`);

  // Check L2 pool reserves
  const l2Provider = new ethers.JsonRpcProvider(RETH_EVM);
  const routerL2 = new ethers.Contract(L2_ROUTER, ROUTER_ABI, l2Provider);

  // Preview current L2 swap rates
  const amtIn = ethers.parseEther("1000");
  const previewBefore = await routerL2.getAmountsOut(amtIn, [wALPHA_L2, wGAMMA_L2]);
  log(`Current L2 rate: 1000 wALPHA → ${ethers.formatEther(previewBefore[1])} wGAMMA`);

  const reversePreview = await routerL2.getAmountsOut(amtIn, [wGAMMA_L2, wALPHA_L2]);
  log(`Current L2 rate: 1000 wGAMMA → ${ethers.formatEther(reversePreview[1])} wALPHA`);

  // ────────────────────────────────────────────────
  // Step 2: Build the spoiler L2 swap (Account #1 swaps wALPHA → wGAMMA)
  // ────────────────────────────────────────────────
  log("\n── Building L2 transactions ──");

  // First, ensure Account #1 has approved the L2 Router for wALPHA
  const wAlphaL2 = new ethers.Contract(wALPHA_L2, ERC20_ABI, l2Provider);
  const currentAllowance = await wAlphaL2.allowance(ACCOUNT1, L2_ROUTER);
  if (currentAllowance < ethers.parseEther("10000")) {
    log("  Approving L2 Router for wALPHA (Account #1)...");
    const approveData = wAlphaL2.interface.encodeFunctionData("approve", [
      L2_ROUTER, ethers.MaxUint256,
    ]);
    const proxyProvider = new ethers.JsonRpcProvider(L2_RPC_PROXY);
    const wallet1 = new Wallet(ACCOUNT1_KEY, proxyProvider);
    const nonce = await proxyProvider.getTransactionCount(ACCOUNT1, "pending");
    await wallet1.sendTransaction({ to: wALPHA_L2, data: approveData, gasLimit: 100_000, nonce });
    log("  Waiting for approval to process...");
    await new Promise(r => setTimeout(r, 8000));
    await waitForSync(20000);
  }

  // Also ensure Account #2 has approved L2 Router for wGAMMA (for the arb)
  const wGammaL2 = new ethers.Contract(wGAMMA_L2, ERC20_ABI, l2Provider);
  const arbAllowance = await wGammaL2.allowance(ACCOUNT2, L2_ROUTER);
  if (arbAllowance < ethers.parseEther("10000")) {
    log("  Approving L2 Router for wGAMMA (Account #2)...");
    const approveData = wGammaL2.interface.encodeFunctionData("approve", [
      L2_ROUTER, ethers.MaxUint256,
    ]);
    const proxyProvider = new ethers.JsonRpcProvider(L2_RPC_PROXY);
    const wallet2 = new Wallet(ACCOUNT2_KEY, proxyProvider);
    const nonce = await proxyProvider.getTransactionCount(ACCOUNT2, "pending");
    await wallet2.sendTransaction({ to: wGAMMA_L2, data: approveData, gasLimit: 100_000, nonce });
    log("  Waiting for approval to process...");
    await new Promise(r => setTimeout(r, 8000));
    await waitForSync(20000);
  }

  // Re-read state after approvals
  const rollupData2 = await rollupsContract.rollups(ROLLUP_ID);
  const stateAfterApprovals = rollupData2.stateRoot;
  log(`State root after approvals: ${stateAfterApprovals.slice(0, 18)}...`);

  // Build spoiler L2 swap: Account #1 swaps 2000 wALPHA → wGAMMA
  const spoilerAmount = ethers.parseEther("2000");
  const deadline = Math.floor(Date.now() / 1000) + 36000;
  const routerIface = new ethers.Interface(ROUTER_ABI);
  const spoilerCalldata = routerIface.encodeFunctionData("swapExactTokensForTokens", [
    spoilerAmount, 0, [wALPHA_L2, wGAMMA_L2], ACCOUNT1, deadline,
  ]);

  // Sign spoiler L2 tx (use builder L2 nonces since simulation runs there)
  const spoilerL2Provider = new ethers.JsonRpcProvider(BUILDER_L2_EVM);
  const spoilerWallet = new Wallet(ACCOUNT1_KEY, spoilerL2Provider);
  const spoilerNonce = await spoilerL2Provider.getTransactionCount(ACCOUNT1, "latest");
  const spoilerTx = await spoilerWallet.populateTransaction({
    to: L2_ROUTER, data: spoilerCalldata, gasLimit: 300_000, nonce: spoilerNonce,
  });
  const signedSpoilerTx = await spoilerWallet.signTransaction(spoilerTx);
  log(`  Spoiler tx signed: swap 2000 wALPHA → wGAMMA (Account #1, nonce ${spoilerNonce})`);

  // Build arb L2 swap: Account #2 tries to swap wGAMMA → wALPHA with high amountOutMin
  // The arb bot calculated the expected output BEFORE the spoiler
  const arbAmount = ethers.parseEther("1000");
  const expectedArbOutput = await routerL2.getAmountsOut(arbAmount, [wGAMMA_L2, wALPHA_L2]);
  const arbAmountOutMin = expectedArbOutput[1]; // exact amount expected at current price
  log(`  Arb bot expects: 1000 wGAMMA → ${ethers.formatEther(arbAmountOutMin)} wALPHA`);

  const arbCalldata = routerIface.encodeFunctionData("swapExactTokensForTokens", [
    arbAmount, arbAmountOutMin, [wGAMMA_L2, wALPHA_L2], ACCOUNT2, deadline,
  ]);

  // Sign arb L2 tx
  const arbWallet = new Wallet(ACCOUNT2_KEY, spoilerL2Provider);
  const arbNonce = await spoilerL2Provider.getTransactionCount(ACCOUNT2, "latest");
  const arbTx = await arbWallet.populateTransaction({
    to: L2_ROUTER, data: arbCalldata, gasLimit: 300_000, nonce: arbNonce,
  });
  const signedArbTx = await arbWallet.signTransaction(arbTx);
  log(`  Arb tx signed: swap 1000 wGAMMA → wALPHA with amountOutMin=${ethers.formatEther(arbAmountOutMin)} (Account #2, nonce ${arbNonce})`);

  // ────────────────────────────────────────────────
  // Step 3: Simulate both L2 txs on builder's L2 fullnode
  // ────────────────────────────────────────────────
  log("\n── Simulating L2 transactions ──");

  // Take snapshot so we can simulate both independently
  const snapshot = await callJsonRpc(BUILDER_FULLNODE_RPC, "syncrollups_takeSnapshot", []);
  log(`  Snapshot taken at block: ${snapshot}`);

  // Simulate spoiler tx
  const spoilerSim = await callJsonRpc(BUILDER_FULLNODE_RPC, "syncrollups_simulateBatch", [[signedSpoilerTx]]);
  if (!spoilerSim.success) throw new Error(`Spoiler simulation failed: ${spoilerSim.error}`);
  const stateAfterSpoiler = spoilerSim.newState;
  log(`  Spoiler simulated: state ${spoilerSim.currentState.slice(0, 18)}... → ${stateAfterSpoiler.slice(0, 18)}...`);

  // Revert to snapshot to simulate arb independently (against OLD state)
  await callJsonRpc(BUILDER_FULLNODE_RPC, "syncrollups_revertToSnapshot", [snapshot]);
  log(`  Reverted to snapshot`);

  // Simulate arb tx (against the SAME old state - this is what the arb bot assumes)
  const arbSim = await callJsonRpc(BUILDER_FULLNODE_RPC, "syncrollups_simulateBatch", [[signedArbTx]]);
  if (!arbSim.success) throw new Error(`Arb simulation failed: ${arbSim.error}`);
  const stateAfterArb = arbSim.newState;
  log(`  Arb simulated: state ${arbSim.currentState.slice(0, 18)}... → ${stateAfterArb.slice(0, 18)}...`);

  // Revert again (we'll let the real execution happen on L1)
  await callJsonRpc(BUILDER_FULLNODE_RPC, "syncrollups_revertToSnapshot", [snapshot]);

  // Now simulate BOTH together (spoiler first) to get the builder's state correct
  // This is what will actually happen on L2
  const bothSim = await callJsonRpc(BUILDER_FULLNODE_RPC, "syncrollups_simulateBatch", [
    [signedSpoilerTx, signedArbTx],
  ]);
  log(`  Both simulated together: state → ${bothSim.newState.slice(0, 18)}... (arb likely reverted on L2)`);

  // ────────────────────────────────────────────────
  // Step 4: Build execution entries
  // ────────────────────────────────────────────────
  log("\n── Building execution entries ──");

  const currentState = stateAfterApprovals;

  // Spoiler entry: uses correct state transition
  const spoilerAction = createL2TXAction(ROLLUP_ID, signedSpoilerTx);
  const spoilerActionHash = computeActionHash(spoilerAction);
  const spoilerResultAction = createResultAction(ROLLUP_ID, "0x", false);
  const spoilerEntry = {
    stateDeltas: [{
      rollupId: ROLLUP_ID,
      currentState,
      newState: stateAfterSpoiler,
      etherDelta: 0n,
    }],
    actionHash: spoilerActionHash,
    nextAction: spoilerResultAction,
  };
  log(`  Spoiler entry: currentState=${currentState.slice(0, 18)}... → newState=${stateAfterSpoiler.slice(0, 18)}...`);

  // Arb entry: ALSO uses old currentState (S1) - this is the stale computation!
  // The arb bot computed this against S1, but after the spoiler executes, state will be S2.
  const arbAction = createL2TXAction(ROLLUP_ID, signedArbTx);
  const arbActionHash = computeActionHash(arbAction);
  const arbResultAction = createResultAction(ROLLUP_ID, "0x", false);
  const arbEntry = {
    stateDeltas: [{
      rollupId: ROLLUP_ID,
      currentState,       // S1 - STALE! After spoiler it will be S2
      newState: stateAfterArb,
      etherDelta: 0n,
    }],
    actionHash: arbActionHash,
    nextAction: arbResultAction,
  };
  log(`  Arb entry:     currentState=${currentState.slice(0, 18)}... → newState=${stateAfterArb.slice(0, 18)}...`);
  log(`  (Both entries claim currentState=${currentState.slice(0, 18)}... — the arb's is STALE!)`);

  // ────────────────────────────────────────────────
  // Step 5: Sign proofs for both postBatch calls
  // ────────────────────────────────────────────────
  log("\n── Signing proofs ──");
  const spoilerProof = await signProof([spoilerEntry], ACCOUNT1_KEY, ROLLUPS_ADDRESS);
  const arbProof = await signProof([arbEntry], ACCOUNT1_KEY, ROLLUPS_ADDRESS);
  log(`  Proofs signed`);

  // Notify builder fullnode about the executions
  // Convert entries to JSON format for RPC
  function entryToJson(entry: any) {
    return {
      stateDeltas: entry.stateDeltas.map((d: any) => ({
        rollupId: "0x" + d.rollupId.toString(16),
        currentState: d.currentState,
        newState: d.newState,
        etherDelta: "0x0",
      })),
      actionHash: entry.actionHash,
      nextAction: {
        actionType: entry.nextAction.actionType,
        rollupId: "0x" + entry.nextAction.rollupId.toString(16),
        destination: entry.nextAction.destination,
        value: "0x0",
        data: entry.nextAction.data,
        failed: entry.nextAction.failed,
        sourceAddress: entry.nextAction.sourceAddress,
        sourceRollup: "0x0",
        scope: [],
      },
    };
  }
  await callJsonRpc(BUILDER_FULLNODE_RPC, "syncrollups_loadExecutions", [
    [entryToJson(spoilerEntry), entryToJson(arbEntry)],
  ]);
  log(`  Executions loaded on builder fullnode`);

  // ────────────────────────────────────────────────
  // Step 6: Build L1 Uniswap swap
  // ────────────────────────────────────────────────
  log("\n── Building L1 Uniswap swap ──");

  // Check L1 ALPHA balance
  const alphaL1 = new ethers.Contract(ALPHA_L1, ERC20_ABI, l1Provider);
  const alphaBalance = await alphaL1.balanceOf(ACCOUNT1);
  log(`  Account #1 ALPHA balance on L1: ${ethers.formatEther(alphaBalance)}`);

  // Ensure approval for L1 Router
  const l1RouterAllowance = await alphaL1.allowance(ACCOUNT1, L1_ROUTER);
  if (l1RouterAllowance < ethers.parseEther("1000")) {
    log("  Approving L1 Router for ALPHA...");
    const approveTx = await alphaL1.connect(adminWallet).approve(L1_ROUTER, ethers.MaxUint256);
    await approveTx.wait();
  }

  // Build L1 swap: 1000 ALPHA → GAMMA on L1 Uniswap
  const l1SwapAmount = ethers.parseEther("1000");
  const l1SwapCalldata = routerIface.encodeFunctionData("swapExactTokensForTokens", [
    l1SwapAmount, 0, [ALPHA_L1, GAMMA_L1], ACCOUNT1, deadline,
  ]);
  log(`  L1 swap: 1000 ALPHA → GAMMA`);

  // We'll use Account #2 for the L1 swap so it doesn't conflict with admin nonces
  const account2Wallet = new Wallet(ACCOUNT2_KEY, l1Provider);

  // Ensure Account #2 has ALPHA and approval (do this BEFORE disabling automine)
  const alpha2Balance = await alphaL1.balanceOf(ACCOUNT2);
  if (alpha2Balance < l1SwapAmount) {
    log(`  Transferring ALPHA to Account #2 for L1 swap...`);
    const transferTx = await alphaL1.connect(adminWallet).transfer(ACCOUNT2, l1SwapAmount);
    await transferTx.wait();
  }
  const alpha2Allowance = await alphaL1.allowance(ACCOUNT2, L1_ROUTER);
  if (alpha2Allowance < l1SwapAmount) {
    log(`  Approving L1 Router for Account #2...`);
    const approveTx = await alphaL1.connect(account2Wallet).approve(L1_ROUTER, ethers.MaxUint256);
    await approveTx.wait();
  }

  // ────────────────────────────────────────────────
  // Step 7: Execute everything in ONE L1 block
  // ────────────────────────────────────────────────
  log("\n── Executing in one L1 block ──");

  // Disable Anvil automining
  await l1Provider.send("evm_setAutomine", [false]);
  log("  Automining disabled");

  const adminNonce = await l1Provider.getTransactionCount(adminWallet.address);
  log(`  Admin nonce: ${adminNonce}`);
  const account2Nonce = await l1Provider.getTransactionCount(account2Wallet.address);
  log(`  Account #2 nonce: ${account2Nonce}`);

  // Tx 1: L1 Uniswap swap (from Account #2)
  const l1SwapTx = await account2Wallet.sendTransaction({
    to: L1_ROUTER,
    data: l1SwapCalldata,
    gasLimit: 300_000,
    nonce: account2Nonce,
  });
  log(`  Tx 1 sent: L1 Uniswap swap (ALPHA → GAMMA) hash=${l1SwapTx.hash}`);

  // Tx 2: Spoiler postBatch (from admin)
  const postBatchCalldata = (entry: any, proof: string) => {
    return rollupsContract.interface.encodeFunctionData("postBatch", [
      [{
        stateDeltas: entry.stateDeltas.map((d: any) => ({
          rollupId: d.rollupId,
          currentState: d.currentState,
          newState: d.newState,
          etherDelta: d.etherDelta,
        })),
        actionHash: entry.actionHash,
        nextAction: {
          actionType: entry.nextAction.actionType,
          rollupId: entry.nextAction.rollupId,
          destination: entry.nextAction.destination,
          value: entry.nextAction.value,
          data: entry.nextAction.data,
          failed: entry.nextAction.failed,
          sourceAddress: entry.nextAction.sourceAddress,
          sourceRollup: entry.nextAction.sourceRollup,
          scope: entry.nextAction.scope,
        },
      }],
      0, // blobCount
      "0x", // callData
      proof,
    ]);
  };

  const spoilerPostBatchTx = await adminWallet.sendTransaction({
    to: ROLLUPS_ADDRESS,
    data: postBatchCalldata(spoilerEntry, spoilerProof),
    gasLimit: 2_000_000,
    nonce: adminNonce,
  });
  log(`  Tx 2 sent: Spoiler postBatch hash=${spoilerPostBatchTx.hash}`);

  // Tx 3: Spoiler executeL2TX (from admin)
  const spoilerExecCalldata = rollupsContract.interface.encodeFunctionData("executeL2TX", [
    ROLLUP_ID, signedSpoilerTx,
  ]);
  const spoilerExecTx = await adminWallet.sendTransaction({
    to: ROLLUPS_ADDRESS,
    data: spoilerExecCalldata,
    gasLimit: 1_000_000,
    nonce: adminNonce + 1,
  });
  log(`  Tx 3 sent: Spoiler executeL2TX hash=${spoilerExecTx.hash}`);

  // Tx 4: Arb postBatch (from admin) — this stores the STALE entry
  const arbPostBatchTx = await adminWallet.sendTransaction({
    to: ROLLUPS_ADDRESS,
    data: postBatchCalldata(arbEntry, arbProof),
    gasLimit: 2_000_000,
    nonce: adminNonce + 2,
  });
  log(`  Tx 4 sent: Arb postBatch (stale state!) hash=${arbPostBatchTx.hash}`);

  // Tx 5: Arb executeL2TX (from admin) — THIS SHOULD REVERT!
  const arbExecCalldata = rollupsContract.interface.encodeFunctionData("executeL2TX", [
    ROLLUP_ID, signedArbTx,
  ]);
  const arbExecTx = await adminWallet.sendTransaction({
    to: ROLLUPS_ADDRESS,
    data: arbExecCalldata,
    gasLimit: 1_000_000,
    nonce: adminNonce + 3,
  });
  log(`  Tx 5 sent: Arb executeL2TX (should REVERT!) hash=${arbExecTx.hash}`);

  // Mine the block!
  await l1Provider.send("evm_mine", []);
  log("  Block mined!");

  // Re-enable automining
  await l1Provider.send("evm_setAutomine", [true]);
  log("  Automining re-enabled");

  // ────────────────────────────────────────────────
  // Step 8: Check results
  // ────────────────────────────────────────────────
  log("\n── Results ──");

  // Get receipts
  const [l1SwapReceipt, spoilerPBReceipt, spoilerExecReceipt, arbPBReceipt, arbExecReceipt] =
    await Promise.all([
      l1Provider.getTransactionReceipt(l1SwapTx.hash),
      l1Provider.getTransactionReceipt(spoilerPostBatchTx.hash),
      l1Provider.getTransactionReceipt(spoilerExecTx.hash),
      l1Provider.getTransactionReceipt(arbPostBatchTx.hash),
      l1Provider.getTransactionReceipt(arbExecTx.hash),
    ]);

  const blockNumber = l1SwapReceipt?.blockNumber;
  log(`  All txs in L1 block: ${blockNumber}`);
  log(`  Tx 1 (L1 swap):          status=${l1SwapReceipt?.status === 1 ? "SUCCESS" : "REVERTED"}`);
  log(`  Tx 2 (spoiler postBatch): status=${spoilerPBReceipt?.status === 1 ? "SUCCESS" : "REVERTED"}`);
  log(`  Tx 3 (spoiler execL2TX):  status=${spoilerExecReceipt?.status === 1 ? "SUCCESS" : "REVERTED"}`);
  log(`  Tx 4 (arb postBatch):     status=${arbPBReceipt?.status === 1 ? "SUCCESS" : "REVERTED"}`);
  log(`  Tx 5 (arb executeL2TX):   status=${arbExecReceipt?.status === 1 ? "SUCCESS" : "REVERTED"}`);

  // Wait for L2 sync
  log("\n  Waiting for L2 nodes to sync...");
  await new Promise(r => setTimeout(r, 10000));
  const finalState = await waitForSync(30000);
  log(`  L2 reth:   block=${finalState.rethBlock} state=${finalState.rethState.slice(0, 18)}...`);
  log(`  L2 ethrex: block=${finalState.ethrexBlock} state=${finalState.ethrexState.slice(0, 18)}...`);
  if (finalState.rethState === finalState.ethrexState) {
    log(`  L2 nodes are IN SYNC`);
  } else {
    log(`  WARNING: L2 nodes are OUT OF SYNC!`);
  }

  // ────────────────────────────────────────────────
  // Step 9: Report Blockscout links
  // ────────────────────────────────────────────────
  log("\n══════════════════════════════════════════════");
  log("  BLOCKSCOUT LINKS");
  log("══════════════════════════════════════════════");
  log(`\n  L1 Block (all txs in same block):`);
  log(`  ${BLOCKSCOUT_L1}/block/${blockNumber}`);
  log(`\n  L1 Uniswap Swap (ALPHA → GAMMA):`);
  log(`  ${BLOCKSCOUT_L1}/tx/${l1SwapTx.hash}`);
  log(`\n  L1 Arb executeL2TX (${arbExecReceipt?.status === 1 ? "succeeded" : "REVERTED"}):`);
  log(`  ${BLOCKSCOUT_L1}/tx/${arbExecTx.hash}`);
  log(`\n  Spoiler executeL2TX:`);
  log(`  ${BLOCKSCOUT_L1}/tx/${spoilerExecTx.hash}`);
  log("══════════════════════════════════════════════\n");
}

main().catch((err) => {
  console.error("Script failed:", err);
  // Re-enable automining in case of error
  const l1Provider = new ethers.JsonRpcProvider(L1_RPC);
  l1Provider.send("evm_setAutomine", [true]).catch(() => {});
  process.exit(1);
});
