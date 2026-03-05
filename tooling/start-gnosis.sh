#!/usr/bin/env bash
# Non-destructive restart for Gnosis-backed runtime:
# - does NOT redeploy contracts
# - does NOT reset/replace L1 state
# - restarts local fullnodes, builder, proxies, dashboard

set -euo pipefail

cd "$(dirname "$0")"

ENV_FILE="${ENV_FILE:-.env.gnosis}"

L1_PROXY_PORT="${L1_PROXY_PORT:-8546}"
PUBLIC_L2_EVM_PORT="${PUBLIC_L2_EVM_PORT:-9546}"
PUBLIC_FULLNODE_RPC_PORT="${PUBLIC_FULLNODE_RPC_PORT:-9547}"
L2_PROXY_PORT="${L2_PROXY_PORT:-9548}"
BUILDER_L2_EVM_PORT="${BUILDER_L2_EVM_PORT:-9549}"
BUILDER_FULLNODE_RPC_PORT="${BUILDER_FULLNODE_RPC_PORT:-9550}"
BUILDER_PORT="${BUILDER_PORT:-3200}"
UI_PORT="${UI_PORT:-8080}"

INITIAL_STATE="0x0000000000000000000000000000000000000000000000000000000000000000"
UI_WALLETS_FILE="${UI_WALLETS_FILE:-ui/wallets.dev.json}"
UI_SETTINGS_FILE="${UI_SETTINGS_FILE:-ui/settings.dev.json}"

