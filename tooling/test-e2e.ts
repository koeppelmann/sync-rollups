/**
 * End-to-end test for sync-rollups builder
 * Tests submitting an L2 transaction through the builder
 */

import { Wallet, parseEther, Transaction } from "ethers";

const BUILDER_URL = "http://localhost:3200";
const L2_CHAIN_ID = 10200200;

// Test private key (Anvil default #1)
const TEST_PRIVATE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

async function main() {
  console.log("=== sync-rollups E2E Test ===\n");

  // Check builder status
  console.log("1. Checking builder status...");
  const statusRes = await fetch(`${BUILDER_URL}/status`);
  const status = await statusRes.json();
  console.log("   Builder status:", JSON.stringify(status, null, 2));

  if (!status.isSynced) {
    throw new Error("Builder is not synced!");
  }

  // Create test wallet
  const wallet = new Wallet(TEST_PRIVATE_KEY);
  console.log(`\n2. Test wallet: ${wallet.address}`);

  // Get the current nonce for the wallet on L2
  const nonceRes = await fetch("http://localhost:9546", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "eth_getTransactionCount",
      params: [wallet.address, "latest"],
      id: 1
    })
  });
  const nonceData = await nonceRes.json();
  const nonce = parseInt(nonceData.result, 16);

  console.log(`\n3. Creating L2 transaction (nonce: ${nonce})...`);
  const tx = Transaction.from({
    type: 2, // EIP-1559
    chainId: L2_CHAIN_ID,
    nonce: nonce,
    to: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", // Anvil #3 (different from sender)
    value: parseEther("1"),
    maxFeePerGas: 1000000000n, // 1 gwei
    maxPriorityFeePerGas: 1000000000n,
    gasLimit: 21000n,
    data: "0x",
  });

  // Sign the transaction
  const signedTx = await wallet.signTransaction(tx);
  console.log(`   Signed transaction: ${signedTx.slice(0, 50)}...`);

  // Submit to builder
  console.log("\n4. Submitting to builder...");
  const submitRes = await fetch(`${BUILDER_URL}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sourceChain: "L2",
      signedTx,
    }),
  });

  const result = await submitRes.json();
  console.log("   Result:", JSON.stringify(result, null, 2));

  // Check final status
  console.log("\n5. Checking final status...");
  const finalStatusRes = await fetch(`${BUILDER_URL}/status`);
  const finalStatus = await finalStatusRes.json();
  console.log("   Final state:", JSON.stringify(finalStatus, null, 2));

  console.log("\n=== Test Complete ===");
}

main().catch(console.error);
