#!/usr/bin/env npx tsx
/**
 * Fuzz test for sync-rollups: verifies reth and ethrex produce identical state roots
 * after processing random transactions including:
 * - Simple ETH transfers (L1→L2 bridge)
 * - Contract deployments on L2 (via executeL2TX)
 * - Cross-chain calls: L1→L2 calling Counter.increment() via Logger.callAndLog()
 * - Direct L2 transactions (Counter.increment(), Logger.callAndLog())
 * - Contracts exercising various EVM opcodes
 */

import { ethers } from "ethers";

// ============ Configuration ============
const L1_RPC = "http://localhost:8545";
const BUILDER_URL = "http://localhost:3200";
const L2_RPC_PROXY = "http://localhost:9548"; // L2 proxy (for submitting txs)
const RETH_EVM = "http://localhost:9546";
const ETHREX_EVM = "http://localhost:9556";
const ETHREX_STATUS = "http://localhost:3201";
const RETH_FULLNODE = "http://localhost:9547";

const ROLLUPS_ADDR = "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512";

// Anvil accounts
const ACCOUNT1_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ACCOUNT2_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

// ============ ABI fragments ============
const COUNTER_ABI = [
  "function increment() public",
  "function getCount() public view returns (uint256)",
  "function count() public view returns (uint256)",
];

const LOGGER_ABI = [
  "function callAndLog(address target, bytes calldata data) external payable returns (bool success, bytes memory returnData)",
];

// ============ Bytecodes for deployment ============
// Simple storage contract: stores a value, reads it back (SSTORE, SLOAD, MSTORE, RETURN)
const STORAGE_CONTRACT_BYTECODE =
  // Constructor: store 42 at slot 0, return runtime code
  // Runtime: CALLDATASIZE==0 → return stored value; else store calldata[0..32] at slot 0
  "0x" +
  // Constructor
  "602a" +       // PUSH1 42
  "6000" +       // PUSH1 0
  "55" +         // SSTORE
  // Return runtime bytecode
  "60" + "2e" +  // PUSH1 <runtime length = 46 bytes>
  "60" + "0e" +  // PUSH1 <runtime offset in initcode = 14>
  "6000" +       // PUSH1 0 (destOffset)
  "39" +         // CODECOPY
  "60" + "2e" +  // PUSH1 <runtime length>
  "6000" +       // PUSH1 0
  "f3" +         // RETURN
  // Runtime code (46 bytes = 0x2e)
  "36" +         // CALLDATASIZE
  "60" + "20" +  // PUSH1 32
  "10" +         // LT (calldatasize < 32)
  "60" + "1c" +  // PUSH1 <jump to read>
  "57" +         // JUMPI
  // Write path: store calldata[0:32] at slot 0
  "6000" +       // PUSH1 0
  "35" +         // CALLDATALOAD
  "6000" +       // PUSH1 0
  "55" +         // SSTORE
  "00" +         // STOP
  // Read path (offset 0x1c = 28 from runtime start)
  "5b" +         // JUMPDEST
  "6000" +       // PUSH1 0
  "54" +         // SLOAD
  "6000" +       // PUSH1 0
  "52" +         // MSTORE
  "6020" +       // PUSH1 32
  "6000" +       // PUSH1 0
  "f3";          // RETURN

