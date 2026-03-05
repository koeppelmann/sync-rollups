/**
 * Comprehensive E2E test for sync-rollups with Counter contract
 * Tests:
 * 1. L2 contract deployment
 * 2. L2 direct calls (increment counter)
 * 3. L1→L2 calls via proxy (increment counter from L1)
 * 4. Fullnode sync verification
 */

import { Wallet, parseEther, Transaction, ContractFactory, Contract, JsonRpcProvider, Interface, getCreateAddress } from "ethers";

const BUILDER_URL = "http://localhost:3200";
const L1_RPC = "http://localhost:8545";
const L2_RPC = "http://localhost:9546";
const FULLNODE_RPC = "http://localhost:9547";
const L2_CHAIN_ID = 10200200;

// Test private keys (Anvil defaults)
const DEPLOYER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // Anvil #1
const L1_SENDER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // Anvil #0 (admin)

// Simple Counter contract bytecode and ABI
// Source:
// contract Counter {
//     uint256 public count;
//     event Incremented(address indexed caller, uint256 newValue);
//     function increment() external returns (uint256) {
//         count++;
//         emit Incremented(msg.sender, count);
//         return count;
//     }
//     function getCount() external view returns (uint256) {
//         return count;
//     }
// }
const COUNTER_ABI = [
  "function count() view returns (uint256)",
  "function increment() returns (uint256)",
  "function getCount() view returns (uint256)",
  "event Incremented(address indexed caller, uint256 newValue)"
];

// Compiled bytecode from contracts/Counter.sol (forge inspect Counter bytecode)
const COUNTER_BYTECODE = "0x608060405234801561000f575f80fd5b506101068061001d5f395ff3fe6080604052348015600e575f80fd5b5060043610603a575f3560e01c806306661abd14603e578063a87d942c146057578063d09de08a14605d575b5f80fd5b60455f5481565b60405190815260200160405180910390f35b5f546045565b60455f80548180606b8360ad565b90915550505f5460405190815233907f38ac789ed44572701765277c4d0970f2db1c1a571ed39e84358095ae4eaa54209060200160405180910390a2505f5490565b5f6001820160c957634e487b7160e01b5f52601160045260245ffd5b506001019056fea2646970667358221220e68cfb1ce8013a4729caaa6578b7dda3c1b7345e75ef88b57bfcafbe5067d5e964736f6c63430008180033";

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function checkBuilderStatus(): Promise<any> {
  const res = await fetch(`${BUILDER_URL}/status`);
  return res.json();
}

async function deployCounterOnL2(wallet: Wallet): Promise<string> {
  // Deploy using raw transaction to L2
  const provider = wallet.provider as JsonRpcProvider;

  // Get nonce
  const nonce = await provider.getTransactionCount(wallet.address);

  // Create deployment transaction
  const tx = {
    type: 2,
    chainId: L2_CHAIN_ID,
    nonce,
    to: null, // Contract creation
    value: 0n,
    maxFeePerGas: 1000000000n,
    maxPriorityFeePerGas: 1000000000n,
    gasLimit: 500000n,
    data: COUNTER_BYTECODE,
  };

  // Sign and send
  const signedTx = await wallet.signTransaction(tx);

  // Submit to builder for L2 processing
  const submitRes = await fetch(`${BUILDER_URL}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sourceChain: "L2",
      signedTx,
    }),
  });

  const result = await submitRes.json();
  if (!result.success) {
    throw new Error(`Deploy failed: ${result.error}`);
  }

  // Calculate contract address (CREATE address)
  const contractAddress = getCreateAddress({
    from: wallet.address,
    nonce,
  });

  return contractAddress;
}

async function callCounterFromL2(
  wallet: Wallet,
  counterAddress: string
): Promise<{ txHash: string; newCount: bigint }> {
  const provider = wallet.provider as JsonRpcProvider;

  // Get nonce
  const nonce = await provider.getTransactionCount(wallet.address);

  // Encode increment() call
  const iface = new Interface(COUNTER_ABI);
  const data = iface.encodeFunctionData("increment");

  // Create transaction
  const tx = {
    type: 2,
    chainId: L2_CHAIN_ID,
    nonce,
    to: counterAddress,
    value: 0n,
    maxFeePerGas: 1000000000n,
    maxPriorityFeePerGas: 1000000000n,
    gasLimit: 100000n,
    data,
  };

  // Sign
  const signedTx = await wallet.signTransaction(tx);

  // Submit to builder
  const submitRes = await fetch(`${BUILDER_URL}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sourceChain: "L2",
      signedTx,
    }),
  });

  const result = await submitRes.json();
  if (!result.success) {
    throw new Error(`L2 call failed: ${result.error}`);
  }

  // Wait for state sync
  await sleep(3000);

  // Read new count from L2 directly
  const counter = new Contract(counterAddress, COUNTER_ABI, new JsonRpcProvider(L2_RPC));
  const newCount = await counter.count();

  return { txHash: result.l1TxHash, newCount };
}

