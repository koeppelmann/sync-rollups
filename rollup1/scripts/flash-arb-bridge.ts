#!/usr/bin/env npx tsx
/**
 * Flash Loan Cross-Chain Arbitrage with Token Bridge
 *
 * Tests incrementally:
 *   Step A: Bridge COW L1→L2 (lock on L1, mint wCOW on L2)
 *   Step B: Bridge + swap on L2 (TradeHelper swaps wCOW→wETH)
 *   Step C: Bridge + swap + bridge wETH back to L1
 *   Step D: Full flash loan wrapping everything
 *
 * Run: npx tsx scripts/flash-arb-bridge.ts [--step A|B|C|D]
 */

import { ethers, AbiCoder, Wallet, NonceManager } from "ethers";
import fs from "fs";
import path from "path";

// ============ Configuration ============
const L1_RPC = "http://localhost:8545";
const BUILDER_URL = "http://localhost:3200";
const L2_RPC_PROXY = "http://localhost:9548";
const RETH_EVM = "http://localhost:9546";
const ETHREX_EVM = "http://localhost:9556";

// Account1 reserved for builder. Use Account2 as admin, Account3 as arb.
const ADMIN = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const ADMIN_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const ARB = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const ARB_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";

// Read env
const dotenv = fs.readFileSync(
  new URL("../.env.local", import.meta.url), "utf8"
);
const ROLLUPS_ADDRESS = dotenv.match(/ROLLUPS_ADDRESS=(.+)/)?.[1]?.trim()!;
const ROLLUP_ID = dotenv.match(/ROLLUP_ID=(.+)/)?.[1]?.trim() || "0";
const L2_CHAIN_ID = dotenv.match(/L2_CHAIN_ID=(.+)/)?.[1]?.trim() || "10200200";

const OPERATOR_KEY = ethers.solidityPackedKeccak256(
  ["string", "address", "uint256", "uint256"],
  ["sync-rollups-operator", ROLLUPS_ADDRESS, ROLLUP_ID, L2_CHAIN_ID]
);
const OPERATOR = new Wallet(OPERATOR_KEY).address;

// ============ ABIs ============
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function transfer(address, uint256) returns (bool)",
  "function transferFrom(address, address, uint256) returns (bool)",
  "function allowance(address, address) view returns (uint256)",
];

const ROUTER_ABI = [
  "function addLiquidity(address,address,uint,uint,uint,uint,address,uint) returns (uint,uint,uint)",
  "function swapExactTokensForTokens(uint,uint,address[],address,uint) returns (uint[])",
  "function getAmountsOut(uint,address[]) view returns (uint[])",
];

const BRIDGE_ABI = [
  "function registerToken(address, address) external",
  "function deposit(address, address, uint256) external",
  "function releaseTo(address, address, uint256) external",
  "function mintTo(address, address, uint256) external",
  "function lockedBalance(address) view returns (uint256)",
];

const TRADE_HELPER_ABI = [
  "function executeArb(address,address,address,address,uint256,uint256,address) external returns (uint256)",
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

async function waitForSync(maxWaitMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const [reth, ethrex] = await Promise.all([
      callJsonRpc(RETH_EVM, "eth_getBlockByNumber", ["latest", false]),
      callJsonRpc(ETHREX_EVM, "eth_getBlockByNumber", ["latest", false]),
    ]);
    if (parseInt(reth.number, 16) === parseInt(ethrex.number, 16) &&
        reth.stateRoot === ethrex.stateRoot) {
      return { rethBlock: parseInt(reth.number, 16), rethState: reth.stateRoot,
               ethrexBlock: parseInt(ethrex.number, 16), ethrexState: ethrex.stateRoot };
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  const reth = await callJsonRpc(RETH_EVM, "eth_getBlockByNumber", ["latest", false]);
  const ethrex = await callJsonRpc(ETHREX_EVM, "eth_getBlockByNumber", ["latest", false]);
  return { rethBlock: parseInt(reth.number, 16), rethState: reth.stateRoot,
           ethrexBlock: parseInt(ethrex.number, 16), ethrexState: ethrex.stateRoot };
}

async function waitForBuilderSync(maxWaitMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const status = await fetch(`${BUILDER_URL}/status`).then(r => r.json()) as any;
      if (status.isSynced) return;
    } catch {}
    await new Promise(r => setTimeout(r, 2000));
  }
  log("  WARNING: builder sync timeout");
}

