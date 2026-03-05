/**
 * End-to-end test for L1→L2 calls via sync-rollups
 * Tests the /prepare-l1-call endpoint
 */

import { Wallet, parseEther, JsonRpcProvider, Contract } from "ethers";

const BUILDER_URL = "http://localhost:3200";
const L1_RPC = "http://localhost:8545";

// Test private keys (Anvil defaults)
const L1_SENDER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // Anvil #1
const L2_TARGET = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"; // Anvil #2 - target EOA on L2

async function main() {
  console.log("=== L1→L2 Call E2E Test ===\n");

  const l1Provider = new JsonRpcProvider(L1_RPC);
  const l1Wallet = new Wallet(L1_SENDER_KEY, l1Provider);

  console.log(`L1 Sender: ${l1Wallet.address}`);
  console.log(`L2 Target: ${L2_TARGET}`);

  // 1. Check builder status
  console.log("\n1. Checking builder status...");
  const statusRes = await fetch(`${BUILDER_URL}/status`);
  const status = await statusRes.json();
  console.log("   Builder status:", JSON.stringify(status, null, 2));

  if (!status.isSynced) {
    throw new Error("Builder is not synced!");
  }

  // 2. Prepare L1→L2 call
  console.log("\n2. Preparing L1→L2 call (sending 0.1 ETH to L2 target)...");
  const prepareRes = await fetch(`${BUILDER_URL}/prepare-l1-call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      l2Target: L2_TARGET,
      value: parseEther("0.1").toString(16).padStart(2, "0x"),
      data: "0x",
      sourceAddress: l1Wallet.address,
    }),
  });

  const prepareResult = await prepareRes.json();
  console.log("   Prepare result:", JSON.stringify(prepareResult, null, 2));

  if (!prepareResult.success) {
    throw new Error(`Prepare failed: ${prepareResult.error}`);
  }

  const proxyAddress = prepareResult.proxyAddress;
  console.log(`   Proxy address: ${proxyAddress}`);

  // 3. Send ETH to proxy on L1
  console.log("\n3. Sending 0.1 ETH to proxy on L1...");
  const tx = await l1Wallet.sendTransaction({
    to: proxyAddress,
    value: parseEther("0.1"),
    data: "0x",
  });

  console.log(`   TX hash: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`   TX mined in block ${receipt?.blockNumber}`);

  // 4. Wait a moment for events to propagate
  console.log("\n4. Waiting for state sync...");
  await new Promise(resolve => setTimeout(resolve, 3000));

  // 5. Check final status
  console.log("\n5. Checking final status...");
  const finalStatusRes = await fetch(`${BUILDER_URL}/status`);
  const finalStatus = await finalStatusRes.json();
  console.log("   Final state:", JSON.stringify(finalStatus, null, 2));

  // 6. Check L2 target balance via fullnode
  console.log("\n6. Checking L2 target balance...");
  const balanceRes = await fetch("http://localhost:9547", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "eth_getBalance",
      params: [L2_TARGET, "latest"],
      id: 1,
    }),
  });
  const balanceData = await balanceRes.json();
  console.log(`   L2 Target balance: ${BigInt(balanceData.result)} wei`);

  console.log("\n=== Test Complete ===");
}

main().catch((error) => {
  console.error("Test failed:", error);
  process.exit(1);
});
