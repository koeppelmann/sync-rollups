# L2 Execution Engine Interface Specification

This document specifies exactly what an alternative L2 execution engine must implement to be compatible with the sync-rollups fullnode. It is derived from the current reth-based implementation in `reth-fullnode/state-manager.ts` and `reth-fullnode/event-processor.ts`.

---

## 1. Genesis Requirements

The L2 chain starts from a deterministic genesis block. Every fullnode running the same configuration MUST produce an identical genesis state root.

### 1.1 Genesis Configuration

```json
{
  "config": {
    "chainId": <L2_CHAIN_ID>,
    "homesteadBlock": 0,
    "eip150Block": 0,
    "eip155Block": 0,
    "eip158Block": 0,
    "byzantiumBlock": 0,
    "constantinopleBlock": 0,
    "petersburgBlock": 0,
    "istanbulBlock": 0,
    "berlinBlock": 0,
    "londonBlock": 0,
    "shanghaiTime": 0,
    "cancunTime": 0,
    "terminalTotalDifficulty": 0,
    "terminalTotalDifficultyPassed": true
  },
  "nonce": "0x0",
  "timestamp": "0x0",
  "extraData": "0x",
  "gasLimit": "0x1c9c380",
  "difficulty": "0x0",
  "mixHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
  "coinbase": "0x0000000000000000000000000000000000000000",
  "baseFeePerGas": "0x3B9ACA00",
  "number": "0x0",
  "gasUsed": "0x0",
  "parentHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
  "alloc": { ... }
}
```

The default L2 chain ID used in local development is `10200200`.

### 1.2 Genesis Alloc

The genesis `alloc` contains exactly two entries:

#### 1.2.1 Operator Account

- **Address**: Deterministically derived (see Section 1.3)
- **Balance**: `0xc9f2c9cd04674edea40000000` (10^30 wei, approximately 10^12 ETH)
- **Code**: None (EOA)
- **Storage**: None

The operator needs this large balance to disburse bridged ETH to L2 users. The bridge invariant ensures: `L1_rollup.etherBalance + operator_L2_balance == 10^30`.

#### 1.2.2 CrossChainManagerL2 Contract

- **Address**: Same as the L1 `Rollups` contract address (e.g., if Rollups is at `0x5FbDB...` on L1, CrossChainManagerL2 is at `0x5FbDB...` on L2)
- **Balance**: `0x0`
- **Code**: The **deployed bytecode** of `CrossChainManagerL2.sol` with immutable values spliced in:
  - `ROLLUP_ID`: The rollup ID (uint256, zero-padded to 32 bytes)
  - `SYSTEM_ADDRESS`: The operator address (address, zero-padded to 32 bytes)
- **Storage**: Empty (no constructor-initialized storage; immutables are in bytecode)

The deployed bytecode must be extracted from Forge build artifacts (`out/CrossChainManagerL2.sol/CrossChainManagerL2.json`) and immutable placeholder slots must be replaced with actual values using the `deployedBytecode.immutableReferences` metadata.

### 1.3 Operator Key Derivation

The operator private key is derived deterministically from public parameters so all fullnodes produce the same genesis state:

```
privateKey = keccak256(abi.encodePacked(
    "sync-rollups-operator",   // string
    rollupsAddress,             // address (L1 Rollups contract)
    rollupId,                   // uint256
    l2ChainId                   // uint256
))
```

This uses Solidity's `abi.encodePacked` encoding (equivalent to `solidityPackedKeccak256` in ethers.js). The operator address is then `address(privateKey)`.

### 1.4 Genesis State Root Computation

To compute the genesis state root:
1. Build the genesis JSON with the alloc described above
2. Initialize the execution engine with this genesis
3. Read block 0's `stateRoot` field via `eth_getBlockByNumber("0x0", false)`

This state root is used as the `initialState` when creating the rollup on L1 via `Rollups.createRollup()`.

---

## 2. Execution Engine Startup

### 2.1 Process Requirements

The execution engine must:
- Listen on an HTTP JSON-RPC port (configurable, e.g., 9546)
- Listen on an authenticated Engine API port (configurable, e.g., 8551)
- Accept the genesis configuration file at startup
- Persist state to a configurable data directory
- NOT auto-mine blocks (blocks are produced exclusively via the Engine API)
- Support EIP-1559 base fee dynamics (genesis `baseFeePerGas = 1 gwei`)

