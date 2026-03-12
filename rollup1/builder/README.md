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

## L1 transactions (cross-chain calls)

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

## Key files

- `builder.ts` — core HTTP API (port 3200): simulation, nonce management, L1 submission
- `execution-planner.ts` — builds execution entries and state deltas from simulation results
- `proof-generator.ts` — sends prove requests to the proofer, collects signatures
- `bundle-submitter.ts` — submits ordered L1 transaction bundles (Flashbots on mainnet)
- `rpc-proxy.ts` — L1 RPC proxy, hint registration, cross-chain call interception
- `l2-rpc-proxy.ts` — L2 RPC proxy, routes user L2 transactions through the builder
