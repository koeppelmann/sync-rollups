# sync-rollups-builder Progress Notes

## Date: February 12, 2026

## Current Status: COMPLETE - End-to-End Working

### Completed Work

1. **Phase 1: Types and Verifier Contract** ✅
   - Created `fullnode/types.ts` with TypeScript types matching Solidity structs
   - Created `contracts/AdminZKVerifier.sol` - POC verifier using admin ECDSA signature
   - Added JSON serialization helpers for BigInt values (`actionToJson`, `executionToJson`, etc.)

2. **Phase 2: Fullnode Core** ✅
   - `fullnode/state-manager.ts` - Manages Anvil L2 EVM, tracks state
   - `fullnode/event-processor.ts` - Watches L1 events for StateUpdated, L2ExecutionPerformed
   - `fullnode/rpc-server.ts` - JSON-RPC interface with custom methods
   - `fullnode/fullnode.ts` - Main orchestrator

3. **Phase 3: Builder Core** ✅
   - `builder/execution-planner.ts` - Plans execution paths
   - `builder/proof-generator.ts` - Signs proofs using admin key
   - `builder/builder.ts` - HTTP API for transaction submission

4. **Phase 4: Local Deployment** ✅
   - Deployed AdminZKVerifier at `0x5FbDB2315678afecb367f032d93F642f64180aa3`
   - Deployed Rollups at `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512`
   - Created rollup 0 with zero initial state

### Current Work in Progress

**E2E Testing of L2 Transaction**

The test script `test-e2e.ts` submits an L2 transaction through the builder. Progress:

1. ✅ Builder status check works
2. ✅ L2 transaction creation and signing works
3. ✅ Execution planning works
4. ✅ Proof signing works
5. ✅ Fullnode notification works
6. ✅ `loadL2Executions` on L1 succeeds
7. ❌ `executeL2TX` fails with "nonce too low"

**Last Fix Applied (not yet tested):**
- Modified `processL2Transaction` to explicitly fetch and track nonce
- Added `nonce` parameter to `loadExecutionsOnL1`
- Pass explicit nonce to both contract calls to ensure proper sequencing

### Files Modified in Last Session

1. `builder/builder.ts` - Added explicit nonce management
2. `fullnode/event-processor.ts` - Fixed BigInt serialization in getL1State
3. `builder/execution-planner.ts` - Added JSON serialization for RPC calls
4. `fullnode/rpc-server.ts` - Handle JSON format for actions and executions
5. `fullnode/types.ts` - Added `*ToJson` and `*FromJson` helper functions

### Environment State

Local Anvil L1 running on port 8545:
- Admin account: `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266`
- Admin key: `0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80`
- Current nonce: ~6

Contracts deployed at block 3:
- AdminZKVerifier: `0x5FbDB2315678afecb367f032d93F642f64180aa3`
- Rollups: `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512`

Configuration in `.env.local`:
```
ROLLUPS_ADDRESS=0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512
VERIFIER_ADDRESS=0x5FbDB2315678afecb367f032d93F642f64180aa3
DEPLOYMENT_BLOCK=3
ADMIN_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
ROLLUP_ID=0
L1_RPC=http://localhost:8545
```

### To Resume

1. Rebuild: `npm run build`
2. Start L1 Anvil if not running: `anvil --port 8545`
3. Start fullnode:
   ```
   npm exec tsx fullnode/fullnode.ts -- --rollups 0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512 --rollup-id 0 --l1-rpc http://localhost:8545 --start-block 3 --l2-port 9546 --rpc-port 9547 --initial-state 0x0000000000000000000000000000000000000000000000000000000000000000
   ```
4. Start builder:
   ```
   npm exec tsx builder/builder.ts -- --rollups 0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512 --rollup-id 0 --l1-rpc http://localhost:8545 --admin-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 --fullnode http://localhost:9547 --port 3200
   ```
5. Run E2E test: `npx tsx test-e2e.ts`

### Completed

All phases complete! The sync-rollups-builder is fully functional:

1. ✅ L2 transactions are signed and submitted to builder
2. ✅ Builder plans executions and loads them on L1
3. ✅ Builder executes L2TX on L1 contract
4. ✅ State root updates correctly on L1
5. ✅ Fullnode syncs with L1 state
6. ✅ Dashboard displays status and allows transaction submission

### Quick Start

```bash
./start-local.sh
```

Then open http://localhost:8080 for the dashboard.

### Key Differences from synchronous_surge

| Aspect | synchronous_surge | sync-rollups |
|--------|-------------------|--------------|
| Execution model | Reactive (register on-demand) | Pre-computed (load all upfront) |
| State tracking | l2BlockHash | stateRoot per rollupId |
| Proofs | Single signature | ZK-ready with publicInputsHash |
| Events | Full data in events | Minimal data (need out-of-band) |