### 2.2 reth Command-Line Reference

The current implementation starts reth with these flags:

```bash
reth node \
  --http \
  --http.port <L2_EVM_PORT> \
  --http.api eth,net,debug,trace,txpool,web3,rpc,reth,miner \
  --chain <GENESIS_JSON_PATH> \
  --datadir <DATA_DIR>/reth \
  --log.stdout.filter error \
  --disable-discovery \
  --port <P2P_PORT> \
  --authrpc.port <AUTH_RPC_PORT> \
  --txpool.minimal-protocol-fee 0 \
  --txpool.minimum-priority-fee 0
```

Key requirements:
- **No `--dev` mode**: Blocks must not be auto-mined
- **Txpool**: Must accept transactions with `maxPriorityFeePerGas = 0` (system transactions use priority fee = 0)
- **No P2P discovery**: The L2 is a standalone chain with no peers

### 2.3 JWT Authentication

The Engine API requires JWT (HS256) authentication:
1. On first startup, reth generates a JWT secret file at `<DATA_DIR>/reth/jwt.hex`
2. The fullnode reads this hex-encoded secret
3. For each Engine API call, a JWT is generated:
   - Header: `{"alg": "HS256", "typ": "JWT"}`
   - Payload: `{"iat": <unix_timestamp_seconds>}`
   - Signature: HMAC-SHA256 of `header.payload` using the hex-decoded secret
4. The token is sent as `Authorization: Bearer <token>` header

### 2.4 Readiness Check

After starting, the fullnode polls `eth_blockNumber` on the HTTP RPC port until a successful response is received (timeout: 30 seconds, poll interval: 200ms).

### 2.5 Operator Nonce Initialization

After the engine is ready, the fullnode queries the operator's nonce:
```
eth_getTransactionCount(operatorAddress, "latest")
```
This nonce is tracked in-memory and incremented after each operator transaction to avoid stale-cache issues between mine cycles.

---

## 3. Engine API: Block Production

The L2 does NOT auto-mine blocks. Every block is produced via the Ethereum Engine API (authenticated RPC). The sequence is:

### 3.1 `mineBlock(options?)` Sequence

Called to produce exactly one L2 block containing all pending txpool transactions.

#### Step 1: Get current head

```
HTTP RPC: eth_getBlockByNumber("latest", false)
```
Extract `hash` (headHash) and `timestamp` (headTimestamp, parsed from hex).

#### Step 2: Request payload build (`engine_forkchoiceUpdatedV3`)

```json
{
  "method": "engine_forkchoiceUpdatedV3",
  "params": [
    {
      "headBlockHash": "<headHash>",
      "safeBlockHash": "<headHash>",
      "finalizedBlockHash": "<headHash>"
    },
    {
      "timestamp": "<hex(blockTimestamp)>",
      "prevRandao": "0x0000000000000000000000000000000000000000000000000000000000000000",
      "suggestedFeeRecipient": "<coinbase>",
      "withdrawals": [],
      "parentBeaconBlockRoot": "0x0000000000000000000000000000000000000000000000000000000000000000"
    }
  ]
}
```

**Parameters:**
- `timestamp`: `options.timestamp` if provided (always the L1 block timestamp during event replay), otherwise `headTimestamp + 1`. Must be strictly greater than `headTimestamp`.
- `coinbase` / `suggestedFeeRecipient`: `options.coinbase` if provided, otherwise `0x0000000000000000000000000000000000000000`.

**Expected response:**
```json
{
  "payloadStatus": { "status": "VALID", ... },
  "payloadId": "<8-byte-hex>"
}
```

The `payloadId` is required for the next step.

#### Step 3: Get built payload (`engine_getPayloadV3`)

```json
{
  "method": "engine_getPayloadV3",
  "params": ["<payloadId>"]
}
```

**Expected response:**
```json
{
  "executionPayload": {
    "parentHash": "...",
    "feeRecipient": "...",
    "stateRoot": "...",
    "receiptsRoot": "...",
    "logsBloom": "...",
    "prevRandao": "...",
    "blockNumber": "...",
    "gasLimit": "...",
    "gasUsed": "...",
    "timestamp": "...",
    "extraData": "...",
    "baseFeePerGas": "...",
    "blockHash": "...",
    "transactions": [...],
    "withdrawals": [],
    "blobGasUsed": "...",
    "excessBlobGas": "..."
  },
  "blockValue": "...",
  "blobsBundle": { "commitments": [], "proofs": [], "blobs": [] },
  "shouldOverrideBuilder": false
}
```

