# ui

Web dashboard for monitoring and interacting with the rollup. Single-page app served via `python3 -m http.server 8080`.

- `index.html` — dashboard UI: sync status, L2 block explorer, contract interaction forms, L1→L2 bridge, cross-chain call submission with hint registration
- `environments.json` — registry of available environments (anvil, devnet, etc.)
- `settings.{env}.json` — per-environment RPC endpoints, contract addresses, deployment block
- `wallets.{env}.json` — per-environment test wallet configs
