# TODO

- [ ] If an intermediary call between scopes has no matching proof/execution loaded, detect it and revert the entire top-level call (not just the inner scope)
- [ ] Review all scope logic in CrossChainManagerL2 carefully (no state deltas, simplified revert handling — make sure scope navigation still works correctly end-to-end)
- [ ] Clean execution table after block? (expire unconsumed entries)
- [ ] **Review, not clear at all** — Persistent "found" storage slot check via cold/warm access gas cost detection
  - Use a dedicated storage slot keyed by actionHash (maybe alongside some stateRoot)
  - Write two assembly helpers: one to load the storage slot, one to measure the gas cost of loading it
  - If gas cost > 1000 → slot was cold (first access) → valid/not seen before → return true
  - If gas cost ≤ 1000 → slot was warm (already accessed this tx) → duplicate → return false
  - This gives a cheap "was this execution already consumed?" check without needing to delete entries
  - **Caveat**: reverts also revert the access list, so warm/cold detection may not survive reverted sub-calls
- [ ] CrossChainManagerL2: add actionListPending counter
  - Track the number of pending actions loaded in the execution table
  - Decrement on each consumption
  - At end of tx, actionListPending must be 0 (all loaded actions were processed)