The `executionPayload` contains the full block with all pending transactions from the txpool.

#### Step 4: Submit new payload (`engine_newPayloadV3`)

```json
{
  "method": "engine_newPayloadV3",
  "params": [
    <executionPayload>,
    [],
    "0x0000000000000000000000000000000000000000000000000000000000000000"
  ]
}
```

Parameters:
1. The `executionPayload` from Step 3
2. Empty array (no blob versioned hashes)
3. `parentBeaconBlockRoot` (zero hash)

**Expected response:**
```json
{
  "status": "VALID",
  "latestValidHash": "<blockHash>"
}
```

If `status` is not `"VALID"`, the block production failed.

#### Step 5: Update fork choice (`engine_forkchoiceUpdatedV3`)

```json
{
  "method": "engine_forkchoiceUpdatedV3",
  "params": [
    {
      "headBlockHash": "<newBlockHash>",
      "safeBlockHash": "<newBlockHash>",
      "finalizedBlockHash": "<newBlockHash>"
    },
    null
  ]
}
```

This makes the new block canonical. The second parameter is `null` (no new payload attributes).

### 3.2 `speculateBlock(options?)` Sequence

Called by the builder and proofer to obtain a speculative `stateRoot` WITHOUT committing a block. The canonical chain is unchanged afterward. This enables repeated simulation attempts (e.g., ECDSA retry loops targeting different L1 blocks) without expensive rollbacks.

The sequence is identical to `mineBlock` Steps 1-2, but **deliberately skips Steps 3-5** (newPayload, FCU-finalize):

#### Step 1: Get current head

Same as `mineBlock` Step 1.

#### Step 2: Request payload build (`engine_forkchoiceUpdatedV3`)

Same as `mineBlock` Step 2. Returns `payloadId`.

#### Step 3: Get built payload (`engine_getPayloadV3`)

Same as `mineBlock` Step 3. The `executionPayload.stateRoot` is the speculative state root — the result of executing all pending txpool transactions on top of the current head with the given timestamp.

#### Step 4: STOP — do NOT submit or finalize

Do **not** call `engine_newPayloadV3` or `engine_forkchoiceUpdatedV3`. The built payload is discarded. The canonical chain head remains unchanged.

**Critical invariants:**
- The canonical head block (`eth_blockNumber`) MUST NOT change after `speculateBlock`.
- Transactions in the txpool MUST remain available for subsequent `speculateBlock` or `mineBlock` calls. The payload builder reads from the txpool but does not consume transactions — they are only removed when included in a canonical block via the full `mineBlock` sequence.
- Multiple `speculateBlock` calls with different timestamps produce different `stateRoot` values (due to EIP-1559 base fee dynamics and any timestamp-dependent contract logic), all from the same base state.

---

## 4. Transaction Types

The fullnode submits two types of transactions to the L2 execution engine.

### 4.1 Operator System Transactions

Signed by the operator wallet. Used for protocol operations (proxy deployment, cross-chain call execution).

```
{
  to: <target_contract>,
  data: <abi_encoded_calldata>,
  value: <eth_value>,         // Usually 0, nonzero for value-bearing cross-chain calls
  nonce: <tracked_nonce>,     // Incremented in-memory after each tx
  gasLimit: 10_000_000,       // 10M gas
  maxFeePerGas: computeNextBaseFee(parentBlock),  // Deterministic from parent
  maxPriorityFeePerGas: 0,
  type: 2                     // EIP-1559
}
```

Submitted via the operator wallet's `sendTransaction()` (ethers.js), which internally calls `eth_sendRawTransaction` with the signed transaction.

**Two submission modes:**

1. **`sendSystemTx(to, data, value)`**: Sends to txpool WITHOUT mining. Used when multiple transactions must share one block. Caller must call `mineBlock()` afterward.

2. **`systemCall(to, data, value, blockOptions?)`**: Sends to txpool, then immediately calls `mineBlock()` and waits for receipt. Used for standalone operations.

