# deploy

Deployment scripts and environment configs. Each subdirectory targets a different L1.

- `local/start.sh` — full local environment: Anvil L1, three reth fullnodes (public, builder, proofer), ethrex fullnode, builder, proofer, RPC proxies, Blockscout, dashboard. Deploys contracts, bridges test ETH, verifies on Blockscout.
- `local/.env` — environment variables for the local deployment
- `local/start-ethrex-fullnode.sh` — standalone ethrex fullnode startup (for running separately)
