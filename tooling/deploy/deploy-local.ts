#!/usr/bin/env node
/**
 * Deploy sync-rollups contracts to local Anvil
 */

import { JsonRpcProvider, Wallet, ContractFactory, Contract } from "ethers";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Anvil default private key (account 0)
const ADMIN_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const L1_RPC = "http://localhost:8545";

async function main() {
  console.log("=== Deploying sync-rollups contracts ===\n");

  const provider = new JsonRpcProvider(L1_RPC);
  const deployer = new Wallet(ADMIN_PRIVATE_KEY, provider);

  console.log(`Deployer: ${deployer.address}`);
  const balance = await provider.getBalance(deployer.address);
  console.log(`Balance: ${balance / BigInt(1e18)} ETH\n`);

  // Load contract artifacts
  const adminVerifierArtifact = JSON.parse(
    readFileSync(join(__dirname, "../out/AdminZKVerifier.sol/AdminZKVerifier.json"), "utf8")
  );

  // Load Rollups artifact from sync-rollups
  const rollupsArtifact = JSON.parse(
    readFileSync(join(__dirname, "../../sync-rollups/out/Rollups.sol/Rollups.json"), "utf8")
  );

  // Deploy AdminZKVerifier
  console.log("Deploying AdminZKVerifier...");
  const verifierFactory = new ContractFactory(
    adminVerifierArtifact.abi,
    adminVerifierArtifact.bytecode.object,
    deployer
  );
  const verifier = await verifierFactory.deploy(deployer.address);
  await verifier.waitForDeployment();
  const verifierAddress = await verifier.getAddress();
  console.log(`  AdminZKVerifier: ${verifierAddress}`);

  // Deploy Rollups
  console.log("\nDeploying Rollups...");
  const rollupsFactory = new ContractFactory(
    rollupsArtifact.abi,
    rollupsArtifact.bytecode.object,
    deployer
  );
  // Constructor: (address _zkVerifier, uint256 startingRollupId)
  const rollups = await rollupsFactory.deploy(verifierAddress, 0);
  await rollups.waitForDeployment();
  const rollupsAddress = await rollups.getAddress();
  console.log(`  Rollups: ${rollupsAddress}`);

  // Create a rollup
  console.log("\nCreating rollup 0...");
  const rollupsContract = new Contract(rollupsAddress, rollupsArtifact.abi, deployer);

  // Initial state root - we'll use a simple hash for now
  // This should match what the fullnode computes at genesis
  const initialState = "0x0000000000000000000000000000000000000000000000000000000000000000";
  const verificationKey = "0x0000000000000000000000000000000000000000000000000000000000000001"; // Placeholder

  const tx = await rollupsContract.createRollup(initialState, verificationKey, deployer.address);
  const receipt = await tx.wait();
  console.log(`  Transaction: ${receipt.hash}`);

  // Verify rollup was created
  const rollupData = await rollupsContract.rollups(0);
  console.log(`  Rollup 0 created:`);
  console.log(`    Owner: ${rollupData.owner}`);
  console.log(`    State Root: ${rollupData.stateRoot}`);
  console.log(`    Ether Balance: ${rollupData.etherBalance}`);

  const blockNumber = await provider.getBlockNumber();

  console.log("\n=== Deployment Complete ===\n");
  console.log("Environment variables:");
  console.log(`export ROLLUPS_ADDRESS=${rollupsAddress}`);
  console.log(`export VERIFIER_ADDRESS=${verifierAddress}`);
  console.log(`export DEPLOYMENT_BLOCK=${blockNumber}`);
  console.log(`export ADMIN_KEY=${ADMIN_PRIVATE_KEY}`);
  console.log(`export ROLLUP_ID=0`);
  console.log(`export L1_RPC=${L1_RPC}`);

  // Write to .env.local
  const envContent = `# sync-rollups Local Deployment
ROLLUPS_ADDRESS=${rollupsAddress}
VERIFIER_ADDRESS=${verifierAddress}
DEPLOYMENT_BLOCK=${blockNumber}
ADMIN_KEY=${ADMIN_PRIVATE_KEY}
ROLLUP_ID=0
L1_RPC=${L1_RPC}
`;
  const { writeFileSync } = await import("fs");
  writeFileSync(join(__dirname, "../.env.local"), envContent);
  console.log("\nWritten to .env.local");
}

main().catch(console.error);