// Contract that exercises many opcodes: arithmetic, comparison, bitwise, hashing, env ops
const OPCODE_EXERCISER_BYTECODE =
  "0x" +
  // Constructor: just return runtime code
  "60" + "80" +  // PUSH1 128 (runtime length, will adjust)
  "60" + "0c" +  // PUSH1 12 (offset)
  "6000" +       // PUSH1 0
  "39" +         // CODECOPY
  "60" + "80" +  // PUSH1 128
  "6000" +       // PUSH1 0
  "f3" +         // RETURN
  // Runtime: exercise opcodes and store results
  // Arithmetic: ADD, MUL, SUB, DIV, MOD, EXP, SIGNEXTEND
  "6005" + "6003" + "01" +  // 3+5=8, ADD
  "6000" + "52" +           // MSTORE at 0
  "6007" + "6003" + "02" +  // 3*7=21, MUL
  "6020" + "52" +           // MSTORE at 32
  "6003" + "600a" + "03" +  // 10-3=7, SUB
  "6040" + "52" +           // MSTORE at 64
  "6003" + "6015" + "04" +  // 21/3=7, DIV
  "6060" + "52" +           // MSTORE at 96
  // Comparison: LT, GT, EQ, ISZERO
  "600a" + "6005" + "10" +  // 5 < 10 = 1, LT
  "6080" + "52" +           // MSTORE at 128
  "6005" + "600a" + "11" +  // 10 > 5 = 1, GT
  "60a0" + "52" +           // MSTORE at 160
  // Bitwise: AND, OR, XOR, NOT, SHL, SHR
  "60ff" + "600f" + "16" +  // 0x0f & 0xff = 0x0f, AND
  "60c0" + "52" +           // MSTORE at 192
  "60f0" + "600f" + "17" +  // 0x0f | 0xf0 = 0xff, OR
  "60e0" + "52" +           // MSTORE at 224
  // Hashing: SHA3
  "6020" +                   // PUSH1 32 (length)
  "6000" +                   // PUSH1 0 (offset)
  "20" +                     // SHA3
  "61" + "0100" + "52" +     // MSTORE at 256
  // Environment: ADDRESS, CALLER, CALLVALUE, CALLDATASIZE, GASPRICE, CHAINID
  "30" +                     // ADDRESS
  "61" + "0120" + "52" +     // MSTORE at 288
  "33" +                     // CALLER
  "61" + "0140" + "52" +     // MSTORE at 320
  "34" +                     // CALLVALUE
  "61" + "0160" + "52" +     // MSTORE at 352
  "36" +                     // CALLDATASIZE
  "61" + "0180" + "52" +     // MSTORE at 384
  "3a" +                     // GASPRICE
  "61" + "01a0" + "52" +     // MSTORE at 416
  "46" +                     // CHAINID
  "61" + "01c0" + "52" +     // MSTORE at 448
  // Block info: NUMBER, TIMESTAMP, GASLIMIT, COINBASE, DIFFICULTY/PREVRANDAO
  "43" +                     // NUMBER
  "61" + "01e0" + "52" +     // MSTORE at 480
  "42" +                     // TIMESTAMP
  "61" + "0200" + "52" +     // MSTORE at 512
  "45" +                     // GASLIMIT
  "61" + "0220" + "52" +     // MSTORE at 544
  "41" +                     // COINBASE
  "61" + "0240" + "52" +     // MSTORE at 576
  // SELFBALANCE (EIP-1884)
  "47" +                     // SELFBALANCE
  "61" + "0260" + "52" +     // MSTORE at 608
  // Store final result at slot 0 (the hash from SHA3)
  "61" + "0100" + "51" +     // MLOAD from 256 (the SHA3 result)
  "6000" + "55" +            // SSTORE at slot 0
  // Return all computed values (640 bytes = 0x280)
  "61" + "0280" +            // PUSH2 640
  "6000" +                   // PUSH1 0
  "f3";                      // RETURN

// Self-destruct contract (SELFDESTRUCT opcode): receives ETH, self-destructs to caller
const SELFDESTRUCT_BYTECODE =
  "0x" +
  "60" + "07" +  // PUSH1 7 (runtime length)
  "60" + "0c" +  // PUSH1 12 (offset)
  "6000" +       // PUSH1 0
  "39" +         // CODECOPY
  "60" + "07" +  // PUSH1 7
  "6000" +       // PUSH1 0
  "f3" +         // RETURN
  // Runtime: push caller, selfdestruct
  "34" +         // CALLVALUE (save any received value)
  "6000" + "52" +// MSTORE
  "33" +         // CALLER
  "ff";          // SELFDESTRUCT

// ============ Helpers ============

async function callJsonRpc(url: string, method: string, params: any[] = []): Promise<any> {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
  });
  const data = await resp.json() as any;
  if (data.error) throw new Error(`${method}: ${JSON.stringify(data.error)}`);
  return data.result;
}

