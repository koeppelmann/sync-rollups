#!/usr/bin/env bash
# Restore local environment from a saved L1 state snapshot:
# - stop running services
# - start L1 from snapshot
# - restart fullnodes, builder, proxies, dashboard
# - verify L2 re-derives from restored L1 chain

set -euo pipefail

cd "$(dirname "$0")"

# ---------- Config ----------
L1_RPC_PORT=8545
L1_PROXY_PORT=8546
PUBLIC_L2_EVM_PORT=9546
PUBLIC_FULLNODE_RPC_PORT=9547
L2_PROXY_PORT=9548
BUILDER_L2_EVM_PORT=9549
BUILDER_FULLNODE_RPC_PORT=9550
BUILDER_PORT=3200
UI_PORT=8080

INITIAL_STATE=0x0000000000000000000000000000000000000000000000000000000000000000

L1_RPC_URL="http://localhost:${L1_RPC_PORT}"
BUILDER_URL="http://localhost:${BUILDER_PORT}"
PUBLIC_FULLNODE_RPC_URL="http://localhost:${PUBLIC_FULLNODE_RPC_PORT}"
BUILDER_FULLNODE_RPC_URL="http://localhost:${BUILDER_FULLNODE_RPC_PORT}"

L1_STATE_DIR="${L1_STATE_DIR:-state/l1}"
L1_STATE_CURRENT_DIR="${L1_STATE_DIR}/current"
L1_STATE_ARCHIVE_DIR="${L1_STATE_DIR}/archives"
L1_ACTIVE_STATE_FILE="${L1_STATE_CURRENT_DIR}/state.json"

SNAPSHOT_INPUT="${1:-latest}"

