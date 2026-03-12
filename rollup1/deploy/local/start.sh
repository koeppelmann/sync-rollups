#!/bin/bash
# Start all services for local sync-rollups development

set -e

# Set directory paths
# PROJECT_ROOT = git repo root (where foundry.toml lives) — 3 levels up from deploy/local/
PROJECT_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
# ROLLUP_DIR = rollup1/ (where package.json, builder/, reth-fullnode/, etc. live)
ROLLUP_DIR="$PROJECT_ROOT/rollup1"

cd "$PROJECT_ROOT"

# Ports
L1_RPC_PORT=8545
L1_PROXY_PORT=8546

# Public/read-only fullnode (for dashboard + wallets)
PUBLIC_L2_EVM_PORT=9546
PUBLIC_FULLNODE_RPC_PORT=9547
L2_PROXY_PORT=9548

# Private builder fullnode (builder-only)
BUILDER_L2_EVM_PORT=9549
BUILDER_FULLNODE_RPC_PORT=9550
BUILDER_PORT=3200

# Proofer fullnode + proofer service
PROOFER_L2_EVM_PORT=9551
PROOFER_FULLNODE_RPC_PORT=9552
PROOFER_PORT=3300

# Ethrex fullnode (alternative L2 client)
ETHREX_L2_EVM_PORT=9556
ETHREX_ENGINE_PORT=9561
ETHREX_P2P_PORT=30315
ETHREX_STATUS_PORT=3201
ETHREX_BIN="${ETHREX_BIN:-/home/ubuntu/code/ethrex/target/release/ethrex}"

# Kill any existing processes
echo "Stopping existing services..."
pkill -f "reth-fullnode/fullnode.ts" 2>/dev/null || true
pkill -f "builder/builder.ts" 2>/dev/null || true
pkill -f "proofer/proofer.ts" 2>/dev/null || true
pkill -f "rpc-proxy.ts" 2>/dev/null || true
pkill -f "l2-rpc-proxy.ts" 2>/dev/null || true
pkill -f "python3 -m http.server 8080" 2>/dev/null || true
pkill -f "reth node" 2>/dev/null || true
pkill -f "sync-rollups-ethrex-fullnode" 2>/dev/null || true
pkill -f "ethrex --network" 2>/dev/null || true
lsof -i :$L1_RPC_PORT 2>/dev/null | grep LISTEN | awk '{print $2}' | xargs kill 2>/dev/null || true

# Restart Blockscout with fresh databases
echo "Restarting Blockscout instances..."
docker compose -f "$ROLLUP_DIR/blockscout/l1/docker-compose.yml" down -v 2>/dev/null || true
docker compose -f "$ROLLUP_DIR/blockscout/l2/docker-compose.yml" down -v 2>/dev/null || true
sleep 2

# Clear stale L2 state from previous runs (reth databases, sync state)
# State is written at project root by fullnodes (process.cwd())
rm -rf state/

# Create logs directory
mkdir -p "$ROLLUP_DIR/logs"

# Start L1 Anvil
echo "Starting L1 Anvil on port $L1_RPC_PORT..."
anvil --port $L1_RPC_PORT > "$ROLLUP_DIR/logs/anvil.log" 2>&1 &
sleep 2

# Deploy contracts
echo "Deploying contracts..."

# Get admin address
ADMIN=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
ADMIN_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

# Build all contracts (core + demo) so artifacts are available
echo "  Compiling contracts..."
forge build > /dev/null 2>&1
forge build --contracts "$ROLLUP_DIR/scripts/demo_contracts" --out out > /dev/null 2>&1

# Path to compiled contract artifacts
CONTRACTS_OUT=$(realpath out)

