# scripts

Test scenarios, deployment utilities, and demo contracts.

- `compute-genesis-root.ts` — computes the deterministic L2 genesis state root for a given rollup config (used by deployment scripts)
- `demo_contracts/` — Solidity contracts (Counter, Logger, SimpleToken, WETH9, Uniswap arbitrage contracts) used by the test scenarios
- `atomic-arb.ts` — cross-chain atomic arbitrage scenario
- `token-bridge-uniswap.ts` — ERC20 bridge + Uniswap deployment
- `fuzz-test.ts`, `fuzz-batch-test.ts`, `fuzz-deterministic.ts` — fuzz tests for batch submission determinism