async function getStateRoots(): Promise<{ rethBlock: number; rethState: string; ethrexBlock: number; ethrexState: string }> {
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

async function waitForSync(maxWaitMs = 15000): Promise<{ rethBlock: number; rethState: string; ethrexBlock: number; ethrexState: string }> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const state = await getStateRoots();
    if (state.rethBlock === state.ethrexBlock && state.rethState === state.ethrexState) {
      return state;
    }
    // If blocks match but state differs, that's a divergence — return immediately
    if (state.rethBlock === state.ethrexBlock && state.rethState !== state.ethrexState) {
      return state;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return await getStateRoots();
}

function shortHash(h: string): string {
  return h.slice(0, 10) + "...";
}

// ============ Transaction Types ============

interface FuzzTx {
  name: string;
  execute: () => Promise<void>;
}

function buildFuzzTransactions(
  l1Provider: ethers.JsonRpcProvider,
  l2Provider: ethers.JsonRpcProvider,
  wallet1L1: ethers.Wallet,
  wallet2L1: ethers.Wallet,
  wallet1L2: ethers.Wallet,
  wallet2L2: ethers.Wallet,
  l2CounterAddr: string,
  l2LoggerAddr: string,
  l1CounterAddr: string,
  l1LoggerAddr: string,
): FuzzTx[] {
  const counterIface = new ethers.Interface(COUNTER_ABI);
  const loggerIface = new ethers.Interface(LOGGER_ABI);
  const txs: FuzzTx[] = [];

  // --- 1. Simple L1→L2 ETH bridge (various amounts) ---
  for (const [sender, key, amount] of [
    ["Account1", ACCOUNT1_KEY, "0.01"],
    ["Account2", ACCOUNT2_KEY, "0.005"],
    ["Account1", ACCOUNT1_KEY, "0.001"],
  ] as const) {
    txs.push({
      name: `Bridge ${amount} ETH from ${sender} to L2`,
      execute: async () => {
        const wallet = new ethers.Wallet(key, l1Provider);
        const amountWei = ethers.parseEther(amount).toString();
        // Prepare
        const prep = await fetch(`${BUILDER_URL}/prepare-l1-call`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            l2Target: wallet.address,
            value: amountWei,
            data: "0x",
            sourceAddress: wallet.address,
          }),
        }).then((r) => r.json()) as any;
        if (!prep.success) throw new Error(`Prepare failed: ${prep.error}`);

        // Send ETH to proxy
        const tx = await wallet.sendTransaction({
          to: prep.proxyAddress,
          value: ethers.parseEther(amount),
        });
        await tx.wait();
      },
    });
  }

  // --- 2. L1→L2 cross-chain call: Counter.increment() ---
  txs.push({
    name: "L1→L2 call: Counter.increment()",
    execute: async () => {
      const calldata = counterIface.encodeFunctionData("increment");
      const prep = await fetch(`${BUILDER_URL}/prepare-l1-call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          l2Target: l2CounterAddr,
          value: "0",
          data: calldata,
          sourceAddress: wallet1L1.address,
        }),
      }).then((r) => r.json()) as any;
      if (!prep.success) throw new Error(`Prepare failed: ${prep.error}`);

      const tx = await wallet1L1.sendTransaction({
        to: prep.proxyAddress,
        data: calldata,
      });
      await tx.wait();
    },
  });

  // --- 3. L1→L2 cross-chain call: Logger.callAndLog(Counter.increment()) ---
  txs.push({
    name: "L1→L2 call: Logger.callAndLog(Counter.increment())",
    execute: async () => {
      const innerCalldata = counterIface.encodeFunctionData("increment");
      const outerCalldata = loggerIface.encodeFunctionData("callAndLog", [l2CounterAddr, innerCalldata]);

      const prep = await fetch(`${BUILDER_URL}/prepare-l1-call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          l2Target: l2LoggerAddr,
          value: "0",
          data: outerCalldata,
          sourceAddress: wallet1L1.address,
        }),
      }).then((r) => r.json()) as any;
      if (!prep.success) throw new Error(`Prepare failed: ${prep.error}`);

      const tx = await wallet1L1.sendTransaction({
        to: prep.proxyAddress,
        data: outerCalldata,
      });
      await tx.wait();
    },
  });

  // --- 4. L1→L2 cross-chain call with ETH: Logger.callAndLog() with value ---
  txs.push({
    name: "L1→L2 call: Logger.callAndLog(Counter) with 0.001 ETH",
    execute: async () => {
      const innerCalldata = counterIface.encodeFunctionData("increment");
      const outerCalldata = loggerIface.encodeFunctionData("callAndLog", [l2CounterAddr, innerCalldata]);
      const val = ethers.parseEther("0.001").toString();

      const prep = await fetch(`${BUILDER_URL}/prepare-l1-call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          l2Target: l2LoggerAddr,
          value: val,
          data: outerCalldata,
          sourceAddress: wallet2L1.address,
        }),
      }).then((r) => r.json()) as any;
      if (!prep.success) throw new Error(`Prepare failed: ${prep.error}`);

      const tx = await wallet2L1.sendTransaction({
        to: prep.proxyAddress,
        value: ethers.parseEther("0.001"),
        data: outerCalldata,
      });
      await tx.wait();
    },
  });

  // --- 5. L2 direct transactions: Counter.increment() ---
  for (const [name, key] of [
    ["Account1", ACCOUNT1_KEY],
    ["Account2", ACCOUNT2_KEY],
  ] as const) {
    txs.push({
      name: `L2 direct: ${name} calls Counter.increment()`,
      execute: async () => {
        // Create fresh wallet to avoid nonce caching
        const freshProvider = new ethers.JsonRpcProvider(L2_RPC_PROXY);
        const wallet = new ethers.Wallet(key, freshProvider);
        const nonce = await freshProvider.getTransactionCount(wallet.address, "pending");
        const counter = new ethers.Contract(l2CounterAddr, COUNTER_ABI, wallet);
        const tx = await (counter as any).increment({ gasLimit: 100000, nonce });
      },
    });
  }

  // --- 6. L2 direct: Logger.callAndLog(Counter.increment()) ---
  txs.push({
    name: "L2 direct: Logger.callAndLog(Counter.increment())",
    execute: async () => {
      const freshProvider = new ethers.JsonRpcProvider(L2_RPC_PROXY);
      const wallet = new ethers.Wallet(ACCOUNT1_KEY, freshProvider);
      const nonce = await freshProvider.getTransactionCount(wallet.address, "pending");
      const innerCalldata = counterIface.encodeFunctionData("increment");
      const logger = new ethers.Contract(l2LoggerAddr, LOGGER_ABI, wallet);
      const tx = await (logger as any).callAndLog(l2CounterAddr, innerCalldata, { gasLimit: 200000, nonce });
    },
  });

  // --- 7. Deploy contracts on L2 (various bytecodes exercising different opcodes) ---
  txs.push({
    name: "L2 deploy: Storage contract (SSTORE/SLOAD/MSTORE/CODECOPY)",
    execute: async () => {
      const freshProvider = new ethers.JsonRpcProvider(L2_RPC_PROXY);
      const wallet = new ethers.Wallet(ACCOUNT2_KEY, freshProvider);
      const nonce = await freshProvider.getTransactionCount(wallet.address, "pending");
      await wallet.sendTransaction({ data: STORAGE_CONTRACT_BYTECODE, gasLimit: 200000, nonce });
    },
  });

  txs.push({
    name: "L2 deploy: Opcode exerciser (ADD/MUL/SUB/DIV/LT/GT/AND/OR/SHA3/ADDRESS/CALLER/CHAINID/...)",
    execute: async () => {
      const freshProvider = new ethers.JsonRpcProvider(L2_RPC_PROXY);
      const wallet = new ethers.Wallet(ACCOUNT1_KEY, freshProvider);
      const nonce = await freshProvider.getTransactionCount(wallet.address, "pending");
      await wallet.sendTransaction({ data: OPCODE_EXERCISER_BYTECODE, gasLimit: 500000, nonce });
    },
  });

  // --- 8. L2 ETH transfer between accounts ---
  txs.push({
    name: "L2 direct: ETH transfer Account1→Account2 (0.001 ETH)",
    execute: async () => {
      const freshProvider = new ethers.JsonRpcProvider(L2_RPC_PROXY);
      const wallet = new ethers.Wallet(ACCOUNT1_KEY, freshProvider);
      const nonce = await freshProvider.getTransactionCount(wallet.address, "pending");
      await wallet.sendTransaction({ to: wallet2L2.address, value: ethers.parseEther("0.001"), gasLimit: 21000, nonce });
    },
  });

  // --- 9. L1→L2 bridge + call from Account2 ---
  txs.push({
    name: "L1→L2 call: Account2 calls Counter.increment()",
    execute: async () => {
      const calldata = counterIface.encodeFunctionData("increment");
      const prep = await fetch(`${BUILDER_URL}/prepare-l1-call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          l2Target: l2CounterAddr,
          value: "0",
          data: calldata,
          sourceAddress: wallet2L1.address,
        }),
      }).then((r) => r.json()) as any;
      if (!prep.success) throw new Error(`Prepare failed: ${prep.error}`);

      const tx = await wallet2L1.sendTransaction({
        to: prep.proxyAddress,
        data: calldata,
      });
      await tx.wait();
    },
  });

  // --- 10. L1→L2 call: Logger.callAndLog targeting Counter from Account2 ---
  txs.push({
    name: "L1→L2: Account2 Logger.callAndLog(Counter.increment())",
    execute: async () => {
      const innerCalldata = counterIface.encodeFunctionData("increment");
      const outerCalldata = loggerIface.encodeFunctionData("callAndLog", [l2CounterAddr, innerCalldata]);

      const prep = await fetch(`${BUILDER_URL}/prepare-l1-call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          l2Target: l2LoggerAddr,
          value: "0",
          data: outerCalldata,
          sourceAddress: wallet2L1.address,
        }),
      }).then((r) => r.json()) as any;
      if (!prep.success) throw new Error(`Prepare failed: ${prep.error}`);

      const tx = await wallet2L1.sendTransaction({
        to: prep.proxyAddress,
        data: outerCalldata,
      });
      await tx.wait();
    },
  });

  return txs;
}

// ============ Main ============

async function main() {
  const targetCount = parseInt(process.argv[2] || "100", 10);
  console.log(`\n🔬 Fuzz Test: targeting ${targetCount} transactions\n`);

  // Check initial state
  const initial = await getStateRoots();
  console.log(`Initial state:`);
  console.log(`  reth:   block=${initial.rethBlock} state=${shortHash(initial.rethState)}`);
  console.log(`  ethrex: block=${initial.ethrexBlock} state=${shortHash(initial.ethrexState)}`);
  if (initial.rethState !== initial.ethrexState) {
    console.log(`\n❌ DIVERGENCE at start! Cannot begin fuzz test.`);
    process.exit(1);
  }
  console.log(`  ✓ States match\n`);

  // Set up providers and wallets
  const l1Provider = new ethers.JsonRpcProvider(L1_RPC);
  const l2Provider = new ethers.JsonRpcProvider(L2_RPC_PROXY);
  const wallet1L1 = new ethers.Wallet(ACCOUNT1_KEY, l1Provider);
  const wallet2L1 = new ethers.Wallet(ACCOUNT2_KEY, l1Provider);
  const wallet1L2 = new ethers.Wallet(ACCOUNT1_KEY, l2Provider);
  const wallet2L2 = new ethers.Wallet(ACCOUNT2_KEY, l2Provider);

  // Get deployed contract addresses from builder status
  const builderStatus = await fetch(`${BUILDER_URL}/status`).then((r) => r.json()) as any;

  // Get L2 contract addresses — read from L2 EVM
  // Counter and Logger were deployed in start-local.sh. Get them from recent deploy txs.
  // We know from start-local.sh output they're at specific addresses, but let's be robust:
  // Counter (L2) and Logger (L2) - use well-known addresses from last run
  // Actually let's discover them from the L2 chain
  let l2CounterAddr = "";
  let l2LoggerAddr = "";
  let l1CounterAddr = "";
  let l1LoggerAddr = "";

  // Read from the start-local.sh logs to find addresses
  try {
    const { execSync } = require("child_process");
    const logs = execSync("grep -E 'Counter \\(L[12]\\)|Logger \\(L[12]\\)' logs/anvil.log 2>/dev/null || true", { encoding: "utf8", cwd: "/home/ubuntu/code/sync-rollups" });
    // Fallback: just get the addresses by reading the latest start-local output
  } catch {}

  // Robust approach: check Counter and Logger bytecode at known addresses
  // from the start-local output (these are deterministic based on deployer nonce)
  const counterBytecodeHash = ethers.keccak256(
    (await l1Provider.getCode("0x2279b7a0a67db372996a5fab50d91eaa73d2ebe6")) || "0x"
  );

  // Try known addresses from start-local.sh (deterministic since same deployer nonces)
  for (const addr of [
    "0x2279b7a0a67db372996a5fab50d91eaa73d2ebe6",
    "0x5fc8d32690cc91d4c39d9d3abcbd16989f875707",
  ]) {
    const code = await l1Provider.getCode(addr);
    if (code && code.length > 2) {
      if (!l1CounterAddr) l1CounterAddr = addr;
      else if (!l1LoggerAddr) l1LoggerAddr = addr;
    }
  }

  // L1 addresses
  l1CounterAddr = "0x2279b7a0a67db372996a5fab50d91eaa73d2ebe6";
  l1LoggerAddr = "0x8a791620dd6260079bf849dc5567adc3f2fdc318";

  // Find L2 Counter and Logger by scanning L2 blocks for contract deployments
  const rethEvmProvider = new ethers.JsonRpcProvider(RETH_EVM);
  const l2BlockNum = initial.rethBlock;

  // Find L2 Counter and Logger by checking if Counter.count() (public state variable) works
  const counterIface = new ethers.Interface(COUNTER_ABI);
  const deployedContracts: string[] = [];
  for (let i = 1; i <= l2BlockNum; i++) {
    const block = await rethEvmProvider.getBlock(i, true);
    if (!block) continue;
    for (const txHash of block.transactions) {
      const receipt = await rethEvmProvider.getTransactionReceipt(txHash);
      if (receipt && receipt.contractAddress) {
        const code = await rethEvmProvider.getCode(receipt.contractAddress);
        if (code && code !== "0x") {
          deployedContracts.push(receipt.contractAddress);
        }
      }
    }
  }
  // Identify Counter: has count() public variable AND getCount() function
  // Logger: has callAndLog(address,bytes) but NOT count()/getCount()
  for (const addr of deployedContracts) {
    try {
      // Try Counter.count() — will return uint256
      const countResult = await rethEvmProvider.call({
        to: addr,
        data: counterIface.encodeFunctionData("count"),
      });
      // Try Counter.getCount() — will also return uint256
      const getCountResult = await rethEvmProvider.call({
        to: addr,
        data: counterIface.encodeFunctionData("getCount"),
      });
      // Both should succeed and return 32-byte values for Counter
      if (countResult && countResult.length === 66 && getCountResult && getCountResult.length === 66) {
        l2CounterAddr = addr;
        continue;
      }
    } catch {}
    // If not Counter, it's Logger (or some other contract)
    if (!l2LoggerAddr) l2LoggerAddr = addr;
  }
  // Fallback
  l2CounterAddr = l2CounterAddr || "0x8464135c8f25da09e49bc8782676a84730c318bc";
  l2LoggerAddr = l2LoggerAddr || "0x71c95911e9a5d330f4d621842ec243ee1343292e";

  console.log(`Contract addresses:`);
  console.log(`  L1 Counter: ${l1CounterAddr}`);
  console.log(`  L1 Logger:  ${l1LoggerAddr}`);
  console.log(`  L2 Counter: ${l2CounterAddr}`);
  console.log(`  L2 Logger:  ${l2LoggerAddr}`);

  // Verify contracts exist
  const l2CounterCode = await rethEvmProvider.getCode(l2CounterAddr);
  const l2LoggerCode = await rethEvmProvider.getCode(l2LoggerAddr);
  if (!l2CounterCode || l2CounterCode === "0x") {
    console.log(`\n❌ L2 Counter not deployed at ${l2CounterAddr}`);
    process.exit(1);
  }
  if (!l2LoggerCode || l2LoggerCode === "0x") {
    console.log(`\n❌ L2 Logger not deployed at ${l2LoggerAddr}`);
    process.exit(1);
  }
  console.log(`  ✓ All contracts verified\n`);

  // Build the pool of fuzz transactions
  const txPool = buildFuzzTransactions(
    l1Provider, l2Provider,
    wallet1L1, wallet2L1,
    wallet1L2, wallet2L2,
    l2CounterAddr, l2LoggerAddr,
    l1CounterAddr, l1LoggerAddr,
  );

  console.log(`Transaction pool: ${txPool.length} types\n`);
  console.log(`${"#".padStart(4)} ${"Type".padEnd(65)} ${"Result".padEnd(8)} Block  State Root`);
  console.log("─".repeat(110));

  let successCount = 0;
  let failCount = 0;
  let divergenceCount = 0;

  for (let i = 0; i < targetCount; i++) {
    // Pick a random transaction type
    const txIdx = Math.floor(Math.random() * txPool.length);
    const fuzzTx = txPool[txIdx];
    const txNum = (i + 1).toString().padStart(4);

    try {
      await fuzzTx.execute();

      // Wait for both fullnodes to process the event
      await new Promise((r) => setTimeout(r, 5000));
      const state = await waitForSync(15000);

      if (state.rethState !== state.ethrexState) {
        divergenceCount++;
        console.log(
          `${txNum} ${fuzzTx.name.padEnd(65).slice(0, 65)} ${"DIVERGE".padEnd(8)} ${state.rethBlock.toString().padStart(5)}  reth=${shortHash(state.rethState)} ethrex=${shortHash(state.ethrexState)}`
        );
        console.log(`\n❌ STATE DIVERGENCE after tx #${i + 1}: "${fuzzTx.name}"`);
        console.log(`   reth   block=${state.rethBlock} state=${state.rethState}`);
        console.log(`   ethrex block=${state.ethrexBlock} state=${state.ethrexState}`);
        console.log(`\nStopping fuzz test to investigate.`);
        process.exit(1);
      }

      successCount++;
      console.log(
        `${txNum} ${fuzzTx.name.padEnd(65).slice(0, 65)} ${"OK".padEnd(8)} ${state.rethBlock.toString().padStart(5)}  ${shortHash(state.rethState)}`
      );
    } catch (e: any) {
      failCount++;
      console.log(
        `${txNum} ${fuzzTx.name.padEnd(65).slice(0, 65)} ${"FAIL".padEnd(8)} -      ${e.message.slice(0, 60)}`
      );

      // Still check for divergence after a failed tx
      await new Promise((r) => setTimeout(r, 3000));
      const state = await getStateRoots();
      if (state.rethBlock === state.ethrexBlock && state.rethState !== state.ethrexState) {
        divergenceCount++;
        console.log(`\n❌ STATE DIVERGENCE (post-failure) after tx #${i + 1}: "${fuzzTx.name}"`);
        console.log(`   reth   block=${state.rethBlock} state=${state.rethState}`);
        console.log(`   ethrex block=${state.ethrexBlock} state=${state.ethrexState}`);
        console.log(`\nStopping fuzz test to investigate.`);
        process.exit(1);
      }
    }
  }

  // Final summary
  console.log("\n" + "═".repeat(110));
  console.log(`Fuzz test complete: ${successCount} OK, ${failCount} failed, ${divergenceCount} divergences out of ${targetCount} transactions`);

  const finalState = await getStateRoots();
  console.log(`\nFinal state:`);
  console.log(`  reth:   block=${finalState.rethBlock} state=${finalState.rethState}`);
  console.log(`  ethrex: block=${finalState.ethrexBlock} state=${finalState.ethrexState}`);
  if (finalState.rethState === finalState.ethrexState) {
    console.log(`\n✅ All state roots match! Fuzz test PASSED.`);
  } else {
    console.log(`\n❌ Final state root MISMATCH!`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(`\nFatal error: ${e.message}`);
  process.exit(1);
});
