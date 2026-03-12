#!/usr/bin/env npx tsx
/**
 * Test script for MockBundleSubmitter.
 *
 * Starts Anvil, creates 2 signed transactions from different accounts,
 * submits them via MockBundleSubmitter, and verifies they land in the
 * same block with the correct timestamp.
 */

import { JsonRpcProvider, Wallet, parseEther } from "ethers";
import { MockBundleSubmitter } from "../builder/mock-bundle-submitter.js";

const ANVIL_PORT = 18545; // Use non-standard port to avoid conflicts
const ANVIL_URL = `http://localhost:${ANVIL_PORT}`;

// Anvil default accounts
const ACCOUNT_0_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ACCOUNT_1_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const ACCOUNT_2_ADDR = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

async function main() {
  const provider = new JsonRpcProvider(ANVIL_URL);

  // Verify Anvil is up
  const chainId = (await provider.getNetwork()).chainId;
  console.log(`Connected to Anvil (chainId=${chainId}) on port ${ANVIL_PORT}`);

  const wallet0 = new Wallet(ACCOUNT_0_KEY, provider);
  const wallet1 = new Wallet(ACCOUNT_1_KEY, provider);

  console.log(`Wallet 0: ${wallet0.address}`);
  console.log(`Wallet 1: ${wallet1.address}`);
  console.log(`Target:   ${ACCOUNT_2_ADDR}`);

  // Get starting block
  const startBlock = await provider.getBlockNumber();
  console.log(`\nStarting block: ${startBlock}`);

  // --- Test 1: Basic 2-tx bundle ---
  console.log("\n=== Test 1: Two ETH transfers in one bundle ===");

  const nonce0 = await wallet0.getNonce();
  const nonce1 = await wallet1.getNonce();

  // Sign two transactions (different senders → different nonces/keys)
  const tx0 = await wallet0.signTransaction({
    to: ACCOUNT_2_ADDR,
    value: parseEther("1.0"),
    gasLimit: 21000,
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    nonce: nonce0,
    chainId,
    type: 2,
  });

  const tx1 = await wallet1.signTransaction({
    to: ACCOUNT_2_ADDR,
    value: parseEther("2.0"),
    gasLimit: 21000,
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    nonce: nonce1,
    chainId,
    type: 2,
  });

  console.log("Signed 2 transactions");

  const submitter = new MockBundleSubmitter(provider);
  const targetBlock = startBlock + 1;
  const desiredTimestamp = Math.floor(Date.now() / 1000) + 100; // 100s in the future

  const result = await submitter.submitAndWait(
    [tx0, tx1],
    targetBlock,
    provider,
    desiredTimestamp
  );

  console.log(`\nResult: included=${result.included}, blockNumber=${result.blockNumber}`);
  console.log(`Tx hashes: ${result.txHashes.join(", ")}`);

  // Verify both txs are in the same block
  const block = await provider.getBlock(result.blockNumber, true);
  if (!block) throw new Error("Block not found");

  console.log(`\nBlock ${block.number}:`);
  console.log(`  Timestamp: ${block.timestamp} (requested: ${desiredTimestamp})`);
  console.log(`  Tx count:  ${block.transactions.length}`);
  console.log(`  Txs:       ${block.transactions.join(", ")}`);

  // Assertions
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, msg: string) {
    if (condition) {
      console.log(`  ✓ ${msg}`);
      passed++;
    } else {
      console.log(`  ✗ ${msg}`);
      failed++;
    }
  }

  console.log("\nAssertions:");
  assert(result.included === true, "Bundle was included");
  assert(block.transactions.length === 2, `Block has exactly 2 txs (got ${block.transactions.length})`);
  assert(block.timestamp === desiredTimestamp, `Timestamp matches (got ${block.timestamp}, expected ${desiredTimestamp})`);

  // Verify both tx hashes are in the block
  const blockTxSet = new Set(block.transactions.map(h => h.toLowerCase()));
  for (const h of result.txHashes) {
    assert(blockTxSet.has(h.toLowerCase()), `Tx ${h.slice(0, 10)}... is in block`);
  }

  // Verify receipts exist and are successful
  for (const h of result.txHashes) {
    const receipt = await provider.getTransactionReceipt(h);
    assert(receipt !== null, `Receipt exists for ${h.slice(0, 10)}...`);
    assert(receipt!.status === 1, `Tx ${h.slice(0, 10)}... succeeded (status=1)`);
    assert(receipt!.blockNumber === result.blockNumber, `Tx ${h.slice(0, 10)}... in correct block`);
  }

  // Verify account 2 received the ETH
  const balance2 = await provider.getBalance(ACCOUNT_2_ADDR);
  // Anvil starts with 10000 ETH per account, so it should be 10000 + 1 + 2 = 10003
  assert(balance2 === parseEther("10003.0"), `Account 2 balance is 10003 ETH (got ${balance2})`);

  // --- Test 2: Bundle with same-sender sequential nonces ---
  console.log("\n=== Test 2: Two txs from same sender (sequential nonces) ===");

  // Use raw RPC for fresh nonce (ethers caches getNonce)
  const nonce0bHex = await provider.send("eth_getTransactionCount", [wallet0.address, "latest"]);
  const nonce0b = Number(nonce0bHex);

  const tx2 = await wallet0.signTransaction({
    to: ACCOUNT_2_ADDR,
    value: parseEther("0.5"),
    gasLimit: 21000,
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    nonce: nonce0b,
    chainId,
    type: 2,
  });

  const tx3 = await wallet0.signTransaction({
    to: ACCOUNT_2_ADDR,
    value: parseEther("0.5"),
    gasLimit: 21000,
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    nonce: nonce0b + 1,
    chainId,
    type: 2,
  });

  console.log(`Signed 2 transactions from same sender (nonces: ${nonce0b}, ${nonce0b + 1})`);

  const ts2 = desiredTimestamp + 12;
  const result2 = await submitter.submitAndWait([tx2, tx3], targetBlock + 1, provider, ts2);

  console.log(`\nResult: included=${result2.included}, blockNumber=${result2.blockNumber}`);

  const block2 = await provider.getBlock(result2.blockNumber, true);
  if (!block2) throw new Error("Block not found");

  console.log("\nAssertions:");
  assert(result2.included === true, "Bundle 2 was included");
  assert(block2.transactions.length === 2, `Block has exactly 2 txs (got ${block2.transactions.length})`);
  assert(block2.timestamp === ts2, `Timestamp matches (got ${block2.timestamp}, expected ${ts2})`);

  // Automine should be back on after bundle submission
  console.log("\n=== Test 3: Automine restored after bundle ===");
  const autoTx = await wallet1.sendTransaction({
    to: ACCOUNT_2_ADDR,
    value: parseEther("0.1"),
  });
  const autoReceipt = await autoTx.wait();
  assert(autoReceipt !== null, "Automine tx confirmed (automine is restored)");
  assert(autoReceipt!.blockNumber > result2.blockNumber, `Auto-mined in later block (${autoReceipt!.blockNumber} > ${result2.blockNumber})`);

  // Summary
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