### 4.2 User Raw Transactions (L2TX Replay)

Pre-signed L2 transactions broadcast as-is. The original sender's signature is preserved.

```
eth_sendRawTransaction(<rlpEncodedTx>)
```

The `rlpEncodedTx` is the exact bytes from the `executeL2TX` L1 call. The sender must have sufficient L2 balance (bridged from L1). After submission, `mineBlock()` is called to include the transaction.

---

## 5. State Queries (JSON-RPC Methods Used)

The fullnode calls these standard Ethereum JSON-RPC methods on the L2 execution engine:

| Method | Purpose | Parameters |
|--------|---------|------------|
| `eth_blockNumber` | Get current block height | `[]` |
| `eth_getBlockByNumber` | Get block details (especially `stateRoot`) | `["latest", false]` or `["0x0", false]` |
| `eth_chainId` | Get L2 chain ID | `[]` |
| `eth_getCode` | Check if a contract is deployed at an address | `[address, "latest"]` |
| `eth_call` | Simulate a call without state changes | `[{from, to, value, data}, "latest"]` or with state overrides as 3rd param |
| `eth_sendRawTransaction` | Submit a signed transaction to the txpool | `[rawTxHex]` |
| `eth_getTransactionCount` | Get account nonce | `[address, "latest"]` |
| `eth_getBalance` | Get ETH balance (bridge invariant check) | `[address]` |
| `eth_getTransactionReceipt` | Check transaction inclusion and status | `[txHash]` |
| `debug_setHead` | (Legacy, no-op in reth) | `[blockHex]` |

All `eth_*` and `net_*` methods are also proxied from the fullnode RPC server to the execution engine for external consumers (wallets, explorers).

---

## 6. L1 Event Processing: The Three Trigger Types

The fullnode watches two L1 events on the Rollups contract:

- `StateUpdated(uint256 indexed rollupId, bytes32 newStateRoot)` -- owner bypass, no L2 replay
- `L2ExecutionPerformed(uint256 indexed rollupId, bytes32 currentState, bytes32 newState)` -- triggers L2 replay
- `ExecutionConsumed(bytes32 indexed actionHash, Action action)` -- provides action details for replay

Events are sorted by `(blockNumber, logIndex)` and processed in order. For each distinct L1 block containing events, a checkpoint is saved before processing (for reorg recovery).

### 6.1 Trigger Type 1: `executeL2TX` (L2 User Transaction)

**L1 events emitted:** `L2ExecutionPerformed` + `ExecutionConsumed` (with `actionType = L2TX`)

**Detection:** The fullnode fetches the L1 transaction (`eth_getTransaction(l1TxHash)`) and decodes it. If it decodes as `executeL2TX(uint256 rollupId, bytes rlpEncodedTx)`, this path is taken.

**L2 replay sequence:**

```
1. Extract rlpEncodedTx from the decoded L1 calldata
2. Parse the signed L2 transaction to log sender/destination
3. eth_sendRawTransaction(rlpEncodedTx)     -- submit to L2 txpool
4. mineBlock()                               -- produce one L2 block
5. Verify: eth_getBlockByNumber("latest").stateRoot == newState from event
6. Update tracked state
```

**Result:** Exactly one L2 block containing the user's original signed transaction.

### 6.2 Trigger Type 2: Cross-Chain Call (L1 to L2)

**L1 events emitted:** `L2ExecutionPerformed` + `ExecutionConsumed` (with `actionType = CALL`)

**Detection:** The `ExecutionConsumed` event contains an action with `actionType == 0` (CALL). The action struct provides `destination`, `sourceAddress`, `data`, and `value`.

**L2 replay sequence:**

For **plain value transfers** (no calldata, value > 0):
```
1. Ensure source proxy deployed (same as before)
2. sendSystemTx(l2Target, "0x", value)
3. mineBlock(timestamp = L1 block timestamp)
4. Verify state root
```

