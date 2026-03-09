#!/usr/bin/env npx tsx
/**
 * Gnosis Cross-Chain Arbitrage Demo
 *
 * Deploys tokens, bridge, Uniswap V2 on both L1 (Gnosis) and L2,
 * with different pool prices to enable atomic cross-chain arbitrage.
 *
 * Uses real xDAI for gas. Acquires tokens by deploying SimpleTokens
 * and trading through our own Uniswap V2 pools on L1.
 */

import { ethers } from "ethers";
import fs from "fs";
import path from "path";

// ============ Configuration (Gnosis) ============
const ENV = (() => {
  const e: Record<string, string> = {};
  const raw = fs.readFileSync(".env.gnosis", "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) e[m[1]] = m[2];
  }
  return e;
})();

const L1_RPC = ENV.L1_RPC;
const BUILDER_URL = "http://localhost:3210";
const L2_RPC_PROXY = "http://localhost:9648";
const L2_EVM = "http://localhost:9646";  // public reth
const ETHREX_EVM = "http://localhost:9656";

const USER1 = ENV.USER1_ADDRESS;
const USER1_KEY = ENV.USER1_KEY;
const USER2 = ENV.USER2_ADDRESS;
const USER2_KEY = ENV.USER2_KEY;

const MAX_UINT256 = "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

// Use small amounts to conserve xDAI for gas
const TOKEN_SUPPLY = ethers.parseEther("10000");
const POOL_AMOUNT = ethers.parseEther("1000");
const BRIDGE_AMOUNT = ethers.parseEther("3000");
const ARB_AMOUNT = ethers.parseEther("100");

// ============ ABIs ============
const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transferFrom(address from, address to, uint256 amount) returns (bool)",
];

const BRIDGE_ABI = [
  "function registerToken(address originalToken, address wrappedToken)",
  "function deposit(address token, address to, uint256 amount)",
  "function mintTo(address wrappedToken, address to, uint256 amount)",
  "function lockedBalance(address) view returns (uint256)",
];

const WETH_ABI = [
  "function deposit() payable",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
];

const FACTORY_ABI = [
  "function createPair(address tokenA, address tokenB) returns (address pair)",
  "function getPair(address tokenA, address tokenB) view returns (address)",
];

const ROUTER_ABI = [
  "function factory() view returns (address)",
  "function WETH() view returns (address)",
  "function addLiquidity(address tokenA, address tokenB, uint amountADesired, uint amountBDesired, uint amountAMin, uint amountBMin, address to, uint deadline) returns (uint amountA, uint amountB, uint liquidity)",
  "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline) returns (uint[] amounts)",
  "function getAmountsOut(uint amountIn, address[] path) view returns (uint[] amounts)",
];

const ARBITRAGEUR_ABI = [
  "function executeSwap(address router, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOutMin) returns (uint256)",
  "function previewSwap(address router, address tokenIn, address tokenOut, uint256 amountIn) view returns (uint256)",
  "function totalProfit() view returns (uint256)",
  "function tradeCount() view returns (uint256)",
];

// ============ Helpers ============

function log(msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function shortAddr(a: string) { return a.slice(0, 6) + "..." + a.slice(-4); }

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

async function waitForSync(label: string, maxWaitMs = 120000) {
  log(`  Waiting for sync: ${label}...`);
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      // Check builder is synced (most important — controls tx acceptance)
      const status = await fetch(`${BUILDER_URL}/status`).then(r => r.json()) as any;
      if (!status.isSynced) {
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }
      // Also check public fullnode
      const pubSync = await callJsonRpc("http://localhost:9647", "syncrollups_isSynced");
      if (pubSync === true || pubSync === "true") {
        log(`  Synced: ${label}`);
        return;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 3000));
  }
  log(`  WARNING: sync timeout after ${label}`);
}

/** Deploy on L1 (Gnosis). Returns contract instance. */
async function deployOnL1(
  privateKey: string,
  abi: any[],
  bytecode: string,
  args: any[] = [],
): Promise<ethers.Contract> {
  const provider = new ethers.JsonRpcProvider(L1_RPC);
  const wallet = new ethers.Wallet(privateKey, provider);
  const factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  const addr = await contract.getAddress();
  return new ethers.Contract(addr, abi, wallet);
}