# Deploy MockZKVerifier (always-accept verifier for POC)
echo "  Deploying MockZKVerifier..."
VERIFIER_BYTECODE=$(jq -r '.bytecode.object' "$CONTRACTS_OUT/Deploy.s.sol/MockZKVerifier.json")
VERIFIER_ADDR=$(cast send --private-key "$ADMIN_KEY" --rpc-url http://localhost:$L1_RPC_PORT --create "$VERIFIER_BYTECODE" --json | jq -r '.contractAddress')
echo "  MockZKVerifier: $VERIFIER_ADDR"

# Deploy Rollups
echo "  Deploying Rollups..."
ROLLUPS_BYTECODE=$(jq -r '.bytecode.object' "$CONTRACTS_OUT/Rollups.sol/Rollups.json")
ENCODED_ARGS=$(cast abi-encode "constructor(address,uint256)" "$VERIFIER_ADDR" 0)
ROLLUPS_ADDR=$(cast send --private-key "$ADMIN_KEY" --rpc-url http://localhost:$L1_RPC_PORT --create "${ROLLUPS_BYTECODE}${ENCODED_ARGS:2}" --json | jq -r '.contractAddress')
echo "  Rollups: $ROLLUPS_ADDR"

# Compute L2 genesis state root (operator key is derived deterministically from
# rollupsAddress + rollupId + chainId — no secrets needed)
echo ""
echo "Computing L2 genesis state root..."
GENESIS_STATE=$(npm --prefix "$ROLLUP_DIR" exec tsx "$ROLLUP_DIR/scripts/compute-genesis-root.ts" -- \
  --rollups "$ROLLUPS_ADDR" \
  --contracts-out "$CONTRACTS_OUT")
echo "  Genesis state root: $GENESIS_STATE"

# Create rollup 0 with the correct genesis state
echo "  Creating rollup 0 (initialState = genesis state root)..."
cast send --private-key "$ADMIN_KEY" \
  "$ROLLUPS_ADDR" \
  "createRollup(bytes32,bytes32,address)" \
  "$GENESIS_STATE" \
  "0x0000000000000000000000000000000000000000000000000000000000000001" \
  "$ADMIN" \
  --rpc-url http://localhost:$L1_RPC_PORT > /dev/null

DEPLOYMENT_BLOCK=$(cast block-number --rpc-url http://localhost:$L1_RPC_PORT)

# Start public fullnode (read-only for users/UI)
# No private keys needed — operator key is derived from public config
echo "Starting PUBLIC fullnode (read-only)..."
npm --prefix "$ROLLUP_DIR" exec tsx "$ROLLUP_DIR/reth-fullnode/fullnode.ts" -- \
  --rollups "$ROLLUPS_ADDR" \
  --rollup-id 0 \
  --l1-rpc http://localhost:$L1_RPC_PORT \
  --start-block "$DEPLOYMENT_BLOCK" \
  --l2-port $PUBLIC_L2_EVM_PORT \
  --rpc-port $PUBLIC_FULLNODE_RPC_PORT \
  --initial-state "$GENESIS_STATE" \
  --contracts-out "$CONTRACTS_OUT" \
  > "$ROLLUP_DIR/logs/fullnode-public.log" 2>&1 &
sleep 10  # reth needs more startup time than Anvil

# Start private builder fullnode (builder-only)
echo "Starting PRIVATE builder fullnode..."
npm --prefix "$ROLLUP_DIR" exec tsx "$ROLLUP_DIR/reth-fullnode/fullnode.ts" -- \
  --rollups "$ROLLUPS_ADDR" \
  --rollup-id 0 \
  --l1-rpc http://localhost:$L1_RPC_PORT \
  --start-block "$DEPLOYMENT_BLOCK" \
  --l2-port $BUILDER_L2_EVM_PORT \
  --rpc-port $BUILDER_FULLNODE_RPC_PORT \
  --initial-state "$GENESIS_STATE" \
  --contracts-out "$CONTRACTS_OUT" \
  > "$ROLLUP_DIR/logs/fullnode-builder.log" 2>&1 &
sleep 10  # reth needs more startup time than Anvil

# Start proofer fullnode (proofer's own L2 for independent verification)
echo "Starting PROOFER fullnode..."
npm --prefix "$ROLLUP_DIR" exec tsx "$ROLLUP_DIR/reth-fullnode/fullnode.ts" -- \
  --rollups "$ROLLUPS_ADDR" \
  --rollup-id 0 \
  --l1-rpc http://localhost:$L1_RPC_PORT \
  --start-block "$DEPLOYMENT_BLOCK" \
  --l2-port $PROOFER_L2_EVM_PORT \
  --rpc-port $PROOFER_FULLNODE_RPC_PORT \
  --initial-state "$GENESIS_STATE" \
  --contracts-out "$CONTRACTS_OUT" \
  > "$ROLLUP_DIR/logs/fullnode-proofer.log" 2>&1 &
sleep 10  # reth needs more startup time than Anvil

# Start proofer service
echo "Starting proofer..."
npm --prefix "$ROLLUP_DIR" exec tsx "$ROLLUP_DIR/proofer/proofer.ts" -- \
  --rollups "$ROLLUPS_ADDR" \
  --l1-rpc http://localhost:$L1_RPC_PORT \
  --proof-key "$ADMIN_KEY" \
  --fullnode http://localhost:$PROOFER_FULLNODE_RPC_PORT \
  --port $PROOFER_PORT \
  > "$ROLLUP_DIR/logs/proofer.log" 2>&1 &
sleep 3

# Start ethrex fullnode (alternative L2 client)
if [ -f "$ETHREX_BIN" ]; then
  echo "Starting ETHREX fullnode..."
  # Build the Rust fullnode binary
  (cd "$ROLLUP_DIR/ethrex-fullnode" && cargo build --release 2>&1 | tail -1)
  ETHREX_FULLNODE_BIN="$ROLLUP_DIR/ethrex-fullnode/target/release/sync-rollups-ethrex-fullnode"
  if [ -f "$ETHREX_FULLNODE_BIN" ]; then
    "$ETHREX_FULLNODE_BIN" \
      --l1-rpc-url http://localhost:$L1_RPC_PORT \
      --rollups-address "$ROLLUPS_ADDR" \
      --rollup-id 0 \
      --l2-chain-id 10200200 \
      --deployment-block "$DEPLOYMENT_BLOCK" \
      --ethrex-bin "$ETHREX_BIN" \
      --contracts-out-dir "$CONTRACTS_OUT" \
      --datadir ./state/ethrex \
      --l2-rpc-port $ETHREX_L2_EVM_PORT \
      --l2-engine-port $ETHREX_ENGINE_PORT \
      --l2-p2p-port $ETHREX_P2P_PORT \
      --status-rpc-port $ETHREX_STATUS_PORT \
      > "$ROLLUP_DIR/logs/ethrex-fullnode.log" 2>&1 &
    sleep 5
  else
    echo "  WARNING: ethrex fullnode binary not found after build, skipping"
  fi
else
  echo "Skipping ETHREX fullnode (ethrex binary not found at $ETHREX_BIN)"
fi

# Start builder (wired to private builder fullnode + proofer)
echo "Starting builder..."
npm --prefix "$ROLLUP_DIR" exec tsx "$ROLLUP_DIR/builder/builder.ts" -- \
  --rollups "$ROLLUPS_ADDR" \
  --rollup-id 0 \
  --l1-rpc http://localhost:$L1_RPC_PORT \
  --admin-key "$ADMIN_KEY" \
  --fullnode http://localhost:$BUILDER_FULLNODE_RPC_PORT \
  --proofer http://localhost:$PROOFER_PORT \
  --port $BUILDER_PORT \
  > "$ROLLUP_DIR/logs/builder.log" 2>&1 &
sleep 3

# Start L1 RPC Proxy
echo "Starting L1 RPC Proxy..."
npm --prefix "$ROLLUP_DIR" exec tsx "$ROLLUP_DIR/builder/rpc-proxy.ts" -- \
  --port $L1_PROXY_PORT \
  --rpc http://localhost:$L1_RPC_PORT \
  --builder http://localhost:$BUILDER_PORT \
  --rollups "$ROLLUPS_ADDR" \
  --rollup-id 0 \
  > "$ROLLUP_DIR/logs/l1-proxy.log" 2>&1 &
sleep 1

# Start L2 RPC Proxy
echo "Starting L2 RPC Proxy..."
npm --prefix "$ROLLUP_DIR" exec tsx "$ROLLUP_DIR/builder/l2-rpc-proxy.ts" -- \
  --port $L2_PROXY_PORT \
  --rpc http://localhost:$PUBLIC_FULLNODE_RPC_PORT \
  --builder http://localhost:$BUILDER_PORT \
  > "$ROLLUP_DIR/logs/l2-proxy.log" 2>&1 &
sleep 1

# Start UI server
echo "Starting dashboard..."
python3 -m http.server 8080 --directory "$ROLLUP_DIR/ui" > "$ROLLUP_DIR/logs/ui.log" 2>&1 &
sleep 1

# Bridge ETH from L1 to L2 for test accounts
BRIDGE_AMOUNT="10ether"
BRIDGE_AMOUNT_WEI=$(cast to-wei 10)
ACCOUNT1=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
ACCOUNT1_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
ACCOUNT2=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
ACCOUNT2_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d

echo ""
echo "Bridging $BRIDGE_AMOUNT to test accounts on L2..."

bridge_eth() {
  local SENDER=$1
  local SENDER_KEY=$2
  local AMOUNT=$3
  local AMOUNT_WEI=$4

  # 1. Ask builder to prepare L1→L2 call with deferMine=true.
  # This sends postBatch to mempool (automine off) but does NOT mine.
  # We'll co-mine the user's tx + postBatch in the same block below.
  local PREPARE_RESULT=$(curl -s -X POST http://localhost:$BUILDER_PORT/prepare-l1-call \
    -H "Content-Type: application/json" \
    -d "{\"l2Target\":\"$SENDER\",\"value\":\"$AMOUNT_WEI\",\"data\":\"0x\",\"sourceAddress\":\"$SENDER\",\"deferMine\":true}")

  local SUCCESS=$(echo "$PREPARE_RESULT" | jq -r '.success')
  if [ "$SUCCESS" != "true" ]; then
    echo "  Failed to prepare bridge for $SENDER: $(echo "$PREPARE_RESULT" | jq -r '.error')"
    return 1
  fi

  local PROXY_ADDR=$(echo "$PREPARE_RESULT" | jq -r '.proxyAddress')
  echo "  Sending $AMOUNT via proxy $PROXY_ADDR..."

  # 2. Get the pending nonce (accounts for the builder's postBatch in mempool)
  local PENDING_NONCE=$(cast nonce "$SENDER" --block pending --rpc-url http://localhost:$L1_RPC_PORT)

  # 3. Sign and submit the user's tx to Anvil's mempool (automine is still off)
  local SIGNED_TX=$(cast mktx --private-key "$SENDER_KEY" \
    "$PROXY_ADDR" \
    --value "$AMOUNT" \
    --gas-limit 500000 \
    --nonce "$PENDING_NONCE" \
    --rpc-url http://localhost:$L1_RPC_PORT)

  # Submit raw tx (non-blocking — goes to mempool)
  curl -s http://localhost:$L1_RPC_PORT -X POST \
    -H "Content-Type: application/json" \
    -d "{\"jsonrpc\":\"2.0\",\"method\":\"eth_sendRawTransaction\",\"params\":[\"$SIGNED_TX\"],\"id\":1}" > /dev/null

  # 4. Mine both postBatch + user tx in the same block, then restore automine
  curl -s http://localhost:$L1_RPC_PORT -X POST \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","method":"evm_mine","params":[],"id":2}' > /dev/null
  curl -s http://localhost:$L1_RPC_PORT -X POST \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","method":"evm_setAutomine","params":[true],"id":3}' > /dev/null

  echo "  Bridged $AMOUNT to $SENDER on L2"
}

bridge_eth "$ACCOUNT1" "$ACCOUNT1_KEY" "$BRIDGE_AMOUNT" "$BRIDGE_AMOUNT_WEI"
sleep 20
bridge_eth "$ACCOUNT2" "$ACCOUNT2_KEY" "$BRIDGE_AMOUNT" "$BRIDGE_AMOUNT_WEI"
sleep 20

echo "Bridge complete."

# Deploy Counter and Logger on L1 and L2
echo ""
echo "Deploying test contracts..."

COUNTER_BYTECODE=$(jq -r '.bytecode.object' "$CONTRACTS_OUT/Counter.sol/Counter.json")
LOGGER_BYTECODE=$(jq -r '.bytecode.object' "$CONTRACTS_OUT/Logger.sol/Logger.json")

# L1 deployments (direct to Anvil)
echo "  Deploying Counter on L1..."
L1_COUNTER=$(cast send --private-key "$ADMIN_KEY" \
  --rpc-url http://localhost:$L1_RPC_PORT \
  --create "$COUNTER_BYTECODE" --json | jq -r '.contractAddress')
echo "  Counter (L1): $L1_COUNTER"

echo "  Deploying Logger on L1..."
L1_LOGGER=$(cast send --private-key "$ADMIN_KEY" \
  --rpc-url http://localhost:$L1_RPC_PORT \
  --create "$LOGGER_BYTECODE" --json | jq -r '.contractAddress')
echo "  Logger (L1):  $L1_LOGGER"

# L2 deployments (through L2 proxy → builder → L1 → fullnode replay)
# Use Account #2 for L2 deployments to avoid address collisions with L2 genesis state.
# Account #1's early nonces on L2 produce addresses that collide with CrossChainManagerL2.
L2_DEPLOYER=$ACCOUNT2
L2_DEPLOYER_KEY=$ACCOUNT2_KEY

# Deploy Counter on L2 (via bridge)
echo "  Deploying Counter on L2 (via bridge)..."
L2_COUNTER_RESULT=$(cast send --private-key "$L2_DEPLOYER_KEY" \
  --rpc-url http://localhost:$L2_PROXY_PORT \
  --timeout 30 --gas-limit 500000 \
  --create "$COUNTER_BYTECODE" --json 2>&1)
L2_COUNTER=$(echo "$L2_COUNTER_RESULT" | jq -r '.contractAddress // empty')
if [ -n "$L2_COUNTER" ]; then
  echo "  Counter (L2): $L2_COUNTER"
else
  echo "  Counter (L2): deployment submitted (check logs)"
fi

# Wait for the Counter batch to fully propagate through L1 → builder fullnode → public fullnode
# before deploying Logger (otherwise nonce/state mismatch)
echo "  Waiting for L2 state to sync..."
sleep 20

# Deploy Logger on L2 (via bridge)
echo "  Deploying Logger on L2 (via bridge)..."
L2_LOGGER_RESULT=$(cast send --private-key "$L2_DEPLOYER_KEY" \
  --rpc-url http://localhost:$L2_PROXY_PORT \
  --timeout 30 --gas-limit 500000 \
  --create "$LOGGER_BYTECODE" --json 2>&1)
L2_LOGGER=$(echo "$L2_LOGGER_RESULT" | jq -r '.contractAddress // empty')
if [ -n "$L2_LOGGER" ]; then
  echo "  Logger (L2):  $L2_LOGGER"
else
  echo "  Logger (L2):  deployment submitted (check logs)"
fi
sleep 5

echo "Contract deployment complete."

# Start Blockscout explorers
echo ""
echo "Starting Blockscout explorers..."
docker compose -f "$ROLLUP_DIR/blockscout/l1/docker-compose.yml" up -d 2>/dev/null
docker compose -f "$ROLLUP_DIR/blockscout/l2/docker-compose.yml" up -d 2>/dev/null
echo "  Blockscout L1: http://localhost:4000 (API: 4010)"
echo "  Blockscout L2: http://localhost:4001 (API: 4011)"

# Verify contracts on Blockscout
echo ""
echo "Verifying contracts on Blockscout..."

# Wait for Blockscout instances to be ready (indexing must catch up)
wait_for_blockscout() {
  local URL=$1
  local NAME=$2
  local MAX_WAIT=120
  local WAITED=0
  echo "  Waiting for $NAME to be ready..."
  while [ $WAITED -lt $MAX_WAIT ]; do
    local STATUS=$(curl -s "${URL}?module=block&action=eth_block_number" | jq -r '.result // empty' 2>/dev/null)
    if [ -n "$STATUS" ] && [ "$STATUS" != "null" ] && [ "$STATUS" != "0x0" ]; then
      echo "  $NAME is ready (block: $STATUS)"
      break
    fi
    sleep 5
    WAITED=$((WAITED + 5))
  done
  if [ $WAITED -ge $MAX_WAIT ]; then
    echo "  WARNING: $NAME did not become ready in ${MAX_WAIT}s, skipping verification"
    return 1
  fi
  return 0
}

# Derive operator address (same deterministic derivation as compute-genesis-root.ts)
OPERATOR_KEY=$(cast keccak256 $(cast abi-encode --packed "f(string,address,uint256,uint256)" "sync-rollups-operator" "$ROLLUPS_ADDR" 0 31337))
OPERATOR_ADDR=$(cast wallet address "$OPERATOR_KEY")
echo "  Operator address: $OPERATOR_ADDR"

# Symlink demo contracts into src/ for forge verification
ln -sf ../rollup1/scripts/demo_contracts/Counter.sol src/Counter.sol
ln -sf ../rollup1/scripts/demo_contracts/Logger.sol src/Logger.sol

verify_contract() {
  local ADDR=$1
  local CONTRACT=$2
  local API_URL=$3
  shift 3
  echo "  Verifying $CONTRACT at $ADDR..."
  GNOSISSCAN_API_KEY=dummy forge verify-contract \
    --verifier blockscout \
    --verifier-url "$API_URL" \
    "$@" \
    "$ADDR" "$CONTRACT" 2>&1 | tail -1
}

L1_API="http://localhost:4010/api/"
L2_API="http://localhost:4011/api/"

ROLLUPS_CONSTRUCTOR_ARGS=$(cast abi-encode "constructor(address,uint256)" "$VERIFIER_ADDR" 0)
CCM_CONSTRUCTOR_ARGS=$(cast abi-encode "constructor(uint256,address)" 0 "$OPERATOR_ADDR")

if wait_for_blockscout "$L1_API" "Blockscout L1"; then
  verify_contract "$VERIFIER_ADDR" "script/Deploy.s.sol:MockZKVerifier" "$L1_API"
  verify_contract "$ROLLUPS_ADDR" "src/Rollups.sol:Rollups" "$L1_API" --constructor-args "$ROLLUPS_CONSTRUCTOR_ARGS"
  verify_contract "$L1_COUNTER" "src/Counter.sol:Counter" "$L1_API"
  verify_contract "$L1_LOGGER" "src/Logger.sol:Logger" "$L1_API"
fi

if wait_for_blockscout "$L2_API" "Blockscout L2"; then
  # CrossChainManagerL2 is deployed at genesis at the Rollups address on L2
  verify_contract "$ROLLUPS_ADDR" "src/CrossChainManagerL2.sol:CrossChainManagerL2" "$L2_API" --constructor-args "$CCM_CONSTRUCTOR_ARGS"
  if [ -n "$L2_COUNTER" ]; then
    verify_contract "$L2_COUNTER" "src/Counter.sol:Counter" "$L2_API"
  fi
  if [ -n "$L2_LOGGER" ]; then
    verify_contract "$L2_LOGGER" "src/Logger.sol:Logger" "$L2_API"
  fi
fi

# Clean up symlinks
rm -f src/Counter.sol src/Logger.sol

echo "Contract verification complete."

# Write environment-specific config files for the UI
echo ""
echo "Writing UI config files..."
HOST_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
[ -z "$HOST_IP" ] && HOST_IP="localhost"

cat > "$ROLLUP_DIR/ui/settings.anvil.json" <<EOF
{
  "l1Rpc": "http://${HOST_IP}:${L1_PROXY_PORT}",
  "l2Rpc": "http://${HOST_IP}:${PUBLIC_FULLNODE_RPC_PORT}",
  "l2EvmRpc": "http://${HOST_IP}:${L2_PROXY_PORT}",
  "builderUrl": "http://${HOST_IP}:${BUILDER_PORT}",
  "prooferUrl": "http://${HOST_IP}:${PROOFER_PORT}",
  "ethrexRpc": "http://${HOST_IP}:${ETHREX_STATUS_PORT}",
  "ethrexEvmRpc": "http://${HOST_IP}:${ETHREX_L2_EVM_PORT}",
  "blockscoutL1Url": "http://${HOST_IP}:4010",
  "blockscoutL2Url": "http://${HOST_IP}:4011",
  "rollupsAddress": "${ROLLUPS_ADDR}",
  "rollupId": "0",
  "deploymentBlock": "${DEPLOYMENT_BLOCK}"
}
EOF
# Backward compat: symlink settings.dev.json → settings.anvil.json
ln -sf settings.anvil.json "$ROLLUP_DIR/ui/settings.dev.json"
echo "  Wrote ui/settings.anvil.json"

# Print summary
echo ""
echo "============================================"
echo "sync-rollups local environment started!"
echo "============================================"
echo ""
echo "Contracts:"
echo "  MockZKVerifier: $VERIFIER_ADDR"
echo "  Rollups:         $ROLLUPS_ADDR"
echo "  Deployment block: $DEPLOYMENT_BLOCK"
echo ""
echo "  Counter (L1): $L1_COUNTER"
echo "  Logger  (L1): $L1_LOGGER"
echo "  Counter (L2): ${L2_COUNTER:-pending}"
echo "  Logger  (L2): ${L2_LOGGER:-pending}"
echo ""
echo "L2 Genesis:"
echo "  State root: $GENESIS_STATE"
echo ""
echo "Services:"
echo "  L1 Anvil:               http://localhost:$L1_RPC_PORT"
echo "  L1 RPC Proxy:           http://localhost:$L1_PROXY_PORT  ← Connect wallet here for L1"
echo "  Public L2 EVM:          http://localhost:$PUBLIC_L2_EVM_PORT"
echo "  Public Fullnode RPC:    http://localhost:$PUBLIC_FULLNODE_RPC_PORT  ← Dashboard reads"
echo "  L2 RPC Proxy:           http://localhost:$L2_PROXY_PORT  ← Connect wallet here for L2"
echo "  Builder Private L2 EVM: http://localhost:$BUILDER_L2_EVM_PORT  (internal)"
echo "  Builder Fullnode RPC:   http://localhost:$BUILDER_FULLNODE_RPC_PORT  (internal)"
echo "  Builder API:            http://localhost:$BUILDER_PORT"
echo "  Proofer L2 EVM:         http://localhost:$PROOFER_L2_EVM_PORT  (internal)"
echo "  Proofer Fullnode RPC:   http://localhost:$PROOFER_FULLNODE_RPC_PORT  (internal)"
echo "  Proofer API:            http://localhost:$PROOFER_PORT"
echo "  Ethrex L2 EVM:          http://localhost:$ETHREX_L2_EVM_PORT"
echo "  Ethrex Status RPC:      http://localhost:$ETHREX_STATUS_PORT"
echo "  Dashboard:              http://localhost:8080"
echo "  Blockscout L1:          http://localhost:4000"
echo "  Blockscout L2:          http://localhost:4001"
echo ""
echo "Test accounts (Anvil defaults):"
echo "  Account #1: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 (admin)"
echo "  Account #2: 0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
echo ""
echo "Wallet Networks:"
echo "  L1 'Anvil Local':  ChainId 31337,    RPC http://localhost:$L1_PROXY_PORT"
echo "  L2 'Sync Rollup':  ChainId 10200200, RPC http://localhost:$L2_PROXY_PORT"
echo ""
echo "Note: Test accounts have been bridged with $BRIDGE_AMOUNT each."
echo ""
echo "Logs: $ROLLUP_DIR/logs/"
echo ""
echo "To stop:"
echo "  pkill -f 'reth-fullnode|builder|proofer|reth|anvil|http.server|rpc-proxy|ethrex'"
echo "  docker compose -f $ROLLUP_DIR/blockscout/l1/docker-compose.yml down"
echo "  docker compose -f $ROLLUP_DIR/blockscout/l2/docker-compose.yml down"
