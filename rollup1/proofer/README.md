# proofer

Verifies state transitions and signs proofs. The proofer's sole role is to attest that a claimed transition `stateA → stateB` is valid — it is indifferent to what the current rollup state is, and whether the transition is ultimately used on L1.

## Interface

`POST /prove {entries, rootActions, timestamp, hints?, batchSignedTxs?, sourceProxies?}`

Each entry claims a state transition with deltas. The proofer re-executes the transition on its own L2 fullnode and checks that the resulting state root matches. On success, returns a signed proof. On failure, returns an error.

## State management

To verify a transition `A → B`, the proofer's L2 must be at state `A`. If it isn't, the requester provides `hints` — a sequence of `{signedTx, timestamp}` that advance the L2 to `A`. The proofer applies these without validating them as legitimate rollup transitions; they are solely a mechanism to reach the required starting state.

**TODO:** The proofer currently keeps simulation state on success (assuming the proven transition will be used). It should instead always roll back after signing, since it may receive multiple independent requests from the same base state (e.g., prove `A→B1`, `A→B2`, `A→B3` — all valid, only one will be used). The requester should provide hints for each request to bring the proofer to the required starting state.

## Key file

- `proofer.ts` — HTTP API (port 3300), verification logic, rollback via `reth stage unwind`