For **contract calls** (has calldata):
```
1. Extract from ExecutionConsumed action:
   - l2Target     = action.destination
   - sourceAddress = action.sourceAddress
   - callData     = action.data
   - value        = action.value

2. Dry-run: eth_call({from: operator, to: l2Target, data: callData, value})
   to predict the returnData from the destination call.
   (Uses operator as `from` for determinism across L2 clients.)

3. Build a RESULT action from the dry-run output:
   - actionType = RESULT, rollupId, data = abi.encode(bytes(returnData)),
     failed = true if dry-run reverted

4. Hash the RESULT: resultHash = keccak256(abi.encode(resultAction))

5. Build an execution entry: { stateDeltas: [], actionHash: resultHash,
   nextAction: terminal RESULT }

6. sendSystemTx: CrossChainManagerL2.loadExecutionTable([entry])

7. sendSystemTx: CrossChainManagerL2.executeIncomingCrossChainCall(
     destination, value, data, sourceAddress, sourceRollup, scope=[])

8. mineBlock(timestamp = L1 block timestamp)
   // ONE block containing: [loadExecutionTable, executeIncomingCrossChainCall]

9. Verify: eth_getBlockByNumber("latest").stateRoot == newState from event
10. Update tracked state
```

**Key constraint:** `loadExecutionTable` and `executeIncomingCrossChainCall` MUST be in the same L2 block. Both are sent to the txpool without mining, then `mineBlock()` is called once.

