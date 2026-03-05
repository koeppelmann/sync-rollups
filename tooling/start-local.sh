#!/bin/bash
# Start all services for local sync-rollups development

set -e

cd "$(dirname "$0")"

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

# Kill any existing processes
echo "Stopping existing services..."
pkill -f "fullnode/fullnode.ts" 2>/dev/null || true
pkill -f "builder/builder.ts" 2>/dev/null || true
pkill -f "rpc-proxy.ts" 2>/dev/null || true
pkill -f "l2-rpc-proxy.ts" 2>/dev/null || true
pkill -f "python3 -m http.server 8080" 2>/dev/null || true
lsof -i :$L1_RPC_PORT 2>/dev/null | grep LISTEN | awk '{print $2}' | xargs kill 2>/dev/null || true
sleep 2

# Create logs directory
mkdir -p logs

# Start L1 Anvil
echo "Starting L1 Anvil on port $L1_RPC_PORT..."
anvil --port $L1_RPC_PORT > logs/anvil.log 2>&1 &
sleep 2

# Deploy contracts
echo "Deploying contracts..."

# Get admin address
ADMIN=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
ADMIN_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

# Deploy AdminZKVerifier
echo "  Deploying AdminZKVerifier..."
VERIFIER_BYTECODE=$(forge inspect AdminZKVerifier bytecode)
ENCODED_ADMIN=$(cast abi-encode "constructor(address)" "$ADMIN")
VERIFIER_ADDR=$(cast send --private-key "$ADMIN_KEY" --rpc-url http://localhost:$L1_RPC_PORT --create "${VERIFIER_BYTECODE}${ENCODED_ADMIN:2}" --json | jq -r '.contractAddress')
echo "  AdminZKVerifier: $VERIFIER_ADDR"

# Deploy Rollups
echo "  Deploying Rollups..."
cd ../sync-rollups
ROLLUPS_BYTECODE=$(forge inspect Rollups bytecode)
ENCODED_ARGS=$(cast abi-encode "constructor(address,uint256)" "$VERIFIER_ADDR" 0)
ROLLUPS_ADDR=$(cast send --private-key "$ADMIN_KEY" --rpc-url http://localhost:$L1_RPC_PORT --create "${ROLLUPS_BYTECODE}${ENCODED_ARGS:2}" --json | jq -r '.contractAddress')
echo "  Rollups: $ROLLUPS_ADDR"
cd ../sync-rollups-builder

# Create rollup 0
echo "  Creating rollup 0..."
cast send --private-key "$ADMIN_KEY" \
  "$ROLLUPS_ADDR" \
  "createRollup(bytes32,bytes32,address)" \
  "0x0000000000000000000000000000000000000000000000000000000000000000" \
  "0x0000000000000000000000000000000000000000000000000000000000000001" \
  "$ADMIN" \
  --rpc-url http://localhost:$L1_RPC_PORT > /dev/null

DEPLOYMENT_BLOCK=$(cast block-number --rpc-url http://localhost:$L1_RPC_PORT)

# Start public fullnode (read-only for users/UI)
echo "Starting PUBLIC fullnode (read-only)..."
npm exec tsx fullnode/fullnode.ts -- \
  --rollups "$ROLLUPS_ADDR" \
  --rollup-id 0 \
  --l1-rpc http://localhost:$L1_RPC_PORT \
  --start-block "$DEPLOYMENT_BLOCK" \
  --l2-port $PUBLIC_L2_EVM_PORT \
  --rpc-port $PUBLIC_FULLNODE_RPC_PORT \
  --initial-state 0x0000000000000000000000000000000000000000000000000000000000000000 \
  > logs/fullnode-public.log 2>&1 &
sleep 4

# Start private builder fullnode (builder-only)
echo "Starting PRIVATE builder fullnode..."
npm exec tsx fullnode/fullnode.ts -- \
  --rollups "$ROLLUPS_ADDR" \
  --rollup-id 0 \
  --l1-rpc http://localhost:$L1_RPC_PORT \
  --start-block "$DEPLOYMENT_BLOCK" \
  --l2-port $BUILDER_L2_EVM_PORT \
  --rpc-port $BUILDER_FULLNODE_RPC_PORT \
  --initial-state 0x0000000000000000000000000000000000000000000000000000000000000000 \
  > logs/fullnode-builder.log 2>&1 &
sleep 4

# Start builder (wired only to private builder fullnode)
echo "Starting builder..."
npm exec tsx builder/builder.ts -- \
  --rollups "$ROLLUPS_ADDR" \
  --rollup-id 0 \
  --l1-rpc http://localhost:$L1_RPC_PORT \
  --admin-key "$ADMIN_KEY" \
  --fullnode http://localhost:$BUILDER_FULLNODE_RPC_PORT \
  --port $BUILDER_PORT \
  > logs/builder.log 2>&1 &
sleep 3

# Start L1 RPC Proxy
echo "Starting L1 RPC Proxy..."
npm exec tsx builder/rpc-proxy.ts -- \
  --port $L1_PROXY_PORT \
  --rpc http://localhost:$L1_RPC_PORT \
  --builder http://localhost:$BUILDER_PORT \
  --rollups "$ROLLUPS_ADDR" \
  > logs/l1-proxy.log 2>&1 &
sleep 1

# Start L2 RPC Proxy
echo "Starting L2 RPC Proxy..."
npm exec tsx builder/l2-rpc-proxy.ts -- \
  --port $L2_PROXY_PORT \
  --rpc http://localhost:$PUBLIC_FULLNODE_RPC_PORT \
  --builder http://localhost:$BUILDER_PORT \
  > logs/l2-proxy.log 2>&1 &
sleep 1

# Start UI server
echo "Starting dashboard..."
python3 -m http.server 8080 --directory ui > logs/ui.log 2>&1 &
sleep 1

# Print summary
echo ""
echo "============================================"
echo "sync-rollups local environment started!"
echo "============================================"
echo ""
echo "Contracts:"
echo "  AdminZKVerifier: $VERIFIER_ADDR"
echo "  Rollups:         $ROLLUPS_ADDR"
echo "  Deployment block: $DEPLOYMENT_BLOCK"
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
echo "  Dashboard:    http://localhost:8080"
echo ""
echo "Test accounts (Anvil defaults):"
echo "  Account #1: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 (admin)"
echo "  Account #2: 0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
echo ""
echo "Wallet Networks:"
echo "  L1 'Anvil Local':  ChainId 31337,    RPC http://localhost:$L1_PROXY_PORT"
echo "  L2 'Sync Rollup':  ChainId 10200200, RPC http://localhost:$L2_PROXY_PORT"
echo ""
echo "Note: L2 balances start at 0. Bridge ETH from L1 to get funds on L2."
echo ""
echo "Logs: ./logs/"
echo ""
echo "To stop: pkill -f 'fullnode|builder|anvil|http.server|rpc-proxy'"
