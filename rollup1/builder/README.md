# builder

Orchestrates and processes L2 transactions and L1 transactions that include calls into L2.

## L2 transactions

The L2 RPC proxy (`l2-rpc-proxy.ts`, port 9548) intercepts `eth_sendRawTransaction`:

1. Forward signed L2 tx to builder
2. Builder simulates on private fullnode → state delta
3. `POST /prove {entries, rootActions, timestamp, batchSignedTxs}` → proofer returns signed proof
4. Bundle to L1 (must land in same block, in order):
   - `Rollups.postBatch(entries, proof)` — commits state delta
   - `Rollups.executeL2TX(rollupId, rlpEncodedTx)` — replays original signed tx on-chain
5. If not included, re-simulate and retry

## L1→L2 cross-chain calls

The L1 RPC proxy (`rpc-proxy.ts`, port 8546) intercepts `eth_sendRawTransaction`:

1. Simulate L1 tx — check if any CrossChainProxy is hit (deployed or pre-announced via `POST /register-hint {l2TargetAddress, rollupId}` — proxy address derived deterministically)
2. No proxy hit → forward directly to L1
3. Proxy hit →
   - Simulate L2 side on private fullnode (iterative for nested cross-chain calls)
   - `POST /prove {entries, rootActions, timestamp, hints?, sourceProxies?}` → proofer returns signed proof
   - Bundle to L1 (must land in same block, in order):
     - `Rollups.createCrossChainProxy(l2Target, rollupId)` — if proxy not yet deployed
     - `Rollups.postBatch(entries, proof)` — pre-loads execution table
     - User's original L1 tx — hits the proxy, consumes the entry
   - Bundle only valid for one block — if not included, re-simulate and retry

## L2→L1 cross-chain calls

User submits a signed L2 tx that (directly or indirectly) calls an L2 proxy targeting L1.

### Prerequisites

**Builder L2 EOA**: The builder controls an EOA on L2 with sufficient balance to deploy proxies (gas costs). On startup, the builder funds this EOA by performing an L1→L2 value transfer through the cross-chain proxy mechanism (sending ETH/xDAI to its own L2 address via a proxy call with empty calldata).

**Hint registration**: L2 proxy addresses are deterministic (CREATE2) but the builder cannot distinguish an undeployed proxy from any other empty address. The user/UI must register hints before submitting the L2 tx:

`POST /register-l2-hint {l1Target}`

The builder computes the deterministic L2 proxy address for `(l1Target, rollupId=0)` and stores it in an in-memory hint table. Multiple hints can be registered; they persist until consumed or the builder restarts. Returns `{proxyAddress}` so the user knows which address to call.

### Flow

**Example**: EOA on L2 calls `increment()` on L1 Counter.

1. User/UI registers hint: `POST /register-l2-hint {l1Target: "0xCounter"}`
   - Builder computes L2 proxy address, stores in hint table
   - Returns `{proxyAddress: "0x..."}`
2. User signs L2 tx calling the proxy address with `increment()` calldata
3. User submits: `POST /submit {sourceChain: "L2", signedTx}`
4. Builder checks if `tx.to` is in the hint table → match found, this is an L2→L1 call
5. If proxy not yet deployed on L2, builder signs a proxy deployment tx from its L2 EOA:
   - Calls `CrossChainManagerL2.createCrossChainProxy(l1Target, 0)` on L2
   - This is a regular L2 tx (NOT a system tx), builder pays gas
6. Builder simulates as two separate L2 blocks (matching Rule 1: one L2 block per L1 state-changing call):
   - Block N: proxy deployment tx → state S0 → S1
   - Block N+1: user's signed tx (calls the now-deployed proxy) → state S1 → S2
7. Builder plans execution entries:
   - Entry 1 (deferred): `L2TX(deployTx)` → `RESULT` (proxy deployment, S0 → S1)
   - Entry 2 (deferred): `L2TX(userTx)` → `CALL` on L1 (user's cross-chain call, S1 → S2)
   - Entry 3 (deferred): `RESULT` → `RESULT` (L1 call result, identity or ether delta)
8. Builder requests proof: `POST /prove {entries, rootActions, timestamp}`
   - Proofer replays each L2TX in its own block, verifies state transitions match
9. Bundle to L1 (must land in same block, in order):
   - `Rollups.createCrossChainProxy(l1Target, l1ChainId)` — L1 alias proxy, if not yet deployed
   - `Rollups.postBatch(entries, proof)` — pre-loads execution table
   - `Rollups.executeL2TX(rollupId, deployTx)` — replays proxy deployment
   - `Rollups.executeL2TX(rollupId, userTx)` — replays user tx, triggers scope resolution and L1 call

### Event processor replay

Each `executeL2TX` on L1 emits `L2ExecutionPerformed` + `ExecutionConsumed`. Event processors on all fullnodes replay each L2TX in its own L2 block. The proxy deployment tx replays first, making the proxy available for the subsequent user tx replay.

### L1 alias proxy

For scope resolution during `executeL2TX` on L1, an "alias proxy" for the L1 target is needed with `originalRollupId = L1 chain ID`. If not yet deployed, the builder includes `Rollups.createCrossChainProxy(l1Target, l1ChainId)` in the L1 bundle before `postBatch`.

### Proxy caching

Once a proxy is deployed on L2 (confirmed via L1 event replay on all fullnodes), future L2→L1 calls to the same L1 target skip the deployment tx. The builder checks `eth_getCode` at the proxy address before deciding whether to include a deployment tx. When skipped, only a single `executeL2TX` (the user tx) is needed.

## Key files

- `builder.ts` — core HTTP API (port 3200): simulation, nonce management, L1 submission
- `execution-planner.ts` — builds execution entries and state deltas from simulation results
- `proof-generator.ts` — sends prove requests to the proofer, collects signatures
- `bundle-submitter.ts` — submits ordered L1 transaction bundles (Flashbots on mainnet)
- `rpc-proxy.ts` — L1 RPC proxy, hint registration, cross-chain call interception
- `l2-rpc-proxy.ts` — L2 RPC proxy, routes user L2 transactions through the builder
