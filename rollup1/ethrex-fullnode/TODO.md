# ethrex-fullnode TODOs

## L2→L1 batch block count mismatch edge case

In `replay_batch_execution`, the L2→L1 batch path assumes 3 blocks:
- Block 1 (timestamp=T): proxy deploys + other non-L2→L1 txs
- Block 2 (timestamp=T+1): system preloads (loadExecutionTable)
- Block 3 (timestamp=T+2): L2→L1 user txs

If `block1_count == 0` (no proxy deploys AND no other txs), block 1 is skipped
but the timestamps for blocks 2 and 3 still use T+1 and T+2. This works today
because the builder always produces 3 blocks (proxy deploy is always present on
first L2→L1 call to a given target). But if the builder later optimizes to skip
the proxy deploy block when the proxy already exists, the timestamp structure
would need to match (2 blocks: T and T+1 instead of 3).

The reth-fullnode TypeScript implementation has the same assumption.
