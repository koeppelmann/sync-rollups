#!/bin/bash
# Start the ethrex-based L2 fullnode for sync-rollups.
#
# This script:
# 1. Builds the Rust fullnode binary
# 2. Runs it with the correct configuration
#
# Prerequisites:
#   - Anvil L1 running (start-local.sh)
#   - Rollups contract deployed
#   - ethrex binary built at $ETHREX_BIN

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Source .env.local if it exists
if [ -f .env.local ]; then
    source .env.local
fi

# Configuration (can be overridden via environment)
L1_RPC_URL="${L1_RPC_URL:-http://localhost:8545}"
ROLLUPS_ADDRESS="${ROLLUPS_ADDRESS:-}"
ROLLUP_ID="${ROLLUP_ID:-0}"
L2_CHAIN_ID="${L2_CHAIN_ID:-10200200}"
DEPLOYMENT_BLOCK="${DEPLOYMENT_BLOCK:-0}"
ETHREX_BIN="${ETHREX_BIN:-/home/ubuntu/code/ethrex/target/release/ethrex}"
CONTRACTS_OUT_DIR="${CONTRACTS_OUT_DIR:-../out}"

# Ports — offset from the reth fullnode to avoid conflicts
L2_RPC_PORT="${L2_RPC_PORT:-9556}"
L2_ENGINE_PORT="${L2_ENGINE_PORT:-9561}"
L2_P2P_PORT="${L2_P2P_PORT:-30315}"
STATUS_RPC_PORT="${STATUS_RPC_PORT:-3201}"

DATADIR="${DATADIR:-./state/ethrex-fullnode}"
LOG_DIR="${LOG_DIR:-./logs}"
POLL_INTERVAL_MS="${POLL_INTERVAL_MS:-1000}"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log() { echo -e "${GREEN}[ethrex-fullnode]${NC} $1"; }
warn() { echo -e "${YELLOW}[ethrex-fullnode]${NC} $1"; }
error() { echo -e "${RED}[ethrex-fullnode]${NC} $1"; }

# Check prerequisites
if [ -z "$ROLLUPS_ADDRESS" ]; then
    error "ROLLUPS_ADDRESS not set. Deploy Rollups contract first or set ROLLUPS_ADDRESS."
    exit 1
fi

if [ ! -f "$ETHREX_BIN" ]; then
    error "ethrex binary not found at $ETHREX_BIN"
    error "Build it with: cd /home/ubuntu/code/ethrex && cargo build --release --bin ethrex"
    exit 1
fi

# Check L1 is reachable
if ! curl -s "$L1_RPC_URL" -X POST -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' > /dev/null 2>&1; then
    error "L1 RPC at $L1_RPC_URL is not reachable. Start Anvil first."
    exit 1
fi

log "Configuration:"
log "  L1 RPC:          $L1_RPC_URL"
log "  Rollups:         $ROLLUPS_ADDRESS"
log "  Rollup ID:       $ROLLUP_ID"
log "  L2 Chain ID:     $L2_CHAIN_ID"
log "  L2 RPC Port:     $L2_RPC_PORT"
log "  L2 Engine Port:  $L2_ENGINE_PORT"
log "  Status RPC Port: $STATUS_RPC_PORT"
log "  Data dir:        $DATADIR"

# Clean previous state
if [ -d "$DATADIR" ]; then
    warn "Cleaning previous state at $DATADIR"
    rm -rf "$DATADIR"
fi

# Build the Rust fullnode
log "Building Rust fullnode..."
cd ethrex-fullnode
cargo build --release 2>&1 | tail -3
cd "$SCRIPT_DIR"

FULLNODE_BIN="./ethrex-fullnode/target/release/sync-rollups-ethrex-fullnode"

if [ ! -f "$FULLNODE_BIN" ]; then
    error "Fullnode binary not found after build"
    exit 1
fi

log "Starting ethrex fullnode..."

exec "$FULLNODE_BIN" \
    --l1-rpc-url "$L1_RPC_URL" \
    --rollups-address "$ROLLUPS_ADDRESS" \
    --rollup-id "$ROLLUP_ID" \
    --l2-chain-id "$L2_CHAIN_ID" \
    --deployment-block "$DEPLOYMENT_BLOCK" \
    --ethrex-bin "$ETHREX_BIN" \
    --contracts-out-dir "$CONTRACTS_OUT_DIR" \
    --datadir "$DATADIR" \
    --l2-rpc-port "$L2_RPC_PORT" \
    --l2-engine-port "$L2_ENGINE_PORT" \
    --l2-p2p-port "$L2_P2P_PORT" \
    --status-rpc-port "$STATUS_RPC_PORT" \
    --poll-interval-ms "$POLL_INTERVAL_MS" \
    --log-dir "$LOG_DIR"
