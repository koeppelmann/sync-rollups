#!/usr/bin/env npx tsx
/**
 * Test L2→L1 withdrawal: send an L2 TX with value to a proxy address
 * representing an L1 address.
 *
 * Flow:
 * 1. Check initial balances
 * 2. Prepare the L2→L1 proxy (deploys alias proxy on L1 for the L1 target)
 * 3. Send L2 TX with value to the proxy address
 * 4. Verify the L2 state updated and fullnodes stay in sync
 */

import { ethers } from "ethers";

const L1_RPC = "http://localhost:8545";
const BUILDER_URL = "http://localhost:3200";
const L2_RPC_PROXY = "http://localhost:9548";
const RETH_EVM = "http://localhost:9546";
const ETHREX_EVM = "http://localhost:9556";
const RETH_FULLNODE = "http://localhost:9547";
const ETHREX_STATUS = "http://localhost:3201";

const ROLLUPS_ADDR = "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512";

// Anvil account #1 (has bridged ETH on L2)
const ACCOUNT1 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ACCOUNT1_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

// Anvil account #3 (L1 recipient for the withdrawal)
const L1_RECIPIENT = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

const ROLLUPS_ABI = [
  "function rollups(uint256) view returns (address owner, bytes32 verificationKey, bytes32 stateRoot, uint256 etherBalance)",
];

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForSync(maxWait = 30000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const res = await fetch(`${BUILDER_URL}/status`);
      const status = await res.json();
      if (status.isSynced) return true;
    } catch {}
    await sleep(2000);
  }
  return false;
}

async function getEthrexSync(): Promise<boolean> {
  try {
    const res = await fetch(ETHREX_STATUS, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "syncrollups_isSynced", params: [], id: 1 }),
    });
    const data = await res.json();
    return data.result === true;
  } catch {
    return false;
  }
}

