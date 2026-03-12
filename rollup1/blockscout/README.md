# blockscout

Docker Compose configs for Blockscout block explorer instances.

- `l1/docker-compose.yml` — L1 explorer (port 4000, API 4010)
- `l2/docker-compose.yml` — L2 explorer (port 4001, API 4011)

Started and stopped by `deploy/local/start.sh`. Contract verification uses `forge verify-contract --verifier blockscout`.