**Skip optimization:** If the L2 state root already matches `newState` before replay (because the builder's fullnode pre-executed the call), the replay is skipped entirely.

### 6.3 Trigger Type 3: `postBatch` with Immediate Entries

**L1 events emitted:** `StateUpdated` (for immediate entries with `actionHash == bytes32(0)`)

**Current status:** NOT YET IMPLEMENTED in the fullnode. The `StateUpdated` event handler only updates the tracked state root without performing any L2 replay.

**Expected future behavior:** Each immediate entry in a `postBatch` call would trigger L2 block production with the corresponding state transition.

### 6.4 `StateUpdated` (Owner Bypass)

**L1 event:** `StateUpdated(rollupId, newStateRoot)`

**L2 action:** None. Only the tracked state root is updated in memory. No L2 block is produced. This event is emitted when the rollup owner calls `setStateByOwner()`.

---

## 7. Block Production Rules

These rules ensure deterministic L2 state across all fullnodes:

### Rule 1: One L2 block per L1 state-changing call
Each `executeL2TX` or cross-chain proxy call on L1 produces exactly one L2 block.

### Rule 2: Coinbase
`coinbase = 0x0000000000000000000000000000000000000000` (both builder and event processor). Changing coinbase affects state root because the fee recipient account is "touched" during block processing and receives priority fees. Future: `coinbase = msg.sender` of the L1 caller.

### Rule 3: Timestamp
`timestamp = L1 block timestamp`. The builder simulates with a predicted timestamp (`chooseSimTimestamp()`), then forces the L1 block to use it via `evm_setNextBlockTimestamp`. Event processors read the actual L1 block timestamp and mine L2 blocks with it. Multiple L2 blocks from the same L1 block share the same timestamp.

### Rule 4: Preparation transactions precede user transactions
Proxy deployments and other setup operations appear at the beginning of the block, before the user's transaction.

### Rule 5: Transaction ordering
Within a block: preparation txs (deterministic order) first, then the user tx.

### Rule 6: EIP-1559 gas pricing
Genesis `baseFeePerGas` = 1 gwei (`0x3B9ACA00`), standard EIP-1559 dynamics thereafter. System transactions: `maxFeePerGas = computeNextBaseFee(parentBlock)`, `maxPriorityFeePerGas = 0`. User transactions must set `maxFeePerGas ≥ baseFee`. Base fee is burned, priority fees go to coinbase.

---

## 8. State Verification

### 8.1 State Root Check

After each L2 replay, the fullnode verifies:
```
actual_state = eth_getBlockByNumber("latest", false).stateRoot
expected_state = newState from L2ExecutionPerformed event
assert actual_state == expected_state
```

A mismatch indicates either a fullnode bug or a fraudulent state root posted by a malicious builder.

### 8.2 Bridge Invariant Check

After each execution replay:
```
L1_ether_balance = Rollups.rollups(rollupId).etherBalance
operator_L2_balance = eth_getBalance(operatorAddress)
assert L1_ether_balance + operator_L2_balance == 10^30
```

### 8.3 Sync Check (`isSynced`)

Two conditions must hold:
1. Tracked state root (from processed L1 events) matches L1 contract's state root
2. Actual L2 EVM state root matches the L1 contract's state root

If (1) passes but (2) fails, it indicates fraud.

### 8.4 Action Hash Verification

After each `L2ExecutionPerformed` event with an accompanying `ExecutionConsumed` event, the fullnode recomputes the action hash from the Action struct in the event data:

```
recomputedHash = keccak256(abi.encode(action))
assert recomputedHash == ExecutionConsumed.actionHash (indexed topic)
```

A mismatch indicates the `ExecutionConsumed` event data is inconsistent with its indexed action hash, which should not occur under normal operation.

### 8.5 Return Data Verification

For L1→L2 cross-chain calls, after the fullnode performs its independent `eth_call` dry-run to predict return data, it also fetches the `postBatch` transaction from the same L1 block and decodes the execution entry's `nextAction.data` field. It then compares:

```
claimed_return_data = postBatch_entry.nextAction.data
actual_return_data  = eth_call(from=operator, to=destination, data, value)
assert claimed_return_data == actual_return_data
```

A mismatch indicates the builder generated the proof with incorrect return data in the RESULT action. This does not affect L2 state (the fullnode independently re-derives the correct execution), but it means the L1 entry does not accurately describe the L2 execution result.

---

## 9. Reorg Recovery

### 9.1 L1 Reorg Detection

The fullnode records block hashes for all processed L1 blocks (up to 128 entries). On each poll cycle, it checks the 8 most recent block hashes against the L1 RPC. A mismatch triggers binary search to find the exact fork point.

### 9.2 Recovery Procedure

1. Find the checkpoint (L2 block number + tracked state) just before the fork point
2. Stop the execution engine process
3. Unwind the execution engine to the checkpoint's L2 block:
   ```bash
   reth stage unwind --datadir <reth_dir> --chain <genesis_path> to-block <L2_block_number>
   ```
4. Restart the execution engine
5. Restore tracked state from checkpoint
6. Re-process L1 events from the fork point

If no checkpoint is found (deep reorg), the execution engine data directory is wiped entirely and the engine is restarted from genesis, replaying all events from the deployment block.

An alternative L2 engine must support either:
- An equivalent "unwind to block N" command (deleting blocks after N), OR
- The ability to be fully wiped and restarted from genesis

---

## 10. Data Flow Summary

```
L1 Rollups Contract
    |
    | Events: L2ExecutionPerformed, ExecutionConsumed, StateUpdated
    v
EventProcessor (watches L1, decodes events)
    |
    | Calls: broadcastRawTx(), sendSystemTx(), mineBlock(), getActualStateRoot()
    v
StateManager (L2 engine interface)
    |
    | JSON-RPC: eth_sendRawTransaction, eth_getBlockByNumber, eth_getCode, eth_call
    | Engine API: engine_forkchoiceUpdatedV3, engine_getPayloadV3, engine_newPayloadV3
    v
L2 Execution Engine (reth)
```

---

## 11. Implementation Checklist

An alternative L2 execution engine must support:

- [ ] Custom genesis with pre-funded accounts and pre-deployed contract bytecode
- [ ] `baseFeePerGas = 0x3B9ACA00` (1 gwei) in genesis, standard EIP-1559 dynamics thereafter
- [ ] Accept transactions with `maxPriorityFeePerGas = 0` (system txs use no tip)
- [ ] No auto-mining; blocks produced exclusively via Engine API
- [ ] Engine API v3: `engine_forkchoiceUpdatedV3`, `engine_getPayloadV3`, `engine_newPayloadV3`
- [ ] JWT (HS256) authentication on the Engine API port
- [ ] Configurable `suggestedFeeRecipient` (coinbase) per block
- [ ] Configurable block `timestamp` per block (via payload attributes)
- [ ] Standard JSON-RPC: `eth_blockNumber`, `eth_getBlockByNumber`, `eth_chainId`, `eth_getCode`, `eth_call` (with state overrides), `eth_sendRawTransaction`, `eth_getTransactionCount`, `eth_getBalance`, `eth_getTransactionReceipt`
- [ ] Deterministic state roots given identical genesis + identical transaction sequence + identical block parameters
- [ ] Ability to unwind/revert to a previous block number (for reorg recovery)
- [ ] Persistent storage with exclusive locking (stop before unwind)
- [ ] `stateRoot` field in block headers accessible via `eth_getBlockByNumber`
