# Rollup 1

A concrete rollup implementation built on the generic `src/` contracts. Uses reth (or ethrex) as the L2 execution engine, with a builder that processes transactions and a proofer that attests to state transitions.

## Architecture

```
L1 Chain
  └── Rollups.sol (src/)
        ├── postBatch (state commitments + proof)
        ├── executeL2TX (user L2 transactions)
        └── executeCrossChainCall (L1→L2 calls via proxy)

L2 Chain (reth or ethrex)
  └── CrossChainManagerL2 (genesis contract)
        ├── loadExecutionTable (system)
        └── executeIncomingCrossChainCall
```

## Components

| Directory | Description |
|-----------|-------------|
| `builder/` | Processes L2 and L1→L2 transactions, simulates execution, requests proofs, submits bundles to L1 |
| `proofer/` | Verifies state transitions independently and signs proofs |
| `reth-fullnode/` | TypeScript L2 fullnode using reth as execution engine |
| `ethrex-fullnode/` | Rust L2 fullnode using ethrex as execution engine |
| `deploy/` | Deployment and startup scripts per L1 environment |
| `contracts/` | Test and demo Solidity contracts |
| `scripts/` | Utility and demo TypeScript scripts |
| `blockscout/` | Docker configs for L1/L2 block explorers |
| `ui/` | Web dashboard for interacting with the rollup |

## Specs

- [STATE_TRANSITION_SPEC.md](STATE_TRANSITION_SPEC.md) — How L2 state is deterministically derived from L1
- [L2_EXECUTION_ENGINE_SPEC.md](L2_EXECUTION_ENGINE_SPEC.md) — L2 block production, mining, and system transaction details
