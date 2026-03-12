#!/usr/bin/env npx tsx
/**
 * Atomic Cross-Chain Arbitrage Demo
 *
 * Demonstrates a SINGLE L1 block containing transactions that atomically:
 *   1. Swap COW -> WETH on L1 Uniswap (selling overpriced COW)
 *   2. Trigger an L2 state transition via CrossChainProxy (buying cheap wCOW
 *      with wETH on L2 Uniswap)
 *
 * Both swaps succeed or revert together -- true atomic cross-chain arbitrage.
 *
 * Architecture:
 *   - The builder pre-simulates the L2 swap and creates execution entries
 *   - postBatch loads the execution entries on L1
 *   - The user calls a CrossChainProxy on L1 which triggers executeCrossChainCall
 *   - executeCrossChainCall finds the matching execution entry and applies the
 *     pre-computed L2 state delta
 *   - In the same L1 block, the user also swaps on L1 Uniswap
 *   - If either side fails, neither state change is applied
 *
 * Setup flow:
 *   Phase 1-3: Deploy tokens + Uniswap on L1 and L2
 *   Phase 4: Move L2 pool price to create arb opportunity
 *   Phase 5-7: Deploy arb contracts, set up L2 source proxy with wETH
 *   Phase 8: Use builder to pre-compute L2 swap execution entry
 *   Phase 9: Execute both swaps atomically in one L1 block
 *   Phase 10: Report results
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

// Account1 (Anvil #0) is reserved for the builder/operator - DO NOT use for script txs
// Use Account2 (Anvil #1) as admin/deployer and Account3 (Anvil #2) as arbitrageur
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

// Operator: derived via solidityPackedKeccak256(["string","address","uint256","uint256"],
//   ["sync-rollups-operator", rollupsAddress, rollupId, chainId])
// Builder's L1→L2 calls execute from operator on L2, not from source proxy.
const OPERATOR_KEY = ethers.solidityPackedKeccak256(
  ["string", "address", "uint256", "uint256"],
  ["sync-rollups-operator", ROLLUPS_ADDRESS, ROLLUP_ID, L2_CHAIN_ID]
);
const OPERATOR = new Wallet(OPERATOR_KEY).address;

// ============ ABIs ============
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function transferFrom(address from, address to, uint256 amount) returns (bool)",
];

const ROUTER_ABI = [
  "function factory() view returns (address)",
  "function WETH() view returns (address)",
  "function addLiquidity(address tokenA, address tokenB, uint amountADesired, uint amountBDesired, uint amountAMin, uint amountBMin, address to, uint deadline) returns (uint amountA, uint amountB, uint liquidity)",
  "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline) returns (uint[] amounts)",
  "function getAmountsOut(uint amountIn, address[] path) view returns (uint[] amounts)",
];

const ROLLUPS_ABI = [
  "function rollups(uint256) view returns (address owner, bytes32 verificationKey, bytes32 stateRoot, uint256 etherBalance)",
  "function postBatch((tuple(uint256 rollupId, bytes32 currentState, bytes32 newState, int256 etherDelta)[] stateDeltas, bytes32 actionHash, tuple(uint8 actionType, uint256 rollupId, address destination, uint256 value, bytes data, bool failed, address sourceAddress, uint256 sourceRollup, uint256[] scope) nextAction)[] entries, uint256 blobCount, bytes callData, bytes proof)",
  "function computeCrossChainProxyAddress(address originalAddress, uint256 originalRollupId, uint256 domain) view returns (address)",
  "function createCrossChainProxy(address originalAddress, uint256 originalRollupId) returns (address)",
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

/** Deploy a contract on L1 */
async function deployOnL1(
  signer: ethers.Signer,
  abi: any[],
  bytecode: string,
  args: any[] = [],
): Promise<ethers.Contract> {
  const factory = new ethers.ContractFactory(abi, bytecode, signer);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  const addr = await contract.getAddress();
  return new ethers.Contract(addr, abi, signer);
}