async function deployOnL1(signer: ethers.Signer, abi: any[], bytecode: string, args: any[] = []): Promise<ethers.Contract> {
  const factory = new ethers.ContractFactory(abi, bytecode, signer);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  return new ethers.Contract(await contract.getAddress(), abi, signer);
}

async function deployOnL2(bytecodeWithArgs: string, signerKey: string, gasLimit = 5_000_000): Promise<string> {
  const provider = new ethers.JsonRpcProvider(L2_RPC_PROXY);
  const wallet = new ethers.Wallet(signerKey, provider);
  const nonce = await provider.getTransactionCount(wallet.address, "pending");
  const feeData = await provider.getFeeData();
  const tx = await wallet.sendTransaction({
    data: bytecodeWithArgs, gasLimit, nonce,
    maxFeePerGas: feeData.maxFeePerGas || undefined,
    maxPriorityFeePerGas: 0n,
  });
  log(`    L2 deploy tx: ${tx.hash}`);
  await new Promise(r => setTimeout(r, 8000));
  await waitForBuilderSync(30000);
  await waitForSync(20000);
  const rethProvider = new ethers.JsonRpcProvider(RETH_EVM);
  const receipt = await rethProvider.getTransactionReceipt(tx.hash);
  if (!receipt || !receipt.contractAddress) throw new Error(`L2 deploy failed: ${tx.hash}`);
  return receipt.contractAddress;
}

