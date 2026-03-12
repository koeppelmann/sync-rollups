# State Transition Function Spec

This document defines exactly how the L2 blockchain is derived from L1 interactions. Any fullnode implementing this spec MUST produce identical L2 state for the same sequence of L1 events.

## Overview

The L2 chain is a **deterministic function of the L1 chain**. No L2 state exists that was not caused by an L1 transaction interacting with the `Rollups` contract. The L2 fullnode watches L1 events and replays them locally.

## L1 Functions That Trigger L2 State Changes

There are exactly **three** L1 interactions that cause L2 state transitions:

### 1. `executeL2TX(rollupId, rlpEncodedTx)`

A permissionless L1 function that submits a pre-signed L2 transaction. The `rlpEncodedTx` is a fully signed EVM transaction (with sender signature). On L2, this transaction is broadcast as-is — the sender must have sufficient L2 balance.

### 2. Cross-chain call via `CrossChainProxy` (L1 → L2)

When an L1 address sends a transaction to a `CrossChainProxy` contract (deployed via `Rollups.createCrossChainProxy`), the proxy forwards it to `Rollups.executeCrossChainCall`. The L1 contract looks up a pre-loaded execution entry, applies state deltas, and emits `L2ExecutionPerformed` + `ExecutionConsumed`.

On L2, the fullnode replays this by:
1. Dry-running `eth_call(from=operator, to=destination, data, value)` to predict return data
2. Building a RESULT action hash from the dry-run output
3. Calling `CrossChainManagerL2.loadExecutionTable` with an entry keyed by that hash
4. Calling `CrossChainManagerL2.executeIncomingCrossChainCall(destination, value, data, sourceAddress, sourceRollup, scope)`
5. Mining both in a single L2 block

Plain value transfers (no calldata) skip steps 1-4 and send directly via `sendSystemTx`.

### 3. `postBatch` with immediate entries

When `postBatch` is called with entries whose `actionHash == bytes32(0)`, the state deltas are applied immediately on L1. These represent batch-processed L2 transactions (e.g., multiple L2TX grouped together). The fullnode replays each immediate entry's state transition on L2.

> **Implementation note:** postBatch event handling is not yet implemented in the fullnode. The current POC uses `executeL2TX` and cross-chain calls exclusively.

## L2 Block Production Rules

### Rule 1: One L2 block per L1 function call

Each time one of the three functions above is called on L1, exactly **one new L2 block** is mined on the L2 chain. There is a 1:1 correspondence between L1 state-changing calls and L2 blocks.

### Rule 2: Coinbase = `0x0000...0000`

Both builder and event processor use `coinbase = address(0)`. Coinbase affects state root (fee recipient is "touched" during block processing, receives priority fees), so both sides must agree.

> **Future:** `coinbase = msg.sender` of the L1 caller, making it deterministic from L1 data alone.

### Rule 3: Timestamp = L1 block timestamp

The `timestamp` of each L2 block MUST equal the timestamp of the L1 block that contains the triggering transaction. This ensures:
- Deterministic timestamps derivable from L1
- Monotonically non-decreasing timestamps (since L1 timestamps are)
- Multiple L2 blocks can share the same timestamp (if multiple L1 calls occur in the same L1 block)

The builder chooses a simulation timestamp before executing the L2 transaction, simulates with that timestamp, then forces the L1 block timestamp to match via `evm_setNextBlockTimestamp`. Event processors read the L1 block timestamp from the `L2ExecutionPerformed` event's block and mine L2 blocks with the same timestamp.

### Rule 4: Preparation transactions at the beginning of the L2 block

Before the user's transaction is executed, the operator may include **preparation transactions** at the beginning of the L2 block. These are system-level setup operations required for correct execution, such as:

- Deploying a `CrossChainProxy` on L2 (via `CrossChainManagerL2.createCrossChainProxy`)
- Loading execution table entries (via `CrossChainManagerL2.loadExecutionTable`)
- Funding the target address if needed for a value-bearing cross-chain call