NODE_BIN_DEFAULT=/Users/mkoeppelmann/.nvm/versions/node/v20.19.0/bin/node
NODE_BIN=${NODE_BIN:-$NODE_BIN_DEFAULT}
if [ ! -x "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node || true)"
fi
if [ -z "${NODE_BIN:-}" ]; then
  echo "Error: node binary not found"
  exit 1
fi

mkdir -p logs "${L1_STATE_CURRENT_DIR}" "${L1_STATE_ARCHIVE_DIR}"

log() {
  echo "[$(date +%H:%M:%S)] $*"
}

wait_for_rpc_method() {
  local url="$1"
  local method="$2"
  local attempts="${3:-60}"
  local i
  for ((i=1; i<=attempts; i++)); do
    if curl -s --max-time 2 "$url" \
      -H "Content-Type: application/json" \
      -d "{\"jsonrpc\":\"2.0\",\"method\":\"${method}\",\"params\":[],\"id\":1}" \
      | jq -e 'has("result")' >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_builder_status() {
  local attempts="${1:-60}"
  local i
  for ((i=1; i<=attempts; i++)); do
    if curl -s --max-time 2 "${BUILDER_URL}/status" | jq -e 'has("isSynced")' >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_builder_synced() {
  local attempts="${1:-120}"
  local i
  for ((i=1; i<=attempts; i++)); do
    local synced
    synced="$(curl -s --max-time 2 "${BUILDER_URL}/status" | jq -r '.isSynced // "false"' 2>/dev/null || echo "false")"
    if [ "${synced}" = "true" ]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_sync_true() {
  local rpc_url="$1"
  local attempts="${2:-120}"
  local i
  for ((i=1; i<=attempts; i++)); do
    local synced
    synced="$(curl -s --max-time 2 "$rpc_url" \
      -H "Content-Type: application/json" \
      -d '{"jsonrpc":"2.0","method":"syncrollups_isSynced","params":[],"id":1}' \
      | jq -r '.result // "false"' 2>/dev/null || echo "false")"
    if [ "$synced" = "true" ]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

stop_existing_services() {
  log "Stopping existing services..."
  pkill -f "dist/fullnode/fullnode.js" 2>/dev/null || true
  pkill -f "dist/builder/builder.js" 2>/dev/null || true
  pkill -f "dist/builder/rpc-proxy.js" 2>/dev/null || true
  pkill -f "dist/builder/l2-rpc-proxy.js" 2>/dev/null || true
  pkill -f "reth-fullnode/fullnode.ts" 2>/dev/null || true
  pkill -f "builder/builder.ts" 2>/dev/null || true
  pkill -f "rpc-proxy.ts" 2>/dev/null || true
  pkill -f "l2-rpc-proxy.ts" 2>/dev/null || true
  pkill -f "python3 -m http.server ${UI_PORT}" 2>/dev/null || true
  pkill -f "anvil --port ${L1_RPC_PORT}" 2>/dev/null || true
  pkill -f "reth.*--http.port.*${PUBLIC_L2_EVM_PORT}" 2>/dev/null || true
  pkill -f "reth.*--http.port.*${BUILDER_L2_EVM_PORT}" 2>/dev/null || true
  sleep 2
}

resolve_snapshot_path() {
  if [ "${SNAPSHOT_INPUT}" = "latest" ]; then
    if [ -f "${L1_STATE_DIR}/latest-archive.txt" ]; then
      SNAPSHOT_PATH="$(cat "${L1_STATE_DIR}/latest-archive.txt")"
    else
      SNAPSHOT_PATH="$(ls -1t "${L1_STATE_ARCHIVE_DIR}"/l1-state-*.json 2>/dev/null | head -n 1 || true)"
    fi
  else
    SNAPSHOT_PATH="${SNAPSHOT_INPUT}"
  fi

  if [ -z "${SNAPSHOT_PATH:-}" ] || [ ! -f "${SNAPSHOT_PATH}" ]; then
    echo "Error: snapshot not found."
    echo "Input: ${SNAPSHOT_INPUT}"
    echo "Searched in: ${L1_STATE_ARCHIVE_DIR}"
    exit 1
  fi
}

load_deployment_env() {
  if [ ! -f ".env.local" ]; then
    echo "Error: .env.local missing. Cannot restore runtime without deployment metadata."
    exit 1
  fi

  # shellcheck disable=SC1091
  source .env.local

  ROLLUPS_ADDR="${ROLLUPS_ADDRESS:-}"
  DEPLOYMENT_BLOCK_VAL="${DEPLOYMENT_BLOCK:-}"
  ROLLUP_ID_VAL="${ROLLUP_ID:-0}"
  ADMIN_KEY_VAL="${ADMIN_KEY:-}"

  if [ -z "${ROLLUPS_ADDR}" ] || [ -z "${DEPLOYMENT_BLOCK_VAL}" ] || [ -z "${ADMIN_KEY_VAL}" ]; then
    echo "Error: .env.local must contain ROLLUPS_ADDRESS, DEPLOYMENT_BLOCK, ADMIN_KEY"
    exit 1
  fi
}

start_restored_stack() {
  log "Building contracts and services..."
  npm run build >/dev/null

  log "Restoring L1 state from: ${SNAPSHOT_PATH}"
  cp "${SNAPSHOT_PATH}" "${L1_ACTIVE_STATE_FILE}"

  log "Starting L1 Anvil from restored snapshot..."
  nohup anvil \
    --port "${L1_RPC_PORT}" \
    --state "${L1_ACTIVE_STATE_FILE}" \
    --state-interval 2 \
    --preserve-historical-states \
    > logs/anvil.log 2>&1 &
  echo $! > logs/pid-anvil.txt
  wait_for_rpc_method "${L1_RPC_URL}" "eth_blockNumber" 60 || {
    echo "Error: restored L1 Anvil did not start"
    exit 1
  }

  # Basic sanity check that rollup metadata is readable on restored chain
  cast call "${ROLLUPS_ADDR}" \
    "rollups(uint256)(address,bytes32,bytes32,uint256)" \
    "${ROLLUP_ID_VAL}" \
    --rpc-url "${L1_RPC_URL}" >/dev/null

  log "Starting PUBLIC fullnode (9546/9547)..."
  nohup "${NODE_BIN}" dist/fullnode/fullnode.js -- \
    --rollups "${ROLLUPS_ADDR}" \
    --rollup-id "${ROLLUP_ID_VAL}" \
    --l1-rpc "${L1_RPC_URL}" \
    --start-block "${DEPLOYMENT_BLOCK_VAL}" \
    --l2-port "${PUBLIC_L2_EVM_PORT}" \
    --rpc-port "${PUBLIC_FULLNODE_RPC_PORT}" \
    --initial-state "${INITIAL_STATE}" \
    > logs/fullnode-public.log 2>&1 &
  echo $! > logs/pid-fullnode-public.txt
  wait_for_rpc_method "${PUBLIC_FULLNODE_RPC_URL}" "syncrollups_getStateRoot" 80 || {
    echo "Error: public fullnode did not start"
    exit 1
  }

  log "Starting PRIVATE builder fullnode (9549/9550)..."
  nohup "${NODE_BIN}" dist/fullnode/fullnode.js -- \
    --rollups "${ROLLUPS_ADDR}" \
    --rollup-id "${ROLLUP_ID_VAL}" \
    --l1-rpc "${L1_RPC_URL}" \
    --start-block "${DEPLOYMENT_BLOCK_VAL}" \
    --l2-port "${BUILDER_L2_EVM_PORT}" \
    --rpc-port "${BUILDER_FULLNODE_RPC_PORT}" \
    --initial-state "${INITIAL_STATE}" \
    > logs/fullnode-builder.log 2>&1 &
  echo $! > logs/pid-fullnode-builder.txt
  wait_for_rpc_method "${BUILDER_FULLNODE_RPC_URL}" "syncrollups_getStateRoot" 80 || {
    echo "Error: builder fullnode did not start"
    exit 1
  }

  log "Starting builder API on ${BUILDER_PORT}..."
  nohup "${NODE_BIN}" dist/builder/builder.js -- \
    --rollups "${ROLLUPS_ADDR}" \
    --rollup-id "${ROLLUP_ID_VAL}" \
    --l1-rpc "${L1_RPC_URL}" \
    --builder-key "${ADMIN_KEY_VAL}" \
    --owner-key "${ADMIN_KEY_VAL}" \
    --fullnode "${BUILDER_FULLNODE_RPC_URL}" \
    --port "${BUILDER_PORT}" \
    > logs/builder.log 2>&1 &
  echo $! > logs/pid-builder.txt
  wait_for_builder_status 80 || {
    echo "Error: builder did not start"
    exit 1
  }

  log "Starting L1 proxy on ${L1_PROXY_PORT}..."
  nohup "${NODE_BIN}" dist/builder/rpc-proxy.js -- \
    --port "${L1_PROXY_PORT}" \
    --rpc "${L1_RPC_URL}" \
    --builder "${BUILDER_URL}" \
    --rollups "${ROLLUPS_ADDR}" \
    > logs/l1-proxy.log 2>&1 &
  echo $! > logs/pid-l1-proxy.txt

  log "Starting L2 proxy on ${L2_PROXY_PORT}..."
  nohup "${NODE_BIN}" dist/builder/l2-rpc-proxy.js -- \
    --port "${L2_PROXY_PORT}" \
    --rpc "${PUBLIC_FULLNODE_RPC_URL}" \
    --builder "${BUILDER_URL}" \
    > logs/l2-proxy.log 2>&1 &
  echo $! > logs/pid-l2-proxy.txt

  log "Starting dashboard on ${UI_PORT}..."
  nohup python3 -m http.server "${UI_PORT}" --directory ui > logs/ui.log 2>&1 &
  echo $! > logs/pid-ui.txt

  wait_for_sync_true "${PUBLIC_FULLNODE_RPC_URL}" 180 || {
    echo "Error: public fullnode did not sync to restored L1"
    exit 1
  }
  wait_for_sync_true "${BUILDER_FULLNODE_RPC_URL}" 180 || {
    echo "Error: builder fullnode did not sync to restored L1"
    exit 1
  }
  wait_for_builder_synced 180 || {
    echo "Error: builder did not become synced after restore"
    exit 1
  }
}

print_summary() {
  local l1_block
  l1_block="$(cast block-number --rpc-url "${L1_RPC_URL}")"
  local builder_status
  builder_status="$(curl -s "${BUILDER_URL}/status")"
  local public_sync
  public_sync="$(curl -s "${PUBLIC_FULLNODE_RPC_URL}" \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","method":"syncrollups_isSynced","params":[],"id":1}' | jq -r '.result')"

  echo ""
  echo "============================================"
  echo "Restored from L1 snapshot"
  echo "============================================"
  echo "Snapshot:                      ${SNAPSHOT_PATH}"
  echo "L1 block after restore:        ${l1_block}"
  echo "Rollups:                       ${ROLLUPS_ADDR}"
  echo "Deployment block (replay):     ${DEPLOYMENT_BLOCK_VAL}"
  echo "Public fullnode synced:        ${public_sync}"
  echo "Builder synced:                $(echo "${builder_status}" | jq -r '.isSynced')"
  echo "Builder root:                  $(echo "${builder_status}" | jq -r '.fullnodeStateRoot')"
  echo ""
  echo "Endpoints:"
  echo "  Dashboard:        http://localhost:${UI_PORT}"
  echo "  L1 RPC:           ${L1_RPC_URL}"
  echo "  L1 Proxy:         http://localhost:${L1_PROXY_PORT}"
  echo "  Public L2 RPC:    ${PUBLIC_FULLNODE_RPC_URL}"
  echo "  L2 Proxy:         http://localhost:${L2_PROXY_PORT}"
  echo "  Builder:          ${BUILDER_URL}"
  echo ""
  echo "Logs: ./logs/"
}

# ---------- Run ----------
resolve_snapshot_path
load_deployment_env
stop_existing_services
start_restored_stack
print_summary
