# reth-fullnode

L2 fullnode implementation using reth as the execution engine. Watches L1 events on the Rollups contract and replays them on a local reth instance via the Engine API, producing deterministic L2 blocks. The `event-processor.ts` handles L1 event decoding and L2 replay logic, while `state-manager.ts` manages reth lifecycle, block production, and operator transactions. The `rpc-server.ts` exposes a JSON-RPC interface for sync status queries and proxies standard `eth_*` calls to reth. See `STATE_TRANSITION_SPEC.md` and `L2_EXECUTION_ENGINE_SPEC.md` for the full specification.
