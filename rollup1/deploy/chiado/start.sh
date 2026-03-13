#!/bin/bash
# Start sync-rollups services for Chiado L1 deployment
# L1 = Chiado (remote), L2 = local reth instances

set -e

PROJECT_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
ROLLUP_DIR="$PROJECT_ROOT/rollup1"
DEPLOY_DIR="$(dirname "$0")"

cd "$PROJECT_ROOT"

# Load environment
source "$DEPLOY_DIR/.env"

# Contract addresses on Chiado L1
L1_COUNTER=0x474F7b4B7764d3c01dCe34E1f3eE2b25bbF33e9F
L1_LOGGER=0x5e280350D5Fa42F369d9295062660D788Ea80844

# Ports (chiado services use different ports from local Anvil)
PUBLIC_L2_EVM_PORT=9646
PUBLIC_FULLNODE_RPC_PORT=9647
L2_PROXY_PORT=9648

BUILDER_L2_EVM_PORT=9649
BUILDER_FULLNODE_RPC_PORT=9650
BUILDER_PORT=3210

PROOFER_L2_EVM_PORT=9651
PROOFER_FULLNODE_RPC_PORT=9652
PROOFER_PORT=3310

CONTRACTS_OUT="$(realpath out)"

# Kill existing chiado services
echo "Stopping existing Chiado services..."
pkill -f "fullnode-chiado" 2>/dev/null || true
pkill -f "builder-chiado" 2>/dev/null || true
pkill -f "proofer-chiado" 2>/dev/null || true
pkill -f "l2-proxy-chiado" 2>/dev/null || true
for PORT in $PUBLIC_L2_EVM_PORT $BUILDER_L2_EVM_PORT $PROOFER_L2_EVM_PORT $PUBLIC_FULLNODE_RPC_PORT $BUILDER_FULLNODE_RPC_PORT $PROOFER_FULLNODE_RPC_PORT $BUILDER_PORT $PROOFER_PORT $L2_PROXY_PORT; do
  lsof -i :$PORT 2>/dev/null | grep LISTEN | awk '{print $2}' | xargs kill 2>/dev/null || true
done
sleep 2

# Clear L2 state
rm -rf state-chiado/
mkdir -p "$ROLLUP_DIR/logs"

# Compute genesis
echo "Computing L2 genesis state root..."
GENESIS_STATE=$(npm --prefix "$ROLLUP_DIR" exec tsx "$ROLLUP_DIR/scripts/compute-genesis-root.ts" -- \
  --rollups "$ROLLUPS_ADDRESS" \
  --rollup-id "$ROLLUP_ID" \
  --chain-id 10200 \
  --l2-chain-id "$L2_CHAIN_ID" \
  --contracts-out "$CONTRACTS_OUT")
echo "  Genesis state root: $GENESIS_STATE"

# Build contracts
echo "Compiling contracts..."
forge build > /dev/null 2>&1
forge build --contracts "$ROLLUP_DIR/scripts/demo_contracts" --out out > /dev/null 2>&1

echo ""
echo "Chiado Deployment:"
echo "  Rollups:   $ROLLUPS_ADDRESS"
echo "  Rollup ID: $ROLLUP_ID"
echo "  L1 RPC:    $L1_RPC"
echo "  Genesis:   $GENESIS_STATE"
echo ""

# Start fullnodes (each starts its own reth internally)
echo "Starting PUBLIC fullnode..."
npm --prefix "$ROLLUP_DIR" exec tsx "$ROLLUP_DIR/reth-fullnode/fullnode.ts" -- \
  --rollups "$ROLLUPS_ADDRESS" \
  --rollup-id "$ROLLUP_ID" \
  --l1-rpc "$L1_RPC" \
  --start-block "$DEPLOYMENT_BLOCK" \
  --l2-port $PUBLIC_L2_EVM_PORT \
  --rpc-port $PUBLIC_FULLNODE_RPC_PORT \
  --initial-state "$GENESIS_STATE" \
  --contracts-out "$CONTRACTS_OUT" \
  --data-dir state-chiado/reth-public \
  > "$ROLLUP_DIR/logs/fullnode-chiado-public.log" 2>&1 &
sleep 12

echo "Starting BUILDER fullnode..."
npm --prefix "$ROLLUP_DIR" exec tsx "$ROLLUP_DIR/reth-fullnode/fullnode.ts" -- \
  --rollups "$ROLLUPS_ADDRESS" \
  --rollup-id "$ROLLUP_ID" \
  --l1-rpc "$L1_RPC" \
  --start-block "$DEPLOYMENT_BLOCK" \
  --l2-port $BUILDER_L2_EVM_PORT \
  --rpc-port $BUILDER_FULLNODE_RPC_PORT \
  --initial-state "$GENESIS_STATE" \
  --contracts-out "$CONTRACTS_OUT" \
  --data-dir state-chiado/reth-builder \
  > "$ROLLUP_DIR/logs/fullnode-chiado-builder.log" 2>&1 &
