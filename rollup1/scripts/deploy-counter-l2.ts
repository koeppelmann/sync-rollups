/**
 * Deploy Counter contract to L2 via the builder
 *
 * This sends a deployment transaction through the L2 RPC proxy,
 * which routes it to the builder, which wraps it in executeL2TX() on L1.
 */

import { ethers, JsonRpcProvider } from "ethers";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const L2_CHAIN_ID = 10200200;
const L2_RPC_PROXY = "http://localhost:9548";

// Anvil account #1 (has L2 funds after bridging)
const DEPLOYER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadCounterBytecode(): string {
  const artifactPath = join(__dirname, "../../out/Counter.sol/Counter.json");
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
  const bytecode = artifact?.bytecode?.object;

  if (!bytecode || typeof bytecode !== "string") {
    throw new Error(`Counter bytecode not found in artifact: ${artifactPath}`);
  }

  return bytecode.startsWith("0x") ? bytecode : `0x${bytecode}`;
}

async function main() {
  console.log("Deploying Counter contract to L2...");
  console.log(`L2 RPC Proxy: ${L2_RPC_PROXY}`);

  const l2Provider = new JsonRpcProvider(L2_RPC_PROXY);
  const wallet = new ethers.Wallet(DEPLOYER_KEY);
  console.log(`Deployer: ${wallet.address}`);

  // Get nonce from L2
  const nonce = await l2Provider.getTransactionCount(wallet.address, "latest");
  console.log(`Nonce: ${nonce}`);

  // Check balance
  const balance = await l2Provider.getBalance(wallet.address, "latest");
  console.log(`Balance: ${ethers.formatEther(balance)} ETH`);

  if (balance === 0n) {
    console.error("No L2 balance! Bridge some ETH from L1 first.");
    process.exit(1);
  }

  const counterBytecode = loadCounterBytecode();
  console.log(`Counter bytecode loaded (${counterBytecode.length / 2 - 1} bytes)`);

  // Build deployment transaction
  const tx = ethers.Transaction.from({
    type: 2,
    chainId: L2_CHAIN_ID,
    nonce: nonce,
    to: null, // Contract creation
    value: 0n,
    maxFeePerGas: 1000000000n,
    maxPriorityFeePerGas: 1000000000n,
    gasLimit: 500000n,
    data: counterBytecode,
  });

  const signedTx = await wallet.signTransaction(tx);
  console.log("Transaction signed");

  // Submit through L2 RPC proxy, which routes eth_sendRawTransaction to builder
  console.log("Submitting via L2 proxy (builder route)...");
  const l1TxHash = await l2Provider.send("eth_sendRawTransaction", [signedTx]);

  // Compute expected contract address
  const contractAddress = ethers.getCreateAddress({
    from: wallet.address,
    nonce: nonce,
  });
  console.log("\n✅ Counter deployment submitted!");
  console.log(`   Contract address: ${contractAddress}`);
  console.log(`   L1 TX hash: ${l1TxHash}`);
}

main().catch(console.error);
