# ethrex-fullnode

L2 fullnode implementation in Rust, using ethrex as the execution engine. Watches L1 events on the Rollups contract and replays them on a local ethrex instance via the Engine API, producing deterministic L2 blocks. The `event_processor.rs` handles L1 event decoding and L2 replay logic, `engine.rs` manages block production, and `genesis.rs` constructs the deterministic L2 genesis state. Exposes a status JSON-RPC endpoint for sync queries and proxies standard `eth_*` calls to ethrex. See `STATE_TRANSITION_SPEC.md` and `L2_EXECUTION_ENGINE_SPEC.md` for the full specification.