async function main() {
  console.log("=== L2→L1 Withdrawal Test ===\n");

  const l1Provider = new ethers.JsonRpcProvider(L1_RPC);
  const l2Provider = new ethers.JsonRpcProvider(RETH_EVM);
  const rollupsContract = new ethers.Contract(ROLLUPS_ADDR, ROLLUPS_ABI, l1Provider);
  const l2Wallet = new ethers.Wallet(ACCOUNT1_KEY, new ethers.JsonRpcProvider(L2_RPC_PROXY));

  // 1. Check initial state
  console.log("Step 1: Check initial balances");
  const l2Balance = await l2Provider.getBalance(ACCOUNT1);
  const l1RecipientBalance = await l1Provider.getBalance(L1_RECIPIENT);
  const rollupData = await rollupsContract.rollups(0);
  console.log(`  Account #1 L2 balance: ${ethers.formatEther(l2Balance)} ETH`);
  console.log(`  L1 recipient balance:  ${ethers.formatEther(l1RecipientBalance)} ETH`);
  console.log(`  Rollup etherBalance:   ${ethers.formatEther(rollupData.etherBalance)} ETH`);
  console.log(`  L1 state root:         ${rollupData.stateRoot.slice(0, 18)}...`);
  console.log();

  // 2. Prepare L2→L1 proxy
  console.log("Step 2: Prepare L2→L1 proxy for recipient");
  const prepareRes = await fetch(`${BUILDER_URL}/prepare-l2-call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      l1Target: L1_RECIPIENT,
      sourceAddress: ACCOUNT1,
    }),
  });
  const prepareData = await prepareRes.json();
  if (!prepareData.success) {
    console.error("  Failed to prepare L2→L1 proxy:", prepareData.error);
    process.exit(1);
  }
  console.log(`  Proxy address:  ${prepareData.proxyAddress}`);
  console.log(`  Source proxy:   ${prepareData.sourceProxyAddress || "N/A"}`);
  console.log(`  Newly deployed: ${prepareData.proxyDeployed}`);
  console.log();

  // 3. Send L2 TX with value to the proxy address
  const withdrawAmount = ethers.parseEther("0.5");
  console.log(`Step 3: Send L2 TX with ${ethers.formatEther(withdrawAmount)} ETH to proxy`);
  console.log(`  From: ${ACCOUNT1}`);
  console.log(`  To:   ${prepareData.proxyAddress}`);

  try {
    // Use 'latest' nonce explicitly — the public reth txpool may have stale
    // pending txs from previous runs, causing ethers to pick a too-high nonce.
    const nonce = await l2Provider.getTransactionCount(ACCOUNT1, "latest");
    console.log(`  Using nonce: ${nonce} (latest)`);
    const tx = await l2Wallet.sendTransaction({
      to: prepareData.proxyAddress,
      value: withdrawAmount,
      data: "0x",
      nonce,
    });
    console.log(`  TX hash: ${tx.hash}`);
    console.log("  Waiting for confirmation...");
    const receipt = await tx.wait();
    console.log(`  Confirmed in block ${receipt!.blockNumber}`);
    console.log(`  Gas used: ${receipt!.gasUsed}`);
    console.log(`  Status: ${receipt!.status === 1 ? "SUCCESS" : "FAILED"}`);
  } catch (error: any) {
    console.error(`  Transaction failed: ${error.message}`);
    // Check builder logs for details
    console.log("\n  Checking builder logs for error details...");
    process.exit(1);
  }
  console.log();

  // 4. Wait for sync and check final state
  console.log("Step 4: Wait for sync and verify");
  await sleep(15000); // Allow event processors to catch up

  const synced = await waitForSync();
  const ethrexSynced = await getEthrexSync();
  console.log(`  Builder synced: ${synced}`);
  console.log(`  Ethrex synced:  ${ethrexSynced}`);

  const l2BalanceAfter = await l2Provider.getBalance(ACCOUNT1);
  const l1RecipientBalanceAfter = await l1Provider.getBalance(L1_RECIPIENT);
  const rollupDataAfter = await rollupsContract.rollups(0);
  const proxyL2Balance = await l2Provider.getBalance(prepareData.proxyAddress);

  console.log();
  console.log("  Final balances:");
  console.log(`    Account #1 L2 balance: ${ethers.formatEther(l2BalanceAfter)} ETH (was ${ethers.formatEther(l2Balance)})`);
  console.log(`    L2 proxy balance:      ${ethers.formatEther(proxyL2Balance)} ETH`);
  console.log(`    L1 recipient balance:  ${ethers.formatEther(l1RecipientBalanceAfter)} ETH (was ${ethers.formatEther(l1RecipientBalance)})`);
  console.log(`    Rollup etherBalance:   ${ethers.formatEther(rollupDataAfter.etherBalance)} ETH (was ${ethers.formatEther(rollupData.etherBalance)})`);
  console.log(`    L1 state root:         ${rollupDataAfter.stateRoot.slice(0, 18)}...`);

  // Check state roots across implementations
  const rethBlock = await l2Provider.getBlock("latest");
  let ethrexBlock;
  try {
    const ethrexProvider = new ethers.JsonRpcProvider(ETHREX_EVM);
    ethrexBlock = await ethrexProvider.getBlock("latest");
  } catch {}

  console.log();
  console.log("  State root comparison:");
  console.log(`    reth   block ${rethBlock?.number}: stateRoot=${rethBlock?.stateRoot?.slice(0, 18)}...`);
  if (ethrexBlock) {
    console.log(`    ethrex block ${ethrexBlock.number}: stateRoot=${ethrexBlock.stateRoot?.slice(0, 18)}...`);
    if (rethBlock?.number === ethrexBlock.number && rethBlock?.stateRoot === ethrexBlock.stateRoot) {
      console.log("    ✓ State roots match!");
    } else {
      console.log("    ✗ State roots DIVERGED!");
    }
  }

  // Summary
  console.log();
  console.log("=== Summary ===");
  const l2Diff = l2Balance - l2BalanceAfter;
  const l1Diff = l1RecipientBalanceAfter - l1RecipientBalance;
  const rollupDiff = rollupData.etherBalance - rollupDataAfter.etherBalance;
  console.log(`  L2 balance decreased by: ${ethers.formatEther(l2Diff)} ETH`);
  console.log(`  L1 recipient gained:     ${ethers.formatEther(l1Diff)} ETH`);
  console.log(`  Rollup balance changed:  ${ethers.formatEther(rollupDiff)} ETH`);

  if (l1Diff > 0n) {
    console.log("\n  ✓ L2→L1 withdrawal with L1 ETH release worked!");
  } else if (proxyL2Balance > 0n) {
    console.log("\n  ~ L2 transfer to proxy worked (ETH held in proxy on L2, not released on L1)");
  } else {
    console.log("\n  ✗ Something went wrong");
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