NODE_BIN_DEFAULT="/Users/mkoeppelmann/.nvm/versions/node/v20.19.0/bin/node"
NODE_BIN="${NODE_BIN:-$NODE_BIN_DEFAULT}"
if [ ! -x "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node || true)"
fi
if [ -z "${NODE_BIN:-}" ]; then
  echo "Error: node binary not found"
  exit 1
fi

mkdir -p logs

log() {
  echo "[$(date +%H:%M:%S)] $*"
}

wait_for_rpc_method() {
  local url="$1"
  local method="$2"
  local attempts="${3:-120}"
  local i
  for ((i=1; i<=attempts; i++)); do
    if curl -s --max-time 3 "$url" \
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
  local attempts="${1:-120}"
  local i
  for ((i=1; i<=attempts; i++)); do
    if curl -s --max-time 3 "${BUILDER_URL}/status" | jq -e 'has("isSynced")' >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_builder_synced() {
  local attempts="${1:-240}"
  local i
  for ((i=1; i<=attempts; i++)); do
    local synced
    synced="$(curl -s --max-time 3 "${BUILDER_URL}/status" | jq -r '.isSynced // "false"' 2>/dev/null || echo "false")"
    if [ "$synced" = "true" ]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_sync_true() {
  local rpc_url="$1"
  local attempts="${2:-240}"
  local i
  for ((i=1; i<=attempts; i++)); do
    local synced
    synced="$(curl -s --max-time 3 "$rpc_url" \
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
  log "Stopping local services..."
  pkill -f "dist/fullnode/fullnode.js" 2>/dev/null || true
  pkill -f "dist/builder/builder.js" 2>/dev/null || true
  pkill -f "dist/builder/rpc-proxy.js" 2>/dev/null || true
  pkill -f "dist/builder/l2-rpc-proxy.js" 2>/dev/null || true
  pkill -f "fullnode/fullnode.ts" 2>/dev/null || true
  pkill -f "builder/builder.ts" 2>/dev/null || true
  pkill -f "rpc-proxy.ts" 2>/dev/null || true
  pkill -f "l2-rpc-proxy.ts" 2>/dev/null || true
  pkill -f "python3 -m http.server ${UI_PORT}" 2>/dev/null || true
  pkill -f "python -m http.server ${UI_PORT}" 2>/dev/null || true
  pkill -f "http.server ${UI_PORT} --directory ui" 2>/dev/null || true
  pkill -f "anvil --port ${PUBLIC_L2_EVM_PORT}" 2>/dev/null || true
  pkill -f "anvil --port ${BUILDER_L2_EVM_PORT}" 2>/dev/null || true
  sleep 2
}

load_env() {
  if [ ! -f "${ENV_FILE}" ]; then
    echo "Error: ${ENV_FILE} not found. Run setup-gnosis.sh first."
    exit 1
  fi

  # shellcheck disable=SC1090
  source "${ENV_FILE}"

  L1_RPC_URL="${L1_RPC:-}"
  ROLLUPS_ADDR="${ROLLUPS_ADDRESS:-}"
  DEPLOYMENT_BLOCK="${DEPLOYMENT_BLOCK:-}"
  ROLLUP_ID_VAL="${ROLLUP_ID:-0}"
  BUILDER_KEY_VAL="${BUILDER_KEY:-}"
  PROVER_KEY_VAL="${PROVER_KEY:-${BUILDER_KEY_VAL}}"
  USER1_KEY_VAL="${USER1_KEY:-}"
  USER2_KEY_VAL="${USER2_KEY:-}"

  if [ -z "${L1_RPC_URL}" ] || [ -z "${ROLLUPS_ADDR}" ] || [ -z "${DEPLOYMENT_BLOCK}" ] || [ -z "${BUILDER_KEY_VAL}" ]; then
    echo "Error: ${ENV_FILE} must include L1_RPC, ROLLUPS_ADDRESS, DEPLOYMENT_BLOCK, BUILDER_KEY"
    exit 1
  fi

  BUILDER_URL="http://localhost:${BUILDER_PORT}"
  PUBLIC_FULLNODE_RPC_URL="http://localhost:${PUBLIC_FULLNODE_RPC_PORT}"
  BUILDER_FULLNODE_RPC_URL="http://localhost:${BUILDER_FULLNODE_RPC_PORT}"
}

write_ui_wallet_config() {
  local user1_addr user2_addr
  if [ -n "${USER1_KEY_VAL}" ]; then
    user1_addr="$(cast wallet address --private-key "${USER1_KEY_VAL}")"
  else
    user1_addr=""
  fi
  if [ -n "${USER2_KEY_VAL}" ]; then
    user2_addr="$(cast wallet address --private-key "${USER2_KEY_VAL}")"
  else
    user2_addr=""
  fi

  if [ -n "${user1_addr}" ] && [ -n "${user2_addr}" ]; then
    cat > "${UI_WALLETS_FILE}" <<EOF
{
  "users": [
    {
      "label": "User #1",
      "address": "${user1_addr}",
      "privateKey": "${USER1_KEY_VAL}"
    },
    {
      "label": "User #2",
      "address": "${user2_addr}",
      "privateKey": "${USER2_KEY_VAL}"
    }
  ]
}
EOF
    log "Updated ${UI_WALLETS_FILE} from ${ENV_FILE}"
  fi
}

write_ui_settings_config() {
  cat > "${UI_SETTINGS_FILE}" <<EOF
{
  "l1Rpc": "http://localhost:${L1_PROXY_PORT}",
  "l2Rpc": "http://localhost:${PUBLIC_FULLNODE_RPC_PORT}",
  "l2EvmRpc": "http://localhost:${L2_PROXY_PORT}",
  "builderUrl": "http://localhost:${BUILDER_PORT}",
  "rollupsAddress": "${ROLLUPS_ADDR}",
  "rollupId": "${ROLLUP_ID_VAL}",
  "deploymentBlock": "${DEPLOYMENT_BLOCK}"
}
EOF
  log "Updated ${UI_SETTINGS_FILE} from ${ENV_FILE}"
}

start_services() {
  log "Building services..."
  npm run build >/dev/null

  log "Starting PUBLIC fullnode (${PUBLIC_L2_EVM_PORT}/${PUBLIC_FULLNODE_RPC_PORT})..."
  nohup "${NODE_BIN}" dist/fullnode/fullnode.js -- \
    --rollups "${ROLLUPS_ADDR}" \
    --rollup-id "${ROLLUP_ID_VAL}" \
    --l1-rpc "${L1_RPC_URL}" \
    --start-block "${DEPLOYMENT_BLOCK}" \
    --l2-port "${PUBLIC_L2_EVM_PORT}" \
    --rpc-port "${PUBLIC_FULLNODE_RPC_PORT}" \
    --initial-state "${INITIAL_STATE}" \
    > logs/fullnode-public.log 2>&1 &
  echo $! > logs/pid-fullnode-public.txt
  wait_for_rpc_method "${PUBLIC_FULLNODE_RPC_URL}" "syncrollups_getStateRoot" 120 || {
    echo "Error: public fullnode did not start"
    exit 1
  }

  log "Starting PRIVATE builder fullnode (${BUILDER_L2_EVM_PORT}/${BUILDER_FULLNODE_RPC_PORT})..."
  nohup "${NODE_BIN}" dist/fullnode/fullnode.js -- \
    --rollups "${ROLLUPS_ADDR}" \
    --rollup-id "${ROLLUP_ID_VAL}" \
    --l1-rpc "${L1_RPC_URL}" \
    --start-block "${DEPLOYMENT_BLOCK}" \
    --l2-port "${BUILDER_L2_EVM_PORT}" \
    --rpc-port "${BUILDER_FULLNODE_RPC_PORT}" \
    --initial-state "${INITIAL_STATE}" \
    > logs/fullnode-builder.log 2>&1 &
  echo $! > logs/pid-fullnode-builder.txt
  wait_for_rpc_method "${BUILDER_FULLNODE_RPC_URL}" "syncrollups_getStateRoot" 120 || {
    echo "Error: builder fullnode did not start"
    exit 1
  }

  log "Starting builder API on ${BUILDER_PORT}..."
  nohup "${NODE_BIN}" dist/builder/builder.js -- \
    --rollups "${ROLLUPS_ADDR}" \
    --rollup-id "${ROLLUP_ID_VAL}" \
    --l1-rpc "${L1_RPC_URL}" \
    --admin-key "${BUILDER_KEY_VAL}" \
    --proof-key "${PROVER_KEY_VAL}" \
    --fullnode "${BUILDER_FULLNODE_RPC_URL}" \
    --port "${BUILDER_PORT}" \
    > logs/builder.log 2>&1 &
  echo $! > logs/pid-builder.txt
  wait_for_builder_status 120 || {
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
}

verify_sync() {
  wait_for_sync_true "${PUBLIC_FULLNODE_RPC_URL}" 240 || {
    echo "Error: public fullnode did not sync"
    exit 1
  }
  wait_for_sync_true "${BUILDER_FULLNODE_RPC_URL}" 240 || {
    echo "Error: builder fullnode did not sync"
    exit 1
  }
  wait_for_builder_synced 240 || {
    echo "Error: builder status stayed Not Synced"
    exit 1
  }
}

print_summary() {
  local builder_status
  builder_status="$(curl -s "${BUILDER_URL}/status")"
  local l1_block
  l1_block="$(cast block-number --rpc-url "${L1_RPC_URL}")"
  echo ""
  echo "============================================"
  echo "Gnosis services started"
  echo "============================================"
  echo "L1 block:           ${l1_block}"
  echo "Builder synced:     $(echo "${builder_status}" | jq -r '.isSynced')"
  echo ""
  echo "Endpoints:"
  echo "  Dashboard:        http://localhost:${UI_PORT}"
  echo "  L1 Proxy:         http://localhost:${L1_PROXY_PORT}"
  echo "  L2 Proxy:         http://localhost:${L2_PROXY_PORT}"
  echo "  Public L2 RPC:    http://localhost:${PUBLIC_FULLNODE_RPC_PORT}"
  echo "  Builder API:      http://localhost:${BUILDER_PORT}"
  echo ""
}

# ---------- Run ----------
load_env
stop_existing_services
write_ui_wallet_config
write_ui_settings_config
start_services
verify_sync
print_summary