sleep 12

echo "Starting PROOFER fullnode..."
npm --prefix "$ROLLUP_DIR" exec tsx "$ROLLUP_DIR/reth-fullnode/fullnode.ts" -- \
  --rollups "$ROLLUPS_ADDRESS" \
  --rollup-id "$ROLLUP_ID" \
  --l1-rpc "$L1_RPC" \
  --start-block "$DEPLOYMENT_BLOCK" \
  --l2-port $PROOFER_L2_EVM_PORT \
  --rpc-port $PROOFER_FULLNODE_RPC_PORT \
  --initial-state "$GENESIS_STATE" \
  --contracts-out "$CONTRACTS_OUT" \
  --data-dir state-chiado/reth-proofer \
  > "$ROLLUP_DIR/logs/fullnode-chiado-proofer.log" 2>&1 &
sleep 12

echo ""

# Start proofer service
echo "Starting proofer on port $PROOFER_PORT..."
npm --prefix "$ROLLUP_DIR" exec tsx "$ROLLUP_DIR/proofer/proofer.ts" -- \
  --rollups "$ROLLUPS_ADDRESS" \
  --l1-rpc "$L1_RPC" \
  --proof-key "$ADMIN_KEY" \
  --fullnode "http://localhost:$PROOFER_FULLNODE_RPC_PORT" \
  --port $PROOFER_PORT \
  > "$ROLLUP_DIR/logs/proofer-chiado.log" 2>&1 &
sleep 3

# Start builder service
echo "Starting builder on port $BUILDER_PORT..."
npm --prefix "$ROLLUP_DIR" exec tsx "$ROLLUP_DIR/builder/builder.ts" -- \
  --rollups "$ROLLUPS_ADDRESS" \
  --rollup-id "$ROLLUP_ID" \
  --l1-rpc "$L1_RPC" \
  --admin-key "$ADMIN_KEY" \
  --fullnode "http://localhost:$BUILDER_FULLNODE_RPC_PORT" \
  --proofer "http://localhost:$PROOFER_PORT" \
  --port $BUILDER_PORT \
  > "$ROLLUP_DIR/logs/builder-chiado.log" 2>&1 &
sleep 5

# Start L2 RPC proxy
echo "Starting L2 RPC proxy on port $L2_PROXY_PORT..."
npm --prefix "$ROLLUP_DIR" exec tsx "$ROLLUP_DIR/builder/l2-rpc-proxy.ts" -- \
  --port $L2_PROXY_PORT --rpc "http://localhost:$PUBLIC_L2_EVM_PORT" --builder "http://localhost:$BUILDER_PORT" \
  > "$ROLLUP_DIR/logs/l2-proxy-chiado.log" 2>&1 &
sleep 1

# Check sync
echo ""
echo "Checking sync status..."
for PORT_NAME in "public:$PUBLIC_FULLNODE_RPC_PORT" "builder:$BUILDER_FULLNODE_RPC_PORT" "proofer:$PROOFER_FULLNODE_RPC_PORT"; do
  NAME=${PORT_NAME%%:*}
  PORT=${PORT_NAME##*:}
  RESULT=$(curl -s "http://localhost:$PORT" -X POST -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","method":"syncrollups_isSynced","params":[],"id":1}' 2>/dev/null || echo '{"result":"error"}')
  echo "  $NAME: $RESULT"
done

echo ""
echo "============================================"
echo "sync-rollups Chiado deployment started!"
echo "============================================"
echo ""
echo "Contracts (Chiado L1):"
echo "  Rollups:        $ROLLUPS_ADDRESS"
echo "  MockZKVerifier: $VERIFIER_ADDRESS"
echo "  Rollup ID:      $ROLLUP_ID"
echo "  Counter (L1):   $L1_COUNTER"
echo "  Logger (L1):    $L1_LOGGER"
echo ""
echo "Services:"
echo "  L1 RPC (Chiado):        $L1_RPC"
echo "  Public Fullnode RPC:    http://localhost:$PUBLIC_FULLNODE_RPC_PORT"
echo "  Public L2 EVM:          http://localhost:$PUBLIC_L2_EVM_PORT"
echo "  L2 RPC Proxy:           http://localhost:$L2_PROXY_PORT"
echo "  Builder API:            http://localhost:$BUILDER_PORT"
echo "  Proofer API:            http://localhost:$PROOFER_PORT"
echo ""
echo "Logs: $ROLLUP_DIR/logs/*-chiado*.log"