/** Deploy on L2 via proxy → builder → executeL2TX on L1 */
async function deployOnL2(
  bytecodeWithArgs: string,
  signerKey: string,
  gasLimit = 5_000_000,
): Promise<string> {
  const provider = new ethers.JsonRpcProvider(L2_RPC_PROXY);
  const wallet = new ethers.Wallet(signerKey, provider);
  const nonce = await provider.getTransactionCount(wallet.address, "pending");
  const feeData = await provider.getFeeData();
  const tx = await wallet.sendTransaction({
    data: bytecodeWithArgs,
    gasLimit,
    nonce,
    maxFeePerGas: feeData.maxFeePerGas || undefined,
    maxPriorityFeePerGas: 0n,
  });
  log(`    L2 deploy tx: ${tx.hash}`);
  // Wait for builder to process (L2proxy → builder → L1 postBatch+executeL2TX → fullnode replay)
  // On Gnosis, each L1 tx takes ~5-10s to confirm
  await new Promise(r => setTimeout(r, 15000));
  await waitForSync("L2 deploy", 120000);
  const rethProvider = new ethers.JsonRpcProvider(L2_EVM);
  const receipt = await rethProvider.getTransactionReceipt(tx.hash);
  if (!receipt || !receipt.contractAddress) {
    throw new Error(`L2 deploy failed: ${tx.hash}`);
  }
  return receipt.contractAddress;
}