async function callCounterFromL1(
  l1Wallet: Wallet,
  counterAddress: string
): Promise<{ txHash: string; newCount: bigint }> {
  // 1. Prepare the L1→L2 call via builder
  const iface = new Interface(COUNTER_ABI);
  const data = iface.encodeFunctionData("increment");

  console.log("   Preparing L1→L2 call...");
  const prepareRes = await fetch(`${BUILDER_URL}/prepare-l1-call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      l2Target: counterAddress,
      value: "0x0", // No ETH
      data,
      sourceAddress: l1Wallet.address,
    }),
  });

  const prepareResult = await prepareRes.json();
  if (!prepareResult.success) {
    throw new Error(`Prepare failed: ${prepareResult.error}`);
  }

  const proxyAddress = prepareResult.proxyAddress;
  console.log(`   Proxy address: ${proxyAddress}`);

  // 2. Send the call to the proxy on L1
  console.log("   Sending L1 transaction to proxy...");
  const tx = await l1Wallet.sendTransaction({
    to: proxyAddress,
    data,
    value: 0n,
  });

  console.log(`   L1 TX hash: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`   L1 TX mined in block ${receipt?.blockNumber}`);

  // 3. Wait for state sync
  await sleep(3000);

  // 4. Read new count from L2 directly
  const counter = new Contract(counterAddress, COUNTER_ABI, new JsonRpcProvider(L2_RPC));
  const newCount = await counter.count();

  return { txHash: tx.hash, newCount };
}

async function getCounterValue(counterAddress: string): Promise<bigint> {
  // Read directly from L2 Anvil (the actual state)
  const counter = new Contract(counterAddress, COUNTER_ABI, new JsonRpcProvider(L2_RPC));
  return await counter.count();
}

async function getCounterValueViaFullnode(counterAddress: string): Promise<bigint> {
  // Read via fullnode RPC (which proxies to L2)
  const counter = new Contract(counterAddress, COUNTER_ABI, new JsonRpcProvider(FULLNODE_RPC));
  return await counter.count();
}