These preparation transactions are deterministic — given the L1 event data, any fullnode can compute exactly which preparation steps are needed.

### Rule 5: Transaction ordering within a block

Within a single L2 block, transactions are ordered as follows:
1. Preparation transactions (operator system calls), in a deterministic order
2. The user's transaction (the actual state-changing operation)

### Rule 6: Gas pricing (EIP-1559)

The L2 chain uses **standard Ethereum EIP-1559 gas pricing**:

- **Genesis base fee**: 1 gwei (`baseFeePerGas = 0x3B9ACA00`), matching Ethereum's initial value at the London fork.
- **Base fee dynamics**: Each L2 block's base fee is computed from the parent block using the standard EIP-1559 formula: `gasTarget = gasLimit / 2`, with the base fee increasing when blocks exceed the target and decreasing when below.
- **Base fee burning**: The base fee portion of gas costs (`baseFee × gasUsed`) is burned (removed from total L2 supply), exactly as in Ethereum.
- **Priority fees**: The priority fee (`min(maxPriorityFeePerGas, maxFeePerGas - baseFee)`) goes to the block's coinbase address.

#### System transactions (operator)

- `maxFeePerGas` = `computeNextBaseFee(parentBaseFee, parentGasUsed, parentGasLimit)` — deterministic from parent block
- `maxPriorityFeePerGas` = 0

Same `maxFeePerGas` → same tx encoding → same tx hash → same state root across all fullnodes. The `computeNextBaseFee` function is implemented identically in TypeScript (`state-manager.ts`) and Rust (`event_processor.rs`).

#### User transactions

User-submitted L2 transactions (via `executeL2TX`) must set `maxFeePerGas ≥ baseFee` of the block they are included in. Users pay gas from their L2 balance (bridged from L1). Wallets and RPC proxies automatically query `eth_gasPrice` for the current base fee.

#### Determinism

Base fee calculation is fully deterministic: given the same parent block, all fullnodes compute the same base fee. Since system transactions use the computed base fee as `maxFeePerGas`, their encoding and gas costs are identical across fullnodes, preserving state root agreement.

## L2 Genesis State

The L2 genesis block contains:

1. **CrossChainManagerL2 contract**: Deployed at a deterministic address, initialized with the rollup ID and the operator's address as system address
2. **Operator account**: Pre-funded with a fixed ETH balance (used for disbursing bridged ETH)

The genesis state root is computed deterministically from:
- The `Rollups` contract address on L1
- The rollup ID
- The L1 chain ID

The operator key is derived via: `keccak256("sync-rollups-operator" || rollupsAddress || rollupId || chainId)`

## Event-Driven Replay

The fullnode watches for these L1 events on the `Rollups` contract:

| L1 Event | L2 Action |
|---|---|
| `L2ExecutionPerformed(rollupId, currentState, newState)` + `ExecutionConsumed(actionHash, action)` | Replay the execution on L2 based on the action type |
| `StateUpdated(rollupId, newStateRoot)` | Update tracked state (owner bypass, no L2 replay needed) |

For `L2ExecutionPerformed`, the fullnode:
1. Fetches the L1 transaction that emitted the event
2. Decodes it to determine which of the three function types was called
3. Extracts the relevant parameters (L2 tx, call target, etc.)
4. Determines the L1 block timestamp and the `msg.sender`
5. Mines an L2 block with the correct coinbase and timestamp
6. Verifies the resulting L2 state root matches `newState`

## Determinism Guarantees

For two fullnodes to produce identical L2 state, the following must hold:
- Same L1 event sequence (same canonical L1 chain)
- Same genesis state (same rollup config)
- Same L2 block parameters (coinbase, timestamp, baseFee from EIP-1559 formula)
- Same transaction ordering within each block
- Same EVM execution (identical EVM implementation)

If any fullnode's L2 state root diverges from the L1-posted state root, it indicates either:
- A bug in the fullnode implementation
- A fraudulent state root posted by a malicious builder/prover