/** Execute L1→L2 cross-chain call via builder */
async function l1ToL2Call(
  privateKey: string,
  l2Target: string,
  calldata: string,
  value: string = "0",
  ethValue?: bigint,
): Promise<void> {
  const provider = new ethers.JsonRpcProvider(L1_RPC);
  const wallet = new ethers.Wallet(privateKey, provider);
  const prep = await fetch(`${BUILDER_URL}/prepare-l1-call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      l2Target,
      value,
      data: calldata,
      sourceAddress: wallet.address,
    }),
  }).then(r => r.json()) as any;
  if (!prep.success) throw new Error(`L1→L2 prepare failed: ${prep.error}`);
  log(`    L1→L2 via proxy ${shortAddr(prep.proxyAddress)}`);
  const tx = await wallet.sendTransaction({
    to: prep.proxyAddress,
    data: calldata,
    value: ethValue || 0n,
  });
  await tx.wait();
}

/** L1 contract call */
async function l1Call(
  privateKey: string,
  contractAddr: string,
  abi: any[],
  method: string,
  args: any[],
  options?: { value?: bigint },
): Promise<ethers.TransactionReceipt> {
  const provider = new ethers.JsonRpcProvider(L1_RPC);
  const wallet = new ethers.Wallet(privateKey, provider);
  const contract = new ethers.Contract(contractAddr, abi, wallet);
  const tx = await (contract as any)[method](...args, options || {});
  return await tx.wait();
}

/** L2 transaction via proxy */
async function l2TxViaProxy(
  privateKey: string,
  to: string,
  data: string,
  value: bigint = 0n,
  gasLimit: number = 500_000,
): Promise<string> {
  const provider = new ethers.JsonRpcProvider(L2_RPC_PROXY);
  const wallet = new ethers.Wallet(privateKey, provider);
  const nonce = await provider.getTransactionCount(wallet.address, "pending");
  const feeData = await provider.getFeeData();
  const tx = await wallet.sendTransaction({
    to, data, value, gasLimit, nonce,
    maxFeePerGas: feeData.maxFeePerGas || undefined,
    maxPriorityFeePerGas: 0n,
  });
  return tx.hash;
}

// ============ Main ============

async function main() {
  console.log("\n=== Gnosis Cross-Chain Arbitrage Demo ===\n");
  log(`L1 RPC: ${L1_RPC}`);
  log(`User #1: ${USER1}`);
  log(`User #2: ${USER2}`);

  // Check L1 balance
  const l1Provider = new ethers.JsonRpcProvider(L1_RPC);
  const bal = await l1Provider.getBalance(USER1);
  log(`User #1 L1 balance: ${ethers.formatEther(bal)} xDAI`);
  if (bal < ethers.parseEther("0.5")) {
    throw new Error("Not enough xDAI for deployment (need >= 0.5)");
  }

  const rethProvider = new ethers.JsonRpcProvider(L2_EVM);

  // Load artifacts
  const projectRoot = path.resolve(process.cwd(), "..");
  const loadArtifact = (name: string, subdir: string) =>
    JSON.parse(fs.readFileSync(path.join(projectRoot, "out", subdir, name + ".json"), "utf8"));

  const simpleTokenArt = loadArtifact("SimpleToken", "SimpleToken.sol");
  const bridgeArt = loadArtifact("TokenBridge", "TokenBridge.sol");
  const weth9Art = loadArtifact("WETH9", "WETH9.sol");
  const arbitrageurArt = loadArtifact("Arbitrageur", "Arbitrageur.sol");

  const uniFactoryArt = JSON.parse(fs.readFileSync("node_modules/@uniswap/v2-core/build/UniswapV2Factory.json", "utf8"));
  if (!uniFactoryArt.bytecode.startsWith("0x")) uniFactoryArt.bytecode = "0x" + uniFactoryArt.bytecode;
  const uniRouterArt = JSON.parse(fs.readFileSync("node_modules/@uniswap/v2-periphery/build/UniswapV2Router02.json", "utf8"));
  if (!uniRouterArt.bytecode.startsWith("0x")) uniRouterArt.bytecode = "0x" + uniRouterArt.bytecode;

  const erc20Iface = new ethers.Interface(ERC20_ABI);
  const bridgeIface = new ethers.Interface(BRIDGE_ABI);
  const routerIface = new ethers.Interface(ROUTER_ABI);
  const arbIface = new ethers.Interface(ARBITRAGEUR_ABI);

  const encodeTokenArgs = (name: string, symbol: string, supply: bigint) => {
    const encodedArgs = ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "string", "uint256"], [name, symbol, supply]);
    return simpleTokenArt.bytecode.object + encodedArgs.slice(2);
  };

  // ── Phase 1: Deploy tokens on L1 ──
  log("\n── Phase 1: Deploy ALPHA & BETA tokens on L1 (Gnosis) ──");

  const alphaL1 = await deployOnL1(USER1_KEY, simpleTokenArt.abi, simpleTokenArt.bytecode.object, ["Alpha Token", "ALPHA", TOKEN_SUPPLY]);
  const alphaL1Addr = await alphaL1.getAddress();
  log(`  ALPHA (L1): ${alphaL1Addr}`);

  const betaL1 = await deployOnL1(USER1_KEY, simpleTokenArt.abi, simpleTokenArt.bytecode.object, ["Beta Token", "BETA", TOKEN_SUPPLY]);
  const betaL1Addr = await betaL1.getAddress();
  log(`  BETA  (L1): ${betaL1Addr}`);

  // ── Phase 2: Deploy WETH9 + Uniswap V2 on L1 ──
  log("\n── Phase 2: Deploy Uniswap V2 on L1 ──");

  const wethL1 = await deployOnL1(USER1_KEY, weth9Art.abi, weth9Art.bytecode.object);
  const wethL1Addr = await wethL1.getAddress();
  log(`  WETH9 (L1): ${wethL1Addr}`);

  const factoryL1 = await deployOnL1(USER1_KEY, uniFactoryArt.abi, uniFactoryArt.bytecode, [USER1]);
  const factoryL1Addr = await factoryL1.getAddress();
  log(`  Factory (L1): ${factoryL1Addr}`);

  const routerL1 = await deployOnL1(USER1_KEY, uniRouterArt.abi, uniRouterArt.bytecode, [factoryL1Addr, wethL1Addr]);
  const routerL1Addr = await routerL1.getAddress();
  log(`  Router  (L1): ${routerL1Addr}`);

  // ── Phase 3: Create L1 pool ──
  log("\n── Phase 3: Create ALPHA/BETA pool on L1 (ratio 1:2) ──");

  const deadline = Math.floor(Date.now() / 1000) + 36000;

  await l1Call(USER1_KEY, alphaL1Addr, ERC20_ABI, "approve", [routerL1Addr, MAX_UINT256]);
  await l1Call(USER1_KEY, betaL1Addr, ERC20_ABI, "approve", [routerL1Addr, MAX_UINT256]);
  log(`  Tokens approved for L1 router`);

  // Pool: 1000 ALPHA + 2000 BETA → 1 ALPHA = 2 BETA on L1
  await l1Call(USER1_KEY, routerL1Addr, ROUTER_ABI, "addLiquidity", [
    alphaL1Addr, betaL1Addr,
    POOL_AMOUNT, POOL_AMOUNT * 2n,
    0, 0, USER1, deadline,
  ]);
  log(`  L1 pool created: 1000 ALPHA / 2000 BETA (rate: 1 ALPHA = 2 BETA)`);

  // Verify L1 swap rate
  const l1Preview = await l1Provider.call({
    to: routerL1Addr,
    data: routerIface.encodeFunctionData("getAmountsOut", [
      ethers.parseEther("100"), [alphaL1Addr, betaL1Addr],
    ]),
  });
  const l1Amounts = ethers.AbiCoder.defaultAbiCoder().decode(["uint256[]"], l1Preview)[0];
  log(`  L1 preview: 100 ALPHA → ${ethers.formatEther(l1Amounts[1])} BETA`);

  // ── Phase 4: Deploy wrapped tokens + bridge on L2 ──
  log("\n── Phase 4: Deploy wrapped tokens & bridge on L2 ──");

  const wAlphaAddr = await deployOnL2(encodeTokenArgs("Wrapped Alpha", "wALPHA", TOKEN_SUPPLY), USER1_KEY);
  log(`  wALPHA (L2): ${wAlphaAddr}`);

  const wBetaAddr = await deployOnL2(encodeTokenArgs("Wrapped Beta", "wBETA", TOKEN_SUPPLY), USER1_KEY);
  log(`  wBETA  (L2): ${wBetaAddr}`);

  const bridgeL1 = await deployOnL1(USER1_KEY, bridgeArt.abi, bridgeArt.bytecode.object);
  const bridgeL1Addr = await bridgeL1.getAddress();
  log(`  Bridge (L1): ${bridgeL1Addr}`);

  const bridgeL2Addr = await deployOnL2(bridgeArt.bytecode.object, USER1_KEY);
  log(`  Bridge (L2): ${bridgeL2Addr}`);

  // Transfer wrapped token supply to L2 bridge (so it can mintTo)
  const BRIDGE_RESERVE = ethers.parseEther("8000"); // keep 2000 for User1 pool liquidity
  for (const [addr, name] of [[wAlphaAddr, "wALPHA"], [wBetaAddr, "wBETA"]] as const) {
    log(`  Transferring ${name} to L2 bridge...`);
    await l2TxViaProxy(USER1_KEY, addr,
      erc20Iface.encodeFunctionData("transfer", [bridgeL2Addr, BRIDGE_RESERVE]));
    await waitForSync(`transfer ${name} to bridge`);
  }

  // ── Phase 5: Bridge tokens L1→L2 ──
  log("\n── Phase 5: Bridge tokens L1→L2 ──");

  // Register token pairs on L1 bridge (for tracking)
  await l1Call(USER1_KEY, bridgeL1Addr, BRIDGE_ABI, "registerToken", [alphaL1Addr, wAlphaAddr]);
  await l1Call(USER1_KEY, betaL1Addr, ERC20_ABI, "approve", [bridgeL1Addr, MAX_UINT256]);
  await l1Call(USER1_KEY, alphaL1Addr, ERC20_ABI, "approve", [bridgeL1Addr, MAX_UINT256]);
  log(`  L1 bridge approved and tokens registered`);

  // Deposit on L1 bridge
  await l1Call(USER1_KEY, bridgeL1Addr, BRIDGE_ABI, "deposit", [alphaL1Addr, USER1, BRIDGE_AMOUNT]);
  await l1Call(USER1_KEY, bridgeL1Addr, BRIDGE_ABI, "deposit", [betaL1Addr, USER1, BRIDGE_AMOUNT]);
  log(`  Deposited ${ethers.formatEther(BRIDGE_AMOUNT)} of each token into L1 bridge`);

  // Mint wrapped tokens on L2 for User1 (via L1→L2 cross-chain call)
  log(`  Minting wALPHA on L2 for User1...`);
  await l1ToL2Call(USER1_KEY, bridgeL2Addr,
    bridgeIface.encodeFunctionData("mintTo", [wAlphaAddr, USER1, BRIDGE_AMOUNT]));
  await waitForSync("mint wALPHA");

  log(`  Minting wBETA on L2 for User1...`);
  await l1ToL2Call(USER1_KEY, bridgeL2Addr,
    bridgeIface.encodeFunctionData("mintTo", [wBetaAddr, USER1, BRIDGE_AMOUNT]));
  await waitForSync("mint wBETA");

  // Also mint some for User2
  const USER2_AMOUNT = ethers.parseEther("500");
  log(`  Minting wALPHA on L2 for User2...`);
  await l1ToL2Call(USER1_KEY, bridgeL2Addr,
    bridgeIface.encodeFunctionData("mintTo", [wAlphaAddr, USER2, USER2_AMOUNT]));
  await waitForSync("mint wALPHA for user2");

  log(`  Minting wBETA on L2 for User2...`);
  await l1ToL2Call(USER1_KEY, bridgeL2Addr,
    bridgeIface.encodeFunctionData("mintTo", [wBetaAddr, USER2, USER2_AMOUNT]));
  await waitForSync("mint wBETA for user2");

  // Verify L2 balances
  for (const [addr, name] of [[wAlphaAddr, "wALPHA"], [wBetaAddr, "wBETA"]] as const) {
    const bal1 = await rethProvider.call({ to: addr, data: erc20Iface.encodeFunctionData("balanceOf", [USER1]) });
    const bal2 = await rethProvider.call({ to: addr, data: erc20Iface.encodeFunctionData("balanceOf", [USER2]) });
    log(`  ${name}: User1=${ethers.formatEther(BigInt(bal1))} User2=${ethers.formatEther(BigInt(bal2))}`);
  }

  // ── Phase 6: Deploy Uniswap V2 on L2 ──
  log("\n── Phase 6: Deploy Uniswap V2 on L2 ──");

  const wethL2Addr = await deployOnL2(weth9Art.bytecode.object, USER1_KEY);
  log(`  WETH9 (L2): ${wethL2Addr}`);

  const factoryConstructorArgs = ethers.AbiCoder.defaultAbiCoder().encode(["address"], [USER1]);
  const factoryL2Addr = await deployOnL2(uniFactoryArt.bytecode + factoryConstructorArgs.slice(2), USER1_KEY, 8_000_000);
  log(`  Factory (L2): ${factoryL2Addr}`);

  const routerConstructorArgs = ethers.AbiCoder.defaultAbiCoder().encode(["address", "address"], [factoryL2Addr, wethL2Addr]);
  const routerL2Addr = await deployOnL2(uniRouterArt.bytecode + routerConstructorArgs.slice(2), USER1_KEY, 8_000_000);
  log(`  Router  (L2): ${routerL2Addr}`);

  // ── Phase 7: Create L2 pool with DIFFERENT price ──
  log("\n── Phase 7: Create wALPHA/wBETA pool on L2 (ratio 1:3) ──");

  // Approve tokens for L2 router (User1)
  for (const [addr, name] of [[wAlphaAddr, "wALPHA"], [wBetaAddr, "wBETA"]] as const) {
    log(`  Approving ${name} for L2 router...`);
    await l2TxViaProxy(USER1_KEY, addr,
      erc20Iface.encodeFunctionData("approve", [routerL2Addr, MAX_UINT256]));
    await waitForSync(`approve ${name}`);
  }

  // L2 pool: 1000 ALPHA + 3000 BETA → 1 ALPHA = 3 BETA (vs 2 on L1!)
  const L2_ALPHA_LIQ = ethers.parseEther("1000");
  const L2_BETA_LIQ = ethers.parseEther("3000");
  log(`  Adding liquidity: ${ethers.formatEther(L2_ALPHA_LIQ)} wALPHA + ${ethers.formatEther(L2_BETA_LIQ)} wBETA`);
  await l2TxViaProxy(USER1_KEY, routerL2Addr,
    routerIface.encodeFunctionData("addLiquidity", [
      wAlphaAddr, wBetaAddr,
      L2_ALPHA_LIQ, L2_BETA_LIQ,
      0, 0, USER1, deadline,
    ]), 0n, 5_000_000);
  await waitForSync("create L2 pool");

  // Verify L2 swap rate
  const l2Preview = await rethProvider.call({
    to: routerL2Addr,
    data: routerIface.encodeFunctionData("getAmountsOut", [
      ethers.parseEther("100"), [wAlphaAddr, wBetaAddr],
    ]),
  });
  const l2Amounts = ethers.AbiCoder.defaultAbiCoder().decode(["uint256[]"], l2Preview)[0];
  log(`  L2 preview: 100 wALPHA → ${ethers.formatEther(l2Amounts[1])} wBETA`);
  log(`  Price difference: L1 gives ~${ethers.formatEther(l1Amounts[1])} BETA, L2 gives ~${ethers.formatEther(l2Amounts[1])} wBETA`);
  log(`  → Arbitrage opportunity: buy BETA with ALPHA on L2 (cheaper ALPHA)`);

  // ── Phase 8: Deploy Arbitrageur & approve ──
  log("\n── Phase 8: Deploy Arbitrageur on L2 ──");

  const arbL2Addr = await deployOnL2(arbitrageurArt.bytecode.object, USER2_KEY);
  log(`  Arbitrageur (L2): ${arbL2Addr}`);

  // User2 approves Arbitrageur to spend tokens
  for (const [addr, name] of [[wAlphaAddr, "wALPHA"], [wBetaAddr, "wBETA"]] as const) {
    log(`  User2 approving ${name} for Arbitrageur...`);
    await l2TxViaProxy(USER2_KEY, addr,
      erc20Iface.encodeFunctionData("approve", [arbL2Addr, MAX_UINT256]));
    await waitForSync(`approve ${name} for arb`);
  }

  // ── Phase 9: Execute atomic cross-chain arbitrage! ──
  log("\n── Phase 9: ATOMIC CROSS-CHAIN ARBITRAGE ──");

  // Check User2 balances before
  const alphaBefore = BigInt(await rethProvider.call({
    to: wAlphaAddr, data: erc20Iface.encodeFunctionData("balanceOf", [USER2]),
  }));
  const betaBefore = BigInt(await rethProvider.call({
    to: wBetaAddr, data: erc20Iface.encodeFunctionData("balanceOf", [USER2]),
  }));
  log(`  User2 before: ${ethers.formatEther(alphaBefore)} wALPHA, ${ethers.formatEther(betaBefore)} wBETA`);

  // Step 1: On L1, swap ALPHA → BETA at the L1 rate (1:2)
  // User1 does this on L1 Uniswap directly
  log(`\n  Step 1: Swap ${ethers.formatEther(ARB_AMOUNT)} ALPHA → BETA on L1 Uniswap (rate ~1:2)...`);
  const l1SwapReceipt = await l1Call(USER1_KEY, routerL1Addr, ROUTER_ABI, "swapExactTokensForTokens", [
    ARB_AMOUNT, 0, [alphaL1Addr, betaL1Addr], USER1, deadline,
  ]);
  log(`    L1 swap tx: ${l1SwapReceipt.hash}`);

  // Check how much BETA User1 got on L1
  const betaBalL1 = BigInt(await l1Provider.call({
    to: betaL1Addr, data: erc20Iface.encodeFunctionData("balanceOf", [USER1]),
  }));
  log(`    User1 L1 BETA balance: ${ethers.formatEther(betaBalL1)}`);

  // Step 2: On L2, swap wALPHA → wBETA at the L2 rate (1:3) — more BETA per ALPHA!
  log(`\n  Step 2: Swap ${ethers.formatEther(ARB_AMOUNT)} wALPHA → wBETA on L2 Uniswap (rate ~1:3)...`);

  // Preview exact output
  const previewL2 = await rethProvider.call({
    to: arbL2Addr,
    data: arbIface.encodeFunctionData("previewSwap", [routerL2Addr, wAlphaAddr, wBetaAddr, ARB_AMOUNT]),
  });
  const expectedBetaL2 = BigInt(previewL2);
  log(`    Expected output: ${ethers.formatEther(expectedBetaL2)} wBETA`);

  // Execute the L2 swap via the Arbitrageur contract
  await l2TxViaProxy(USER2_KEY, arbL2Addr,
    arbIface.encodeFunctionData("executeSwap", [
      routerL2Addr, wAlphaAddr, wBetaAddr, ARB_AMOUNT, 0,
    ]), 0n, 1_000_000);
  await waitForSync("L2 arb swap");

  // Check User2 balances after
  const alphaAfter = BigInt(await rethProvider.call({
    to: wAlphaAddr, data: erc20Iface.encodeFunctionData("balanceOf", [USER2]),
  }));
  const betaAfter = BigInt(await rethProvider.call({
    to: wBetaAddr, data: erc20Iface.encodeFunctionData("balanceOf", [USER2]),
  }));
  log(`\n  User2 after:  ${ethers.formatEther(alphaAfter)} wALPHA, ${ethers.formatEther(betaAfter)} wBETA`);

  const alphaSpent = alphaBefore - alphaAfter;
  const betaGained = betaAfter - betaBefore;
  log(`  User2 spent:  ${ethers.formatEther(alphaSpent)} wALPHA`);
  log(`  User2 gained: ${ethers.formatEther(betaGained)} wBETA`);

  // The arbitrage profit: on L1, 100 ALPHA → ~181 BETA. On L2, 100 ALPHA → ~230 BETA.
  // The extra BETA from L2 vs L1 is the arbitrage profit.
  const l1BetaForSameAlpha = l1Amounts[1] as bigint;
  const profit = betaGained - l1BetaForSameAlpha;

  log(`\n  ══════════════════════════════════════════`);
  log(`  ARBITRAGE RESULT:`);
  log(`  ──────────────────────────────────────────`);
  log(`  L1 rate: 100 ALPHA → ${ethers.formatEther(l1BetaForSameAlpha)} BETA`);
  log(`  L2 rate: 100 wALPHA → ${ethers.formatEther(betaGained)} wBETA`);
  log(`  PROFIT: ${ethers.formatEther(profit)} BETA (${((Number(profit) / Number(l1BetaForSameAlpha)) * 100).toFixed(1)}% better on L2)`);
  log(`  ══════════════════════════════════════════`);

  // Final state
  const l1BalFinal = await l1Provider.getBalance(USER1);
  log(`\n  User1 remaining xDAI: ${ethers.formatEther(l1BalFinal)}`);

  // Summary
  console.log("\n=== Contract Addresses ===");
  console.log(`L1 ALPHA:      ${alphaL1Addr}`);
  console.log(`L1 BETA:       ${betaL1Addr}`);
  console.log(`L1 WETH9:      ${wethL1Addr}`);
  console.log(`L1 Factory:    ${factoryL1Addr}`);
  console.log(`L1 Router:     ${routerL1Addr}`);
  console.log(`L1 Bridge:     ${bridgeL1Addr}`);
  console.log(`L2 wALPHA:     ${wAlphaAddr}`);
  console.log(`L2 wBETA:      ${wBetaAddr}`);
  console.log(`L2 WETH9:      ${wethL2Addr}`);
  console.log(`L2 Factory:    ${factoryL2Addr}`);
  console.log(`L2 Router:     ${routerL2Addr}`);
  console.log(`L2 Bridge:     ${bridgeL2Addr}`);
  console.log(`L2 Arbitrageur: ${arbL2Addr}`);
  console.log("");
}

main().catch(e => {
  console.error("\nFATAL:", e.message || e);
  process.exit(1);
});