async function l2TxViaProxy(privateKey: string, to: string, data: string, value = 0n, gasLimit = 500_000): Promise<string> {
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

async function bridgeEthToL2(sourceAddress: string, wallet: ethers.Signer, amount: string) {
  const prepResp = await fetch(`${BUILDER_URL}/prepare-l1-call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ l2Target: sourceAddress, value: ethers.parseEther(amount).toString(), data: "0x", sourceAddress }),
  }).then(r => r.json()) as any;
  if (!prepResp.success) throw new Error(`Bridge prep failed: ${prepResp.error}`);
  const bridgeTx = await wallet.sendTransaction({ to: prepResp.proxyAddress, data: "0x", value: ethers.parseEther(amount) });
  await bridgeTx.wait();
  log(`  Bridged ${amount} ETH to ${shortAddr(sourceAddress)} on L2`);
  await new Promise(r => setTimeout(r, 8000));
  await waitForBuilderSync(30000);
  await waitForSync(20000);
}

async function getL2Balance(tokenAddr: string, account: string): Promise<bigint> {
  const rethProvider = new ethers.JsonRpcProvider(RETH_EVM);
  const erc20Iface = new ethers.Interface(ERC20_ABI);
  const result = await rethProvider.call({
    to: tokenAddr, data: erc20Iface.encodeFunctionData("balanceOf", [account]),
  });
  return BigInt(result);
}

// ============ Main ============
async function main() {
  const step = process.argv.find(a => a === "--step") ? process.argv[process.argv.indexOf("--step") + 1] : "D";

  const l1Provider = new ethers.JsonRpcProvider(L1_RPC);
  const adminWallet = new NonceManager(new Wallet(ADMIN_KEY, l1Provider));
  const arbWallet = new NonceManager(new Wallet(ARB_KEY, l1Provider));
  const rethProvider = new ethers.JsonRpcProvider(RETH_EVM);
  const erc20Iface = new ethers.Interface(ERC20_ABI);

  const projectRoot = path.resolve(new URL(".", import.meta.url).pathname, "../..");
  const loadArtifact = (name: string, subdir: string) =>
    JSON.parse(fs.readFileSync(path.join(projectRoot, "out", subdir, name + ".json"), "utf8"));

  const simpleTokenArt = loadArtifact("SimpleToken", "SimpleToken.sol");
  const weth9Art = loadArtifact("WETH9", "WETH9.sol");
  const flashLenderArt = loadArtifact("FlashLender", "FlashLender.sol");
  const atomicArbArt = loadArtifact("AtomicArbL1", "AtomicArbL1.sol");
  const tokenBridgeArt = loadArtifact("TokenBridge", "TokenBridge.sol");
  const tradeHelperArt = loadArtifact("TradeHelper", "TradeHelper.sol");
  const uniFactoryArt = JSON.parse(fs.readFileSync(
    path.join(projectRoot, "node_modules/@uniswap/v2-core/build/UniswapV2Factory.json"), "utf8"));
  if (!uniFactoryArt.bytecode.startsWith("0x")) uniFactoryArt.bytecode = "0x" + uniFactoryArt.bytecode;
  const uniRouterArt = JSON.parse(fs.readFileSync(
    path.join(projectRoot, "node_modules/@uniswap/v2-periphery/build/UniswapV2Router02.json"), "utf8"));
  if (!uniRouterArt.bytecode.startsWith("0x")) uniRouterArt.bytecode = "0x" + uniRouterArt.bytecode;

  const encodeTokenArgs = (name: string, symbol: string, supply: bigint) => {
    const args = AbiCoder.defaultAbiCoder().encode(["string", "string", "uint256"], [name, symbol, supply]);
    return simpleTokenArt.bytecode.object + args.slice(2);
  };

  const TOKEN_SUPPLY = ethers.parseEther("100000");
  const POOL_AMOUNT = ethers.parseEther("10000");
  const deadline = Math.floor(Date.now() / 1000) + 36000;

  console.log(`\n=== Flash Arb Bridge Demo (Step ${step}) ===\n`);
  log(`Operator: ${OPERATOR}`);

  // ──── Phase 0: Bridge ETH to L2 for ADMIN ────
  log("\n-- Phase 0: Bridge ETH to L2 --");
  await bridgeEthToL2(ADMIN, adminWallet, "50");

  // Reset nonce managers after bridge delays
  adminWallet.reset();
  arbWallet.reset();

  // ──── Phase 1: Deploy tokens on L1 ────
  log("\n-- Phase 1: Deploy L1 tokens --");
  const cowL1 = await deployOnL1(adminWallet, simpleTokenArt.abi, simpleTokenArt.bytecode.object,
    ["CoW Protocol Token", "COW", TOKEN_SUPPLY]);
  const cowL1Addr = await cowL1.getAddress();
  log(`  COW (L1): ${cowL1Addr}`);

  const wethL1 = await deployOnL1(adminWallet, weth9Art.abi, weth9Art.bytecode.object);
  const wethL1Addr = await wethL1.getAddress();
  const wethIface = new ethers.Interface(["function deposit() payable"]);
  await (await adminWallet.sendTransaction({ to: wethL1Addr, data: wethIface.encodeFunctionData("deposit"), value: ethers.parseEther("5000") })).wait();
  log(`  WETH (L1): ${wethL1Addr} (wrapped 5000 ETH)`);

  // ──── Phase 2: Deploy Uniswap V2 on L1 ────
  log("\n-- Phase 2: Deploy Uniswap on L1 --");
  const factoryL1 = await deployOnL1(adminWallet, uniFactoryArt.abi, uniFactoryArt.bytecode, [ADMIN]);
  const factoryL1Addr = await factoryL1.getAddress();
  const routerL1 = await deployOnL1(adminWallet, uniRouterArt.abi, uniRouterArt.bytecode, [factoryL1Addr, wethL1Addr]);
  const routerL1Addr = await routerL1.getAddress();
  log(`  Router (L1): ${routerL1Addr}`);

  // L1 pool: 10000 COW / 2400 WETH → 1 COW ≈ 0.24 WETH (COW cheap on L1)
  await cowL1.approve(routerL1Addr, ethers.MaxUint256);
  const wethContract = new ethers.Contract(wethL1Addr, ERC20_ABI, adminWallet);
  await wethContract.approve(routerL1Addr, ethers.MaxUint256);
  const routerL1Contract = new ethers.Contract(routerL1Addr, ROUTER_ABI, adminWallet);
  await routerL1Contract.addLiquidity(cowL1Addr, wethL1Addr, POOL_AMOUNT, ethers.parseEther("2400"), 0, 0, ADMIN, deadline);
  log(`  L1 pool: 10000 COW / 2400 WETH`);

  // ──── Phase 3: Deploy L2 tokens + Uniswap + pools ────
  log("\n-- Phase 3: Deploy L2 tokens + Uniswap --");
  const wCowAddr = await deployOnL2(encodeTokenArgs("Wrapped CoW", "wCOW", TOKEN_SUPPLY), ADMIN_KEY);
  log(`  wCOW (L2): ${wCowAddr}`);
  const wEthL2Addr = await deployOnL2(encodeTokenArgs("Wrapped Ether", "wETH", TOKEN_SUPPLY), ADMIN_KEY);
  log(`  wETH (L2): ${wEthL2Addr}`);

  const factoryConstructorArgs = AbiCoder.defaultAbiCoder().encode(["address"], [ADMIN]);
  const factoryL2Addr = await deployOnL2(uniFactoryArt.bytecode + factoryConstructorArgs.slice(2), ADMIN_KEY, 8_000_000);
  const routerConstructorArgs = AbiCoder.defaultAbiCoder().encode(["address", "address"], [factoryL2Addr, wEthL2Addr]);
  const routerL2Addr = await deployOnL2(uniRouterArt.bytecode + routerConstructorArgs.slice(2), ADMIN_KEY, 8_000_000);
  log(`  Router (L2): ${routerL2Addr}`);

  // Approve + add liquidity on L2
  const routerIface = new ethers.Interface(ROUTER_ABI);
  await l2TxViaProxy(ADMIN_KEY, wCowAddr, erc20Iface.encodeFunctionData("approve", [routerL2Addr, ethers.MaxUint256]));
  await new Promise(r => setTimeout(r, 8000)); await waitForSync(20000);
  await l2TxViaProxy(ADMIN_KEY, wEthL2Addr, erc20Iface.encodeFunctionData("approve", [routerL2Addr, ethers.MaxUint256]));
  await new Promise(r => setTimeout(r, 8000)); await waitForSync(20000);

  // L2 pool: 10000 wCOW / 2400 wETH (same initial price)
  await l2TxViaProxy(ADMIN_KEY, routerL2Addr,
    routerIface.encodeFunctionData("addLiquidity", [
      wCowAddr, wEthL2Addr, POOL_AMOUNT, ethers.parseEther("2400"), 0, 0, ADMIN, deadline,
    ]), 0n, 5_000_000);
  await new Promise(r => setTimeout(r, 8000)); await waitForSync(20000);
  log(`  L2 pool: 10000 wCOW / 2400 wETH`);

  // ──── Phase 4: Move L2 price (make wCOW expensive on L2) ────
  log("\n-- Phase 4: Make wCOW expensive on L2 --");
  // Sell 600 wETH → wCOW on L2, pushing wCOW price UP
  const tradeAmount = ethers.parseEther("600");
  await l2TxViaProxy(ADMIN_KEY, routerL2Addr,
    routerIface.encodeFunctionData("swapExactTokensForTokens", [
      tradeAmount, 0, [wEthL2Addr, wCowAddr], ADMIN, deadline,
    ]), 0n, 1_000_000);
  await new Promise(r => setTimeout(r, 8000)); await waitForSync(20000);

  // Show prices
  const l1Preview = await routerL1Contract.getAmountsOut(ethers.parseEther("100"), [wethL1Addr, cowL1Addr]);
  const l2PreviewData = await rethProvider.call({
    to: routerL2Addr,
    data: routerIface.encodeFunctionData("getAmountsOut", [ethers.parseEther("100"), [wCowAddr, wEthL2Addr]]),
  });
  const l2Preview = AbiCoder.defaultAbiCoder().decode(["uint256[]"], l2PreviewData)[0];
  log(`  L1: 100 WETH → ${ethers.formatEther(l1Preview[1])} COW (COW is cheap)`);
  log(`  L2: 100 wCOW → ${ethers.formatEther(l2Preview[1])} wETH (wCOW is expensive)`);

  // ──── Phase 5: Deploy bridges + FlashLender + AtomicArb + TradeHelper ────
  log("\n-- Phase 5: Deploy infrastructure --");

  // L1 contracts
  const flashLender = await deployOnL1(adminWallet, flashLenderArt.abi, flashLenderArt.bytecode.object);
  const flashLenderAddr = await flashLender.getAddress();
  log(`  FlashLender (L1): ${flashLenderAddr}`);

  const atomicArb = await deployOnL1(arbWallet, atomicArbArt.abi, atomicArbArt.bytecode.object);
  const atomicArbAddr = await atomicArb.getAddress();
  log(`  AtomicArbL1 (L1): ${atomicArbAddr}`);

  const l1Bridge = await deployOnL1(adminWallet, tokenBridgeArt.abi, tokenBridgeArt.bytecode.object);
  const l1BridgeAddr = await l1Bridge.getAddress();
  log(`  TokenBridge (L1): ${l1BridgeAddr}`);

  // Register COW↔wCOW and WETH↔wETH on L1 bridge
  await l1Bridge.registerToken(cowL1Addr, wCowAddr);
  await l1Bridge.registerToken(wethL1Addr, wEthL2Addr);
  log(`  L1 bridge: registered COW↔wCOW, WETH↔wETH`);

  // Pre-fund L1 bridge with WETH (for bridge-back in Step C/D)
  const bridgeWethAmount = ethers.parseEther("500");
  await wethContract.approve(l1BridgeAddr, bridgeWethAmount);
  await l1Bridge.deposit(wethL1Addr, ADMIN, bridgeWethAmount);
  log(`  L1 bridge funded with ${ethers.formatEther(bridgeWethAmount)} WETH`);

  // Fund FlashLender with WETH
  const flashWethAmount = ethers.parseEther("1000");
  await wethContract.approve(flashLenderAddr, flashWethAmount);
  const flashLenderDeposit = new ethers.Interface(["function deposit(address,uint256) external"]);
  await (await adminWallet.sendTransaction({
    to: flashLenderAddr,
    data: flashLenderDeposit.encodeFunctionData("deposit", [wethL1Addr, flashWethAmount]),
  })).wait();
  log(`  FlashLender funded with ${ethers.formatEther(flashWethAmount)} WETH`);

  // L2 contracts
  const l2BridgeAddr = await deployOnL2(tokenBridgeArt.bytecode.object, ADMIN_KEY);
  log(`  TokenBridge (L2): ${l2BridgeAddr}`);

  // Register tokens on L2 bridge
  const bridgeIface = new ethers.Interface(BRIDGE_ABI);
  await l2TxViaProxy(ADMIN_KEY, l2BridgeAddr, bridgeIface.encodeFunctionData("registerToken", [cowL1Addr, wCowAddr]));
  await new Promise(r => setTimeout(r, 8000)); await waitForSync(20000);
  await l2TxViaProxy(ADMIN_KEY, l2BridgeAddr, bridgeIface.encodeFunctionData("registerToken", [wethL1Addr, wEthL2Addr]));
  await new Promise(r => setTimeout(r, 8000)); await waitForSync(20000);
  log(`  L2 bridge: registered tokens`);

  // Fund L2 bridge with wCOW (for mintTo)
  const bridgeWcowAmount = ethers.parseEther("5000");
  await l2TxViaProxy(ADMIN_KEY, wCowAddr, erc20Iface.encodeFunctionData("transfer", [l2BridgeAddr, bridgeWcowAmount]));
  await new Promise(r => setTimeout(r, 8000)); await waitForSync(20000);
  log(`  L2 bridge funded with ${ethers.formatEther(bridgeWcowAmount)} wCOW`);

  // Fund L2 bridge with wETH (for WETH bridge-back tracking)
  const bridgeWethL2 = ethers.parseEther("500");
  await l2TxViaProxy(ADMIN_KEY, wEthL2Addr, erc20Iface.encodeFunctionData("transfer", [l2BridgeAddr, bridgeWethL2]));
  await new Promise(r => setTimeout(r, 8000)); await waitForSync(20000);

  const tradeHelperAddr = await deployOnL2(tradeHelperArt.bytecode.object, ADMIN_KEY);
  log(`  TradeHelper (L2): ${tradeHelperAddr}`);

  // ──── STEP A: Bridge COW L1→L2 ────
  if (step >= "A") {
    log("\n========== STEP A: Bridge COW L1→L2 ==========");

    // Admin deposits 100 COW into L1 bridge, targeting tradeHelper on L2
    const bridgeAmount = ethers.parseEther("100");
    await cowL1.approve(l1BridgeAddr, bridgeAmount);
    await l1Bridge.deposit(cowL1Addr, tradeHelperAddr, bridgeAmount);
    log(`  Locked ${ethers.formatEther(bridgeAmount)} COW in L1 bridge`);

    // L1→L2 call: L2 bridge mints wCOW to tradeHelper
    const mintCalldata = bridgeIface.encodeFunctionData("mintTo", [wCowAddr, tradeHelperAddr, bridgeAmount]);

    const prepMint = await fetch(`${BUILDER_URL}/prepare-l1-call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        l2Target: l2BridgeAddr,
        value: "0",
        data: mintCalldata,
        sourceAddress: ADMIN,
      }),
    }).then(r => r.json()) as any;

    if (!prepMint.success) throw new Error(`Prepare mint failed: ${prepMint.error}`);
    log(`  Execution entry loaded. Proxy: ${prepMint.proxyAddress}`);

    // Execute the proxy call on L1
    const mintTx = await adminWallet.sendTransaction({
      to: prepMint.proxyAddress,
      data: mintCalldata,
      gasLimit: 2_000_000,
    });
    await mintTx.wait();
    log(`  L1 proxy call: ${mintTx.hash}`);

    await new Promise(r => setTimeout(r, 8000));
    await waitForBuilderSync(30000);
    await waitForSync(20000);

    // Verify wCOW balance on L2
    const tradeHelperWcow = await getL2Balance(wCowAddr, tradeHelperAddr);
    log(`  TradeHelper wCOW balance on L2: ${ethers.formatEther(tradeHelperWcow)}`);

    if (tradeHelperWcow >= bridgeAmount) {
      log(`  ✓ STEP A PASSED: wCOW successfully bridged to L2`);
    } else {
      log(`  ✗ STEP A FAILED: expected ${ethers.formatEther(bridgeAmount)} wCOW, got ${ethers.formatEther(tradeHelperWcow)}`);
      return;
    }
  }

  // ──── STEP B: Bridge + Swap on L2 ────
  if (step >= "B") {
    log("\n========== STEP B: Bridge + Swap (TradeHelper) ==========");

    const bridgeAmount = ethers.parseEther("200");
    await cowL1.approve(l1BridgeAddr, bridgeAmount);
    await l1Bridge.deposit(cowL1Addr, tradeHelperAddr, bridgeAmount);
    log(`  Locked ${ethers.formatEther(bridgeAmount)} COW in L1 bridge`);

    // L1→L2 call: TradeHelper.executeArb (mints wCOW from bridge + swaps wCOW→wETH)
    // bridgeBack = address(0) → don't bridge back yet, keep wETH in TradeHelper
    const tradeHelperIface = new ethers.Interface(TRADE_HELPER_ABI);
    const arbCalldata = tradeHelperIface.encodeFunctionData("executeArb", [
      l2BridgeAddr, wCowAddr, wEthL2Addr, routerL2Addr,
      bridgeAmount, 0, ethers.ZeroAddress,
    ]);

    const prepSwap = await fetch(`${BUILDER_URL}/prepare-l1-call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        l2Target: tradeHelperAddr,
        value: "0",
        data: arbCalldata,
        sourceAddress: ADMIN,
      }),
    }).then(r => r.json()) as any;

    if (!prepSwap.success) throw new Error(`Prepare swap failed: ${prepSwap.error}`);
    log(`  Execution entry loaded. Proxy: ${prepSwap.proxyAddress}`);

    const swapTx = await adminWallet.sendTransaction({
      to: prepSwap.proxyAddress,
      data: arbCalldata,
      gasLimit: 2_000_000,
    });
    await swapTx.wait();
    log(`  L1 proxy call: ${swapTx.hash}`);

    await new Promise(r => setTimeout(r, 8000));
    await waitForBuilderSync(30000);
    await waitForSync(20000);

    // Verify wETH balance on L2 TradeHelper
    const tradeHelperWeth = await getL2Balance(wEthL2Addr, tradeHelperAddr);
    log(`  TradeHelper wETH balance on L2: ${ethers.formatEther(tradeHelperWeth)}`);

    if (tradeHelperWeth > 0n) {
      log(`  ✓ STEP B PASSED: wCOW bridged and swapped to ${ethers.formatEther(tradeHelperWeth)} wETH on L2`);
    } else {
      log(`  ✗ STEP B FAILED: TradeHelper has no wETH`);
      return;
    }
  }

  // ──── STEP C: Bridge + Swap + Bridge wETH Back ────
  if (step >= "C") {
    log("\n========== STEP C: Bridge + Swap + Bridge Back ==========");

    const bridgeAmount = ethers.parseEther("200");
    await cowL1.approve(l1BridgeAddr, bridgeAmount);
    await l1Bridge.deposit(cowL1Addr, tradeHelperAddr, bridgeAmount);
    log(`  Locked ${ethers.formatEther(bridgeAmount)} COW in L1 bridge`);

    // This time bridgeBack = l2BridgeAddr (TradeHelper sends wETH to L2 bridge)
    const tradeHelperIface = new ethers.Interface(TRADE_HELPER_ABI);
    const arbCalldata = tradeHelperIface.encodeFunctionData("executeArb", [
      l2BridgeAddr, wCowAddr, wEthL2Addr, routerL2Addr,
      bridgeAmount, 0, l2BridgeAddr,
    ]);

    // Prepare with sourceAddress=ADMIN so ADMIN can call directly
    const prepSwap = await fetch(`${BUILDER_URL}/prepare-l1-call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        l2Target: tradeHelperAddr,
        value: "0",
        data: arbCalldata,
        sourceAddress: ADMIN,
      }),
    }).then(r => r.json()) as any;

    if (!prepSwap.success) throw new Error(`Prepare swap failed: ${prepSwap.error}`);
    log(`  Execution entry loaded. Proxy: ${prepSwap.proxyAddress}`);

    const l2BridgeWethBefore = await getL2Balance(wEthL2Addr, l2BridgeAddr);

    const swapTx = await adminWallet.sendTransaction({
      to: prepSwap.proxyAddress,
      data: arbCalldata,
      gasLimit: 2_000_000,
    });
    await swapTx.wait();
    log(`  L1 proxy call: ${swapTx.hash}`);

    await new Promise(r => setTimeout(r, 8000));
    await waitForBuilderSync(30000);
    await waitForSync(20000);

    const l2BridgeWethAfter = await getL2Balance(wEthL2Addr, l2BridgeAddr);
    const wethBridged = l2BridgeWethAfter - l2BridgeWethBefore;
    log(`  L2 bridge wETH change: +${ethers.formatEther(wethBridged)}`);

    // Now test L1 bridge release
    const arbWethBefore = await wethContract.balanceOf(ARB);
    await l1Bridge.releaseTo(wethL1Addr, ARB, wethBridged);
    const arbWethAfter = await wethContract.balanceOf(ARB);
    log(`  L1 bridge released ${ethers.formatEther(arbWethAfter - arbWethBefore)} WETH to ARB`);

    if (wethBridged > 0n) {
      log(`  ✓ STEP C PASSED: bridged ${ethers.formatEther(bridgeAmount)} COW → L2 swap → ${ethers.formatEther(wethBridged)} wETH → released on L1`);
    } else {
      log(`  ✗ STEP C FAILED`);
      return;
    }
  }

  // ──── STEP D: Full Flash Loan ────
  if (step >= "D") {
    log("\n========== STEP D: FULL FLASH LOAN CROSS-CHAIN ARB ==========");

    // The amount to flash borrow
    const borrowAmount = ethers.parseEther("100");

    // Preview: how much COW do we get for 100 WETH on L1?
    const cowPreview = await routerL1Contract.getAmountsOut(borrowAmount, [wethL1Addr, cowL1Addr]);
    const expectedCow = cowPreview[1];
    log(`  Preview: ${ethers.formatEther(borrowAmount)} WETH → ${ethers.formatEther(expectedCow)} COW on L1`);

    // Preview: how much wETH for that much wCOW on L2?
    const l2WethPreview = await rethProvider.call({
      to: routerL2Addr,
      data: routerIface.encodeFunctionData("getAmountsOut", [expectedCow, [wCowAddr, wEthL2Addr]]),
    });
    const expectedWeth = AbiCoder.defaultAbiCoder().decode(["uint256[]"], l2WethPreview)[0][1];
    log(`  Preview: ${ethers.formatEther(expectedCow)} wCOW → ${ethers.formatEther(expectedWeth)} wETH on L2`);
    log(`  Expected profit: ${ethers.formatEther(expectedWeth - borrowAmount)} WETH`);

    // Lock COW in L1 bridge (the AtomicArbL1 will do this inside the flash loan)
    // But we need to pre-deposit COW. Actually, the arb contract deposits inside the callback.
    // The arb contract swaps WETH→COW, then deposits COW.
    // So no pre-deposit needed — the contract handles it.

    // Prepare L2 execution: TradeHelper.executeArb (bridge mint + swap + bridge back)
    const tradeHelperIface = new ethers.Interface(TRADE_HELPER_ABI);
    const arbCalldata = tradeHelperIface.encodeFunctionData("executeArb", [
      l2BridgeAddr, wCowAddr, wEthL2Addr, routerL2Addr,
      expectedCow,  // cowAmount: amount minted from bridge
      0,             // minWethOut: 0 for demo
      l2BridgeAddr,  // bridgeBack: send wETH to L2 bridge
    ]);

    // Prepare with deferMine, sourceAddress = atomicArbAddr
    log("  Requesting deferred postBatch from builder...");
    const prepSwap = await fetch(`${BUILDER_URL}/prepare-l1-call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        l2Target: tradeHelperAddr,
        value: "0",
        data: arbCalldata,
        sourceAddress: atomicArbAddr,
        deferMine: true,
      }),
    }).then(r => r.json()) as any;

    if (!prepSwap.success) throw new Error(`Prepare failed: ${prepSwap.error}`);
    const l2ProxyAddr = prepSwap.proxyAddress;
    log(`  postBatch in mempool: ${prepSwap.postBatchTxHash}`);
    log(`  TradeHelper proxy: ${l2ProxyAddr}`);

    // Capture balances
    const arbWethBefore = await wethContract.balanceOf(ARB);

    // Build the full flash arb tx
    const FLASH_ARB_ABI = [
      "function executeFlashArb(address,address,address,address,address,uint256,address,bytes) external",
    ];
    const arbContract = new ethers.Contract(atomicArbAddr, FLASH_ARB_ABI, arbWallet);

    let arbTxHash = "";
    try {
      const arbNonce = await l1Provider.getTransactionCount(ARB);
      const arbTx = await arbContract.executeFlashArb(
        flashLenderAddr,  // flashLender
        routerL1Addr,     // l1Router
        cowL1Addr,        // cowToken
        wethL1Addr,       // wethToken
        l1BridgeAddr,     // l1Bridge
        borrowAmount,     // borrowAmount (WETH)
        l2ProxyAddr,      // l2Proxy (CrossChainProxy for TradeHelper)
        arbCalldata,      // l2CallData
        { gasLimit: 5_000_000, nonce: arbNonce },
      );
      arbTxHash = arbTx.hash;
      log(`  Flash arb tx sent: ${arbTxHash}`);

      await l1Provider.send("evm_mine", []);
      log(`  Block mined!`);
    } finally {
      await l1Provider.send("evm_setAutomine", [true]);
      log(`  Automine re-enabled`);
    }

    // Check receipts
    const postBatchReceipt = await l1Provider.getTransactionReceipt(prepSwap.postBatchTxHash);
    const arbReceipt = await l1Provider.getTransactionReceipt(arbTxHash);
    log(`\n  Block ${postBatchReceipt?.blockNumber}:`);
    log(`    Tx 0 (postBatch): ${postBatchReceipt?.status === 1 ? "SUCCESS" : "REVERTED"} gas=${postBatchReceipt?.gasUsed}`);
    log(`    Tx 1 (flash arb): ${arbReceipt?.status === 1 ? "SUCCESS" : "REVERTED"} gas=${arbReceipt?.gasUsed}`);

    if (arbReceipt?.status !== 1) {
      log(`  ✗ STEP D FAILED: flash arb tx reverted`);
      return;
    }

    // Wait for L2 sync
    await new Promise(r => setTimeout(r, 10000));
    const finalState = await waitForSync(30000);
    log(`  L2 sync: reth=${finalState.rethBlock} ethrex=${finalState.ethrexBlock} match=${finalState.rethState === finalState.ethrexState}`);

    // Check balances
    const arbWethAfter = await wethContract.balanceOf(ARB);
    const profit = arbWethAfter - arbWethBefore;

    log(`\n  ======================================================`);
    log(`  FLASH LOAN CROSS-CHAIN ARBITRAGE RESULT`);
    log(`  ======================================================`);
    log(`  Flash borrowed: ${ethers.formatEther(borrowAmount)} WETH`);
    log(`  L1: Swapped → ${ethers.formatEther(expectedCow)} COW (cheap on L1)`);
    log(`  Bridged COW to L2 → minted wCOW → swapped for wETH`);
    log(`  Bridged wETH back to L1 → released from bridge`);
    log(`  Repaid flash loan`);
    log(`  PROFIT: ${ethers.formatEther(profit)} WETH`);
    log(`  ======================================================`);

    if (profit > 0n) {
      log(`  ✓ STEP D PASSED: Profitable flash arb!`);
    } else {
      log(`  ✗ STEP D: No profit (but tx succeeded)`);
    }
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Script failed:", err);
  const l1Provider = new ethers.JsonRpcProvider(L1_RPC);
  l1Provider.send("evm_setAutomine", [true]).catch(() => {});
  process.exit(1);
});