/** Deploy a contract on L2 via proxy -> builder */
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
  await new Promise(r => setTimeout(r, 8000));
  await waitForBuilderSync(30000);
  await waitForSync(20000);
  const rethProvider = new ethers.JsonRpcProvider(RETH_EVM);
  const receipt = await rethProvider.getTransactionReceipt(tx.hash);
  if (!receipt || !receipt.contractAddress) {
    throw new Error(`L2 deploy failed: ${tx.hash}`);
  }
  return receipt.contractAddress;
}

/** Send L2 transaction via proxy */
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

// ============ Main Script ============
async function main() {
  const l1Provider = new ethers.JsonRpcProvider(L1_RPC);
  const adminWallet = new NonceManager(new Wallet(ADMIN_KEY, l1Provider));
  const arbWallet = new NonceManager(new Wallet(ARB_KEY, l1Provider));
  const rollupsContract = new ethers.Contract(ROLLUPS_ADDRESS, ROLLUPS_ABI, adminWallet);
  const rethProvider = new ethers.JsonRpcProvider(RETH_EVM);

  console.log("\n=== Atomic Cross-Chain Arbitrage Demo ===\n");
  log(`Rollups contract: ${ROLLUPS_ADDRESS}`);
  log(`Account #1 (admin/liquidity): ${ADMIN}`);
  log(`Account #2 (arbitrageur): ${ARB}`);

  // Load compiled artifacts
  const projectRoot = path.resolve(new URL(".", import.meta.url).pathname, "../..");
  const loadArtifact = (name: string, subdir: string) =>
    JSON.parse(fs.readFileSync(path.join(projectRoot, "out", subdir, name + ".json"), "utf8"));

  const simpleTokenArt = loadArtifact("SimpleToken", "SimpleToken.sol");
  const weth9Art = loadArtifact("WETH9", "WETH9.sol");
  const flashLenderArt = loadArtifact("FlashLender", "FlashLender.sol");
  const atomicArbArt = loadArtifact("AtomicArbL1", "AtomicArbL1.sol");

  const uniFactoryArt = JSON.parse(fs.readFileSync(
    path.join(projectRoot, "node_modules/@uniswap/v2-core/build/UniswapV2Factory.json"), "utf8"
  ));
  if (!uniFactoryArt.bytecode.startsWith("0x")) uniFactoryArt.bytecode = "0x" + uniFactoryArt.bytecode;
  const uniRouterArt = JSON.parse(fs.readFileSync(
    path.join(projectRoot, "node_modules/@uniswap/v2-periphery/build/UniswapV2Router02.json"), "utf8"
  ));
  if (!uniRouterArt.bytecode.startsWith("0x")) uniRouterArt.bytecode = "0x" + uniRouterArt.bytecode;

  const erc20Iface = new ethers.Interface(ERC20_ABI);
  const routerIface = new ethers.Interface(ROUTER_ABI);
  const encodeTokenArgs = (name: string, symbol: string, supply: bigint) => {
    const encodedArgs = AbiCoder.defaultAbiCoder().encode(
      ["string", "string", "uint256"], [name, symbol, supply]);
    return simpleTokenArt.bytecode.object + encodedArgs.slice(2);
  };

  const TOKEN_SUPPLY = ethers.parseEther("100000");
  const POOL_AMOUNT = ethers.parseEther("10000");
  const deadline = Math.floor(Date.now() / 1000) + 36000;

  // ────────────────────────────────────────────────
  // Phase 0: Bridge ETH from L1 to L2 for ADMIN
  // ────────────────────────────────────────────────
  log("\n-- Phase 0: Bridge ETH to L2 for ADMIN --");

  async function bridgeEthToL2(sourceAddress: string, wallet: ethers.Signer, amount: string) {
    const prepResp = await fetch(`${BUILDER_URL}/prepare-l1-call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        l2Target: sourceAddress,
        value: ethers.parseEther(amount).toString(),
        data: "0x",
        sourceAddress,
      }),
    }).then(r => r.json()) as any;
    if (!prepResp.success) throw new Error(`Bridge prep failed: ${prepResp.error}`);
    const bridgeTx = await wallet.sendTransaction({
      to: prepResp.proxyAddress,
      data: "0x",
      value: ethers.parseEther(amount),
    });
    await bridgeTx.wait();
    log(`  Bridged ${amount} ETH to ${shortAddr(sourceAddress)} on L2 via proxy ${shortAddr(prepResp.proxyAddress)}`);
    await new Promise(r => setTimeout(r, 8000));
    await waitForBuilderSync(30000);
    await waitForSync(20000);
  }

  await bridgeEthToL2(ADMIN, adminWallet, "50");

  // ────────────────────────────────────────────────
  // Phase 1: Deploy tokens on L1
  // ────────────────────────────────────────────────
  log("\n-- Phase 1: Deploy tokens on L1 --");

  const cowL1 = await deployOnL1(adminWallet, simpleTokenArt.abi, simpleTokenArt.bytecode.object,
    ["CoW Protocol Token", "COW", TOKEN_SUPPLY]);
  const cowL1Addr = await cowL1.getAddress();
  log(`  COW (L1): ${cowL1Addr}`);

  const wethL1 = await deployOnL1(adminWallet, weth9Art.abi, weth9Art.bytecode.object);
  const wethL1Addr = await wethL1.getAddress();
  log(`  WETH (L1): ${wethL1Addr}`);

  // Wrap some ETH into WETH
  const wethIface = new ethers.Interface(["function deposit() payable"]);
  const wrapTx = await adminWallet.sendTransaction({
    to: wethL1Addr, data: wethIface.encodeFunctionData("deposit"),
    value: ethers.parseEther("5000"),
  });
  await wrapTx.wait();
  log(`  Wrapped 5000 ETH -> WETH`);

  // ────────────────────────────────────────────────
  // Phase 2: Deploy Uniswap V2 on L1 + create pool
  // ────────────────────────────────────────────────
  log("\n-- Phase 2: Deploy Uniswap V2 on L1 --");

  const factoryL1 = await deployOnL1(adminWallet, uniFactoryArt.abi, uniFactoryArt.bytecode, [ADMIN]);
  const factoryL1Addr = await factoryL1.getAddress();
  log(`  Factory (L1): ${factoryL1Addr}`);

  const routerL1 = await deployOnL1(adminWallet, uniRouterArt.abi, uniRouterArt.bytecode, [factoryL1Addr, wethL1Addr]);
  const routerL1Addr = await routerL1.getAddress();
  log(`  Router (L1): ${routerL1Addr}`);

  // Create L1 COW/WETH pool: 10000 COW / 2400 WETH  =>  1 COW ~ 0.24 WETH
  await cowL1.approve(routerL1Addr, ethers.MaxUint256);
  const wethContract = new ethers.Contract(wethL1Addr, ERC20_ABI, adminWallet);
  await wethContract.approve(routerL1Addr, ethers.MaxUint256);
  const routerL1Contract = new ethers.Contract(routerL1Addr, ROUTER_ABI, adminWallet);
  await routerL1Contract.addLiquidity(
    cowL1Addr, wethL1Addr,
    POOL_AMOUNT, ethers.parseEther("2400"),
    0, 0, ADMIN, deadline,
  );
  log(`  L1 pool: 10000 COW / 2400 WETH (1 COW ~ 0.24 WETH)`);

  const l1Preview = await routerL1Contract.getAmountsOut(ethers.parseEther("100"), [cowL1Addr, wethL1Addr]);
  log(`  L1 preview: 100 COW -> ${ethers.formatEther(l1Preview[1])} WETH`);

  // ────────────────────────────────────────────────
  // Phase 3: Deploy tokens + Uniswap on L2
  // ────────────────────────────────────────────────
  log("\n-- Phase 3: Deploy tokens + Uniswap on L2 --");

  const wCowAddr = await deployOnL2(encodeTokenArgs("Wrapped CoW", "wCOW", TOKEN_SUPPLY), ADMIN_KEY);
  log(`  wCOW (L2): ${wCowAddr}`);

  const wEthL2Addr = await deployOnL2(encodeTokenArgs("Wrapped Ether", "wETH", TOKEN_SUPPLY), ADMIN_KEY);
  log(`  wETH (L2): ${wEthL2Addr}`);

  const factoryConstructorArgs = AbiCoder.defaultAbiCoder().encode(["address"], [ADMIN]);
  const factoryL2Addr = await deployOnL2(uniFactoryArt.bytecode + factoryConstructorArgs.slice(2), ADMIN_KEY, 8_000_000);
  log(`  Factory (L2): ${factoryL2Addr}`);

  const routerConstructorArgs = AbiCoder.defaultAbiCoder().encode(["address", "address"], [factoryL2Addr, wEthL2Addr]);
  const routerL2Addr = await deployOnL2(uniRouterArt.bytecode + routerConstructorArgs.slice(2), ADMIN_KEY, 8_000_000);
  log(`  Router (L2): ${routerL2Addr}`);

  // Approve tokens for L2 router
  log(`  Approving tokens for L2 router...`);
  await l2TxViaProxy(ADMIN_KEY, wCowAddr, erc20Iface.encodeFunctionData("approve", [routerL2Addr, ethers.MaxUint256]));
  await new Promise(r => setTimeout(r, 8000));
  await waitForSync(20000);

  await l2TxViaProxy(ADMIN_KEY, wEthL2Addr, erc20Iface.encodeFunctionData("approve", [routerL2Addr, ethers.MaxUint256]));
  await new Promise(r => setTimeout(r, 8000));
  await waitForSync(20000);

  // Create L2 pool: same initial price 10000 wCOW / 2400 wETH
  log(`  Creating L2 pool...`);
  await l2TxViaProxy(ADMIN_KEY, routerL2Addr,
    routerIface.encodeFunctionData("addLiquidity", [
      wCowAddr, wEthL2Addr,
      POOL_AMOUNT, ethers.parseEther("2400"),
      0, 0, ADMIN, deadline,
    ]), 0n, 5_000_000);
  await new Promise(r => setTimeout(r, 8000));
  await waitForSync(20000);
  log(`  L2 pool created: 10000 wCOW / 2400 wETH`);

  // ────────────────────────────────────────────────
  // Phase 4: Move L2 pool price to create arb opportunity
  // ────────────────────────────────────────────────
  log("\n-- Phase 4: Move L2 pool price (simulate market imbalance) --");

  // A trader sells 600 wETH for wCOW on L2, pushing wCOW price DOWN vs wETH.
  // After: wCOW is cheaper on L2 than COW on L1.
  // Arb: sell COW on L1 (expensive), buy wCOW on L2 (cheap).
  const tradeAmount = ethers.parseEther("600");
  await l2TxViaProxy(ADMIN_KEY, wEthL2Addr,
    erc20Iface.encodeFunctionData("approve", [routerL2Addr, ethers.MaxUint256]));
  await new Promise(r => setTimeout(r, 8000));
  await waitForSync(20000);

  await l2TxViaProxy(ADMIN_KEY, routerL2Addr,
    routerIface.encodeFunctionData("swapExactTokensForTokens", [
      tradeAmount, 0, [wEthL2Addr, wCowAddr], ADMIN, deadline,
    ]), 0n, 1_000_000);
  await new Promise(r => setTimeout(r, 8000));
  await waitForSync(20000);

  // Show price difference
  const l2PreviewAfter = await rethProvider.call({
    to: routerL2Addr,
    data: routerIface.encodeFunctionData("getAmountsOut", [ethers.parseEther("100"), [wCowAddr, wEthL2Addr]]),
  });
  const l2AmountsAfter = AbiCoder.defaultAbiCoder().decode(["uint256[]"], l2PreviewAfter)[0];
  log(`  L2 after imbalance: 100 wCOW -> ${ethers.formatEther(l2AmountsAfter[1])} wETH`);
  log(`  L1 rate (unchanged): 100 COW -> ${ethers.formatEther(l1Preview[1])} WETH`);
  log(`  COW is cheaper on L2 -> arb opportunity!`);

  // ────────────────────────────────────────────────
  // Phase 5: Deploy FlashLender on L1 (for future use)
  // ────────────────────────────────────────────────
  log("\n-- Phase 5: Deploy L1 contracts --");

  const flashLender = await deployOnL1(adminWallet, flashLenderArt.abi, flashLenderArt.bytecode.object);
  const flashLenderAddr = await flashLender.getAddress();
  log(`  FlashLender (L1): ${flashLenderAddr}`);

  const atomicArb = await deployOnL1(arbWallet, atomicArbArt.abi, atomicArbArt.bytecode.object);
  const atomicArbAddr = await atomicArb.getAddress();
  log(`  AtomicArbL1 (L1): ${atomicArbAddr}`);

  // ────────────────────────────────────────────────
  // Phase 6: Set up account2's L2 source proxy
  // ────────────────────────────────────────────────
  log("\n-- Phase 6: Set up L2 source proxy for cross-chain calls --");

  // Set up wETH.approve(router) on L2 for atomicArbAddr's source proxy.
  // L1→L2 calls on L2 execute from a source proxy derived from (sourceAddress, sourceRollupId).
  // The swap in Phase 9 uses sourceAddress=atomicArbAddr (because executeArbDirect calls
  // the proxy, so msg.sender = atomicArbAddr). The approve must also come from atomicArbAddr
  // so it lands on the same source proxy on L2.
  const approveRouterCalldata = erc20Iface.encodeFunctionData("approve", [routerL2Addr, ethers.MaxUint256]);

  const prepApproveRouter = await fetch(`${BUILDER_URL}/prepare-l1-call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      l2Target: wEthL2Addr,
      value: "0",
      data: approveRouterCalldata,
      sourceAddress: atomicArbAddr,
    }),
  }).then(r => r.json()) as any;

  if (!prepApproveRouter.success) throw new Error(`Prepare approve router failed: ${prepApproveRouter.error}`);
  const arbSourceProxy = prepApproveRouter.sourceProxyAddress;
  const wethTargetProxy = prepApproveRouter.proxyAddress;
  log(`  ARB source proxy (L2): ${arbSourceProxy}`);
  log(`  wETH target proxy (L1): ${wethTargetProxy}`);

  // Call the proxy FROM atomicArbAddr (contract) using callProxy() helper.
  // This ensures msg.sender = atomicArbAddr on L1, creating the correct source proxy on L2.
  const callProxyAbi = ["function callProxy(address proxy, bytes calldata data) external"];
  const atomicArbForApprove = new ethers.Contract(atomicArbAddr, callProxyAbi, arbWallet);
  const approveTx = await atomicArbForApprove.callProxy(wethTargetProxy, approveRouterCalldata);
  await approveTx.wait();
  log(`  wETH.approve(router) executed via L1->L2 cross-chain call (from atomicArbAddr)`);

  await new Promise(r => setTimeout(r, 8000));
  await waitForBuilderSync(30000);
  await waitForSync(30000);

  // ────────────────────────────────────────────────
  // Phase 7: Fund atomicArbAddr's L2 source proxy with wETH
  // ────────────────────────────────────────────────
  // L1→L2 cross-chain calls on L2 execute from a source proxy (not the operator).
  // The swap's msg.sender on L2 = proxy(atomicArbAddr, 0) = arbSourceProxy.
  // The Uniswap router does transferFrom(msg.sender, ...), so the source proxy needs wETH.
  log("\n-- Phase 7: Fund L2 source proxy with wETH --");
  log(`  Source proxy (L2): ${arbSourceProxy}`);

  const proxyFundAmount = ethers.parseEther("200");
  await l2TxViaProxy(ADMIN_KEY, wEthL2Addr,
    erc20Iface.encodeFunctionData("transfer", [arbSourceProxy, proxyFundAmount]));
  await new Promise(r => setTimeout(r, 8000));
  await waitForSync(20000);
  log(`  Transferred ${ethers.formatEther(proxyFundAmount)} wETH to source proxy on L2`);

  // ────────────────────────────────────────────────
  // Phase 8: Prepare for atomic execution
  // ────────────────────────────────────────────────
  log("\n-- Phase 8: Prepare for atomic execution --");

  // Fund ARB with COW for L1 swap and approve AtomicArbL1
  const l1SwapAmount = ethers.parseEther("500");
  await cowL1.transfer(ARB, l1SwapAmount);
  const cowL1Arb = new ethers.Contract(cowL1Addr, ERC20_ABI, arbWallet);
  await cowL1Arb.approve(atomicArbAddr, ethers.MaxUint256);
  log(`  Funded ARB with ${ethers.formatEther(l1SwapAmount)} COW, approved AtomicArbL1`);

  // The L2 swap: source proxy swaps wETH -> wCOW on L2 Uniswap router
  // (L1→L2 calls on L2 execute from source proxy; output goes to source proxy)
  const arbSwapAmount = ethers.parseEther("100");
  const swapCalldata = routerIface.encodeFunctionData("swapExactTokensForTokens", [
    arbSwapAmount, 0, [wEthL2Addr, wCowAddr], arbSourceProxy, deadline,
  ]);

  // Capture balances before
  const cowBalBefore = await cowL1.balanceOf(ARB);
  const wethBalBefore = await wethContract.balanceOf(ARB);
  log(`  ARB L1 before: ${ethers.formatEther(cowBalBefore)} COW, ${ethers.formatEther(wethBalBefore)} WETH`);

  const wethL2Before = BigInt(await rethProvider.call({
    to: wEthL2Addr, data: erc20Iface.encodeFunctionData("balanceOf", [arbSourceProxy]),
  }));
  const wcowL2Before = BigInt(await rethProvider.call({
    to: wCowAddr, data: erc20Iface.encodeFunctionData("balanceOf", [arbSourceProxy]),
  }));
  log(`  Source proxy L2 before: ${ethers.formatEther(wethL2Before)} wETH, ${ethers.formatEther(wcowL2Before)} wCOW`);

  // ────────────────────────────────────────────────
  // Phase 9: ATOMIC CROSS-CHAIN ARBITRAGE
  // ────────────────────────────────────────────────
  log("\n-- Phase 9: ATOMIC CROSS-CHAIN ARBITRAGE --");

  // Use deferMine: builder simulates L2 swap, sends postBatch to mempool, but does NOT mine.
  // Automine is left OFF so we can add our arb tx to the same block.
  //
  // IMPORTANT: sourceAddress must be atomicArbAddr (the L1 contract that will actually
  // call the proxy). CrossChainProxy.fallback() passes msg.sender as sourceAddress to
  // executeCrossChainCall, and the action hash must match the pre-computed entry.
  log("  Requesting deferred postBatch from builder...");
  const prepSwap = await fetch(`${BUILDER_URL}/prepare-l1-call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      l2Target: routerL2Addr,
      value: "0",
      data: swapCalldata,
      sourceAddress: atomicArbAddr,
      deferMine: true,
    }),
  }).then(r => r.json()) as any;

  if (!prepSwap.success) throw new Error(`Prepare swap failed: ${prepSwap.error}`);
  const routerTargetProxy = prepSwap.proxyAddress;
  log(`  Router target proxy (L1): ${routerTargetProxy}`);
  log(`  postBatch tx in mempool: ${prepSwap.postBatchTxHash}`);
  log(`  L2 swap pre-computed: ${ethers.formatEther(arbSwapAmount)} wETH -> wCOW`);

  // Now automine is OFF and postBatch is in the mempool.
  // Send the arb tx (via AtomicArbL1) to the same mempool, then mine ONE block.
  // The single block will contain: [postBatch, executeArbDirect]
  //
  // AtomicArbL1.executeArbDirect does in ONE transaction:
  //   1. Pull COW from ARB
  //   2. Swap COW -> WETH on L1 Uniswap
  //   3. Call CrossChainProxy (triggers executeCrossChainCall → consumes execution entry)
  //   4. Sweep outputs to ARB
  //
  // If the L2 proxy call fails or the L1 swap fails, the ENTIRE tx reverts.

  const ATOMIC_ARB_ABI = [
    "function executeArbDirect(address l1Router, address cowToken, address wethToken, uint256 amountIn, uint256 l1MinOut, address l2Proxy, bytes calldata l2CallData) external",
  ];
  const atomicArbContract = new ethers.Contract(atomicArbAddr, ATOMIC_ARB_ABI, arbWallet);

  let arbTxHash = "";
  try {
    const arbNonce = await l1Provider.getTransactionCount(ARB);
    const arbTx = await atomicArbContract.executeArbDirect(
      routerL1Addr,    // l1Router
      cowL1Addr,       // cowToken
      wethL1Addr,      // wethToken
      l1SwapAmount,    // amountIn (COW to sell)
      0,               // l1MinOut (no minimum for demo)
      routerTargetProxy, // l2Proxy (CrossChainProxy on L1)
      swapCalldata,    // l2CallData (swap wETH->wCOW on L2)
      { gasLimit: 3_000_000, nonce: arbNonce },
    );
    arbTxHash = arbTx.hash;
    log(`  Arb tx sent: ${arbTx.hash}`);

    // Mine: postBatch + arb execute in ONE L1 block
    await l1Provider.send("evm_mine", []);
    log("  Block mined! postBatch + atomic arb in same L1 block.");

  } finally {
    await l1Provider.send("evm_setAutomine", [true]);
    log("  Automine re-enabled");
  }

  // Check receipts
  const postBatchReceipt = await l1Provider.getTransactionReceipt(prepSwap.postBatchTxHash);
  const arbReceipt = await l1Provider.getTransactionReceipt(arbTxHash);

  const blockNumber = postBatchReceipt?.blockNumber;
  log(`\n  All txs in L1 block: ${blockNumber}`);
  log(`  Tx 0 (postBatch):   status=${postBatchReceipt?.status === 1 ? "SUCCESS" : "REVERTED"} gas=${postBatchReceipt?.gasUsed}`);
  log(`  Tx 1 (atomic arb):  status=${arbReceipt?.status === 1 ? "SUCCESS" : "REVERTED"} gas=${arbReceipt?.gasUsed}`);

  if (postBatchReceipt?.blockNumber !== arbReceipt?.blockNumber) {
    log(`  WARNING: txs are in DIFFERENT blocks! postBatch=${postBatchReceipt?.blockNumber} arb=${arbReceipt?.blockNumber}`);
  }

  // ────────────────────────────────────────────────
  // Phase 10: Results
  // ────────────────────────────────────────────────
  log("\n-- Phase 10: Results --");

  log("  Waiting for L2 nodes to sync...");
  await new Promise(r => setTimeout(r, 10000));
  const finalState = await waitForSync(30000);
  log(`  L2 reth:   block=${finalState.rethBlock} state=${finalState.rethState.slice(0, 18)}...`);
  log(`  L2 ethrex: block=${finalState.ethrexBlock} state=${finalState.ethrexState.slice(0, 18)}...`);
  if (finalState.rethState === finalState.ethrexState) {
    log(`  L2 nodes are IN SYNC`);
  } else {
    log(`  WARNING: L2 nodes are OUT OF SYNC!`);
  }

  // L1 balances after
  const cowBalAfter = await cowL1.balanceOf(ARB);
  const wethBalAfter = await wethContract.balanceOf(ARB);
  log(`\n  ARB L1 after: ${ethers.formatEther(cowBalAfter)} COW, ${ethers.formatEther(wethBalAfter)} WETH`);

  // L2 balances after (source proxy)
  const wethL2After = BigInt(await rethProvider.call({
    to: wEthL2Addr, data: erc20Iface.encodeFunctionData("balanceOf", [arbSourceProxy]),
  }));
  const wcowL2After = BigInt(await rethProvider.call({
    to: wCowAddr, data: erc20Iface.encodeFunctionData("balanceOf", [arbSourceProxy]),
  }));
  log(`  Source proxy L2 after: ${ethers.formatEther(wethL2After)} wETH, ${ethers.formatEther(wcowL2After)} wCOW`);

  // Calculate P&L (cowBalBefore already includes l1SwapAmount from the transfer)
  const cowSpentL1 = cowBalBefore - cowBalAfter;
  const wethGainedL1 = wethBalAfter - wethBalBefore;
  const wethSpentL2 = wethL2Before - wethL2After;
  const wcowGainedL2 = wcowL2After - wcowL2Before;

  log(`\n  ======================================================`);
  log(`  ATOMIC CROSS-CHAIN ARBITRAGE RESULT`);
  log(`  ======================================================`);
  log(`  L1 Block ${blockNumber} contains:`);
  log(`    Tx 0: postBatch — commits L2 state delta to rollup`);
  log(`    Tx 1: AtomicArbL1.executeArbDirect — in a single tx:`);
  log(`           - Swaps ${ethers.formatEther(l1SwapAmount)} COW -> WETH on L1 Uniswap`);
  log(`           - Calls CrossChainProxy -> triggers L2 state transition`);
  log(`  ------------------------------------------------------`);
  log(`  L1: Sold ${ethers.formatEther(cowSpentL1)} COW -> Got ${ethers.formatEther(wethGainedL1)} WETH`);
  log(`  L2: Spent ${ethers.formatEther(wethSpentL2)} wETH -> Got ${ethers.formatEther(wcowGainedL2)} wCOW`);
  log(`  ------------------------------------------------------`);
  log(`  Net position change:`);
  log(`    COW/wCOW: -${ethers.formatEther(cowSpentL1)} (L1) +${ethers.formatEther(wcowGainedL2)} (L2) = ${ethers.formatEther(wcowGainedL2 - cowSpentL1)} net`);
  log(`    WETH/wETH: +${ethers.formatEther(wethGainedL1)} (L1) -${ethers.formatEther(wethSpentL2)} (L2) = ${ethers.formatEther(wethGainedL1 - wethSpentL2)} net`);
  log(`  ======================================================`);
  log(`  L1 swap + L2 state transition in SAME L1 BLOCK.`);
  log(`  The arb tx (L1 swap + L2 proxy call) is a SINGLE`);
  log(`  transaction — if either side fails, BOTH revert.`);
  log(`  ======================================================\n`);

  // Contract address summary
  console.log("=== Contract Addresses ===");
  console.log(`L1 COW:            ${cowL1Addr}`);
  console.log(`L1 WETH:           ${wethL1Addr}`);
  console.log(`L1 Factory:        ${factoryL1Addr}`);
  console.log(`L1 Router:         ${routerL1Addr}`);
  console.log(`L1 FlashLender:    ${flashLenderAddr}`);
  console.log(`L1 AtomicArbL1:    ${atomicArbAddr}`);
  console.log(`L1 Router Proxy:   ${routerTargetProxy}`);
  console.log(`L2 wCOW:           ${wCowAddr}`);
  console.log(`L2 wETH:           ${wEthL2Addr}`);
  console.log(`L2 Factory:        ${factoryL2Addr}`);
  console.log(`L2 Router:         ${routerL2Addr}`);
  console.log(`L2 Source Proxy:   ${arbSourceProxy}`);
  console.log(`L2 Operator:       ${OPERATOR}`);
  console.log("");
}

main().catch((err) => {
  console.error("Script failed:", err);
  const l1Provider = new ethers.JsonRpcProvider(L1_RPC);
  l1Provider.send("evm_setAutomine", [true]).catch(() => {});
  process.exit(1);
});