async function main() {
  console.log("=== Counter Contract E2E Test ===\n");

  // Setup providers and wallets
  const l2Provider = new JsonRpcProvider(L2_RPC);
  const l1Provider = new JsonRpcProvider(L1_RPC);
  const l2Wallet = new Wallet(DEPLOYER_KEY, l2Provider);
  const l1Wallet = new Wallet(L1_SENDER_KEY, l1Provider);

  console.log(`L2 Deployer: ${l2Wallet.address}`);
  console.log(`L1 Sender: ${l1Wallet.address}`);

  // 1. Check builder status
  console.log("\n1. Checking builder status...");
  const status = await checkBuilderStatus();
  console.log(`   Synced: ${status.isSynced}`);
  console.log(`   State root: ${status.l1StateRoot.slice(0, 18)}...`);

  if (!status.isSynced) {
    throw new Error("Builder is not synced!");
  }

  // 1b. Fund the L2 deployer account via L1→L2 deposit
  console.log("\n1b. Funding L2 deployer via L1→L2 deposit...");
  {
    // Use l1Wallet to send ETH to deployer's L2 proxy
    const prepareRes = await fetch(`${BUILDER_URL}/prepare-l1-call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        l2Target: l2Wallet.address,
        value: "0x" + parseEther("1").toString(16), // 1 ETH
        data: "0x",
        sourceAddress: l1Wallet.address,
      }),
    });
    const prepareResult = await prepareRes.json();
    if (!prepareResult.success) {
      throw new Error(`Prepare L1 call failed: ${prepareResult.error}`);
    }
    console.log(`   Proxy address: ${prepareResult.proxyAddress}`);

    // Send ETH to the proxy on L1
    const tx = await l1Wallet.sendTransaction({
      to: prepareResult.proxyAddress,
      value: parseEther("1"),
    });
    console.log(`   L1 TX: ${tx.hash}`);
    await tx.wait();
    console.log(`   L1 TX mined`);

    // Wait for L2 to sync
    await sleep(3000);

    // Verify L2 balance
    const l2Balance = await l2Provider.getBalance(l2Wallet.address);
    console.log(`   L2 deployer balance: ${l2Balance} wei (${Number(l2Balance) / 1e18} ETH)`);
  }

  // 2. Deploy Counter contract on L2
  console.log("\n2. Deploying Counter contract on L2...");
  const counterAddress = await deployCounterOnL2(l2Wallet);
  console.log(`   Counter deployed at: ${counterAddress}`);

  // Wait for deployment to sync
  await sleep(2000);

  // 3. Verify initial count
  console.log("\n3. Checking initial count...");
  let count = await getCounterValue(counterAddress);
  console.log(`   Initial count: ${count}`);

  if (count !== 0n) {
    console.warn(`   Warning: Expected initial count to be 0, got ${count}`);
  }

  // 4. Call increment from L2 (direct call)
  console.log("\n4. Calling increment() from L2...");
  const l2Result = await callCounterFromL2(l2Wallet, counterAddress);
  console.log(`   L2 TX hash: ${l2Result.txHash}`);
  console.log(`   New count after L2 call: ${l2Result.newCount}`);

  // 5. Verify count increased
  console.log("\n5. Verifying count after L2 call...");
  count = await getCounterValue(counterAddress);
  console.log(`   Count from L2: ${count}`);

  // Wait for builder to sync
  console.log("\n5b. Waiting for builder to sync...");
  await sleep(5000);
  const midStatus = await checkBuilderStatus();
  console.log(`   Builder synced: ${midStatus.isSynced}`);

  // 6. Call increment from L1 (via proxy)
  console.log("\n6. Calling increment() from L1 via proxy...");
  const l1Result = await callCounterFromL1(l1Wallet, counterAddress);
  console.log(`   L1 TX hash: ${l1Result.txHash}`);
  console.log(`   New count after L1 call: ${l1Result.newCount}`);

  // 7. Final verification
  console.log("\n7. Final verification...");
  const finalStatus = await checkBuilderStatus();
  count = await getCounterValue(counterAddress);
  console.log(`   Final count: ${count}`);
  console.log(`   Builder synced: ${finalStatus.isSynced}`);
  console.log(`   L1 state root: ${finalStatus.l1StateRoot.slice(0, 18)}...`);
  console.log(`   Fullnode state root: ${finalStatus.fullnodeStateRoot.slice(0, 18)}...`);

  // 8. Summary
  console.log("\n=== Test Summary ===");
  console.log(`Counter address: ${counterAddress}`);
  console.log(`Initial count: 0`);
  console.log(`After L2 call: ${l2Result.newCount}`);
  console.log(`After L1 call: ${l1Result.newCount}`);
  console.log(`States in sync: ${finalStatus.isSynced}`);

  if (count >= 2n && finalStatus.isSynced) {
    console.log("\n✅ All tests passed!");
  } else {
    console.log("\n❌ Some tests may have issues");
    if (count < 2n) {
      console.log(`   Expected count >= 2, got ${count}`);
    }
    if (!finalStatus.isSynced) {
      console.log("   Fullnode not in sync with L1");
    }
  }

  console.log("\n=== Test Complete ===");
}

main().catch((error) => {
  console.error("\nTest failed:", error);
  process.exit(1);
});
