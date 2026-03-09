#!/usr/bin/env bash
# Non-destructive restart for Gnosis-backed runtime:
# - does NOT redeploy contracts
# - does NOT reset/replace L1 state
# - restarts local fullnodes, builder, proxies, dashboard

set -euo pipefail

cd "$(dirname "$0")"

ENV_FILE="${ENV_FILE:-.env.gnosis}"

L1_PROXY_PORT="${L1_PROXY_PORT:-8556}"
PUBLIC_L2_EVM_PORT="${PUBLIC_L2_EVM_PORT:-9646}"
PUBLIC_FULLNODE_RPC_PORT="${PUBLIC_FULLNODE_RPC_PORT:-9647}"
L2_PROXY_PORT="${L2_PROXY_PORT:-9648}"
BUILDER_L2_EVM_PORT="${BUILDER_L2_EVM_PORT:-9649}"
BUILDER_FULLNODE_RPC_PORT="${BUILDER_FULLNODE_RPC_PORT:-9650}"
BUILDER_PORT="${BUILDER_PORT:-3210}"
PROOFER_L2_EVM_PORT="${PROOFER_L2_EVM_PORT:-9651}"
PROOFER_FULLNODE_RPC_PORT="${PROOFER_FULLNODE_RPC_PORT:-9652}"
PROOFER_PORT="${PROOFER_PORT:-3310}"
ETHREX_L2_EVM_PORT="${ETHREX_L2_EVM_PORT:-9656}"
ETHREX_ENGINE_PORT="${ETHREX_ENGINE_PORT:-9661}"
ETHREX_P2P_PORT="${ETHREX_P2P_PORT:-30325}"
ETHREX_STATUS_PORT="${ETHREX_STATUS_PORT:-3211}"
ETHREX_BIN="${ETHREX_BIN:-/home/ubuntu/code/ethrex/target/release/ethrex}"
UI_PORT="${UI_PORT:-8080}"

UI_WALLETS_FILE="${UI_WALLETS_FILE:-ui/wallets.gnosis.json}"
UI_SETTINGS_FILE="${UI_SETTINGS_FILE:-ui/settings.gnosis.json}"

NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
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
  log "Stopping Gnosis services (port-specific, won't affect Anvil)..."
  # Kill by PID file if available (from previous runs)
  for pidfile in logs/pid-gnosis-*.txt; do
    [ -f "$pidfile" ] && kill "$(cat "$pidfile")" 2>/dev/null || true
    rm -f "$pidfile" 2>/dev/null || true
  done
  # Kill reth instances by port (guaranteed port-specific)
  pkill -f "reth.*--http.port.*${PUBLIC_L2_EVM_PORT}" 2>/dev/null || true
  pkill -f "reth.*--http.port.*${BUILDER_L2_EVM_PORT}" 2>/dev/null || true
  pkill -f "reth.*--http.port.*${PROOFER_L2_EVM_PORT}" 2>/dev/null || true
  pkill -f "ethrex.*--http.port.*${ETHREX_L2_EVM_PORT}" 2>/dev/null || true
  lsof -ti :${ETHREX_STATUS_PORT} 2>/dev/null | xargs kill 2>/dev/null || true
  # Kill port-specific services
  lsof -ti :${L1_PROXY_PORT} 2>/dev/null | xargs kill 2>/dev/null || true
  lsof -ti :${L2_PROXY_PORT} 2>/dev/null | xargs kill 2>/dev/null || true
  lsof -ti :${BUILDER_PORT} 2>/dev/null | xargs kill 2>/dev/null || true
  lsof -ti :${PROOFER_PORT} 2>/dev/null | xargs kill 2>/dev/null || true
  lsof -ti :${PUBLIC_FULLNODE_RPC_PORT} 2>/dev/null | xargs kill 2>/dev/null || true
  lsof -ti :${BUILDER_FULLNODE_RPC_PORT} 2>/dev/null | xargs kill 2>/dev/null || true
  lsof -ti :${PROOFER_FULLNODE_RPC_PORT} 2>/dev/null | xargs kill 2>/dev/null || true
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
  GENESIS_STATE_VAL="${GENESIS_STATE:-}"

  if [ -z "${L1_RPC_URL}" ] || [ -z "${ROLLUPS_ADDR}" ] || [ -z "${DEPLOYMENT_BLOCK}" ] || [ -z "${BUILDER_KEY_VAL}" ]; then
    echo "Error: ${ENV_FILE} must include L1_RPC, ROLLUPS_ADDRESS, DEPLOYMENT_BLOCK, BUILDER_KEY"
    exit 1
  fi

  if [ -z "${GENESIS_STATE_VAL}" ]; then
    echo "Error: ${ENV_FILE} must include GENESIS_STATE. Re-run setup-gnosis.sh."
    exit 1
  fi

  BUILDER_URL="http://localhost:${BUILDER_PORT}"
  PROOFER_URL="http://localhost:${PROOFER_PORT}"
  PUBLIC_FULLNODE_RPC_URL="http://localhost:${PUBLIC_FULLNODE_RPC_PORT}"
  BUILDER_FULLNODE_RPC_URL="http://localhost:${BUILDER_FULLNODE_RPC_PORT}"
  PROOFER_FULLNODE_RPC_URL="http://localhost:${PROOFER_FULLNODE_RPC_PORT}"
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
  local host_ip
  host_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  [ -z "${host_ip}" ] && host_ip="localhost"

  cat > "${UI_SETTINGS_FILE}" <<EOF
{
  "l1Rpc": "http://${host_ip}:${L1_PROXY_PORT}",
  "l2Rpc": "http://${host_ip}:${PUBLIC_FULLNODE_RPC_PORT}",
  "l2EvmRpc": "http://${host_ip}:${L2_PROXY_PORT}",
  "builderUrl": "http://${host_ip}:${BUILDER_PORT}",
  "prooferUrl": "http://${host_ip}:${PROOFER_PORT}",
  "ethrexRpc": "http://${host_ip}:${ETHREX_STATUS_PORT}",
  "ethrexEvmRpc": "http://${host_ip}:${ETHREX_L2_EVM_PORT}",
  "blockscoutL1Url": "https://gnosis.blockscout.com",
  "blockscoutL2Url": "http://${host_ip}:4021",
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

  # Path to compiled contract artifacts
  local CONTRACTS_OUT
  CONTRACTS_OUT="$(realpath "$(dirname "$0")/../out")"

  log "Starting PUBLIC fullnode (${PUBLIC_L2_EVM_PORT}/${PUBLIC_FULLNODE_RPC_PORT})..."
  nohup "${NODE_BIN}" dist/fullnode/fullnode.js -- \
    --rollups "${ROLLUPS_ADDR}" \
    --rollup-id "${ROLLUP_ID_VAL}" \
    --l1-rpc "${L1_RPC_URL}" \
    --start-block "${DEPLOYMENT_BLOCK}" \
    --l2-port "${PUBLIC_L2_EVM_PORT}" \
    --rpc-port "${PUBLIC_FULLNODE_RPC_PORT}" \
    --initial-state "${GENESIS_STATE_VAL}" \
    --contracts-out "${CONTRACTS_OUT}" \
    > logs/fullnode-public.log 2>&1 &
  echo $! > logs/pid-gnosis-fullnode-public.txt
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
    --initial-state "${GENESIS_STATE_VAL}" \
    --contracts-out "${CONTRACTS_OUT}" \
    > logs/fullnode-builder.log 2>&1 &
  echo $! > logs/pid-gnosis-fullnode-builder.txt
  wait_for_rpc_method "${BUILDER_FULLNODE_RPC_URL}" "syncrollups_getStateRoot" 120 || {
    echo "Error: builder fullnode did not start"
    exit 1
  }

  log "Starting PROOFER fullnode (${PROOFER_L2_EVM_PORT}/${PROOFER_FULLNODE_RPC_PORT})..."
  nohup "${NODE_BIN}" dist/fullnode/fullnode.js -- \
    --rollups "${ROLLUPS_ADDR}" \
    --rollup-id "${ROLLUP_ID_VAL}" \
    --l1-rpc "${L1_RPC_URL}" \
    --start-block "${DEPLOYMENT_BLOCK}" \
    --l2-port "${PROOFER_L2_EVM_PORT}" \
    --rpc-port "${PROOFER_FULLNODE_RPC_PORT}" \
    --initial-state "${GENESIS_STATE_VAL}" \
    --contracts-out "${CONTRACTS_OUT}" \
    > logs/fullnode-proofer.log 2>&1 &
  echo $! > logs/pid-gnosis-fullnode-proofer.txt
  wait_for_rpc_method "${PROOFER_FULLNODE_RPC_URL}" "syncrollups_getStateRoot" 120 || {
    echo "Error: proofer fullnode did not start"
    exit 1
  }

  log "Starting proofer on ${PROOFER_PORT}..."
  nohup npx tsx proofer/proofer.ts -- \
    --rollups "${ROLLUPS_ADDR}" \
    --l1-rpc "${L1_RPC_URL}" \
    --proof-key "${PROVER_KEY_VAL}" \
    --fullnode "${PROOFER_FULLNODE_RPC_URL}" \
    --port "${PROOFER_PORT}" \
    > logs/proofer.log 2>&1 &
  echo $! > logs/pid-gnosis-proofer.txt

  log "Starting builder API on ${BUILDER_PORT}..."
  nohup "${NODE_BIN}" dist/builder/builder.js -- \
    --rollups "${ROLLUPS_ADDR}" \
    --rollup-id "${ROLLUP_ID_VAL}" \
    --l1-rpc "${L1_RPC_URL}" \
    --admin-key "${BUILDER_KEY_VAL}" \
    --proofer "${PROOFER_URL}" \
    --fullnode "${BUILDER_FULLNODE_RPC_URL}" \
    --port "${BUILDER_PORT}" \
    > logs/builder.log 2>&1 &
  echo $! > logs/pid-gnosis-builder.txt
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
  echo $! > logs/pid-gnosis-l1-proxy.txt

  log "Starting L2 proxy on ${L2_PROXY_PORT}..."
  nohup "${NODE_BIN}" dist/builder/l2-rpc-proxy.js -- \
    --port "${L2_PROXY_PORT}" \
    --rpc "${PUBLIC_FULLNODE_RPC_URL}" \
    --builder "${BUILDER_URL}" \
    > logs/l2-proxy.log 2>&1 &
  echo $! > logs/pid-gnosis-l2-proxy.txt

  # Start ethrex fullnode (alternative L2 client)
  if [ -f "${ETHREX_BIN}" ]; then
    log "Starting ETHREX fullnode (${ETHREX_L2_EVM_PORT}/${ETHREX_STATUS_PORT})..."
    local ETHREX_FULLNODE_BIN="./ethrex-fullnode/target/release/sync-rollups-ethrex-fullnode"
    if [ ! -f "${ETHREX_FULLNODE_BIN}" ]; then
      log "Building ethrex fullnode..."
      (cd ethrex-fullnode && cargo build --release 2>&1 | tail -1)
    fi
    if [ -f "${ETHREX_FULLNODE_BIN}" ]; then
      rm -rf state/ethrex-gnosis
      nohup "${ETHREX_FULLNODE_BIN}" \
        --l1-rpc-url "${L1_RPC_URL}" \
        --rollups-address "${ROLLUPS_ADDR}" \
        --rollup-id "${ROLLUP_ID_VAL}" \
        --l2-chain-id 10200200 \
        --deployment-block "${DEPLOYMENT_BLOCK}" \
        --ethrex-bin "${ETHREX_BIN}" \
        --contracts-out-dir "${CONTRACTS_OUT}" \
        --datadir ./state/ethrex-gnosis \
        --l2-rpc-port "${ETHREX_L2_EVM_PORT}" \
        --l2-engine-port "${ETHREX_ENGINE_PORT}" \
        --l2-p2p-port "${ETHREX_P2P_PORT}" \
        --status-rpc-port "${ETHREX_STATUS_PORT}" \
        > logs/ethrex-fullnode-gnosis.log 2>&1 &
      echo $! > logs/pid-gnosis-ethrex.txt
    else
      log "WARNING: ethrex fullnode binary not found, skipping"
    fi
  else
    log "Skipping ETHREX fullnode (ethrex binary not found at ${ETHREX_BIN})"
  fi

  # Dashboard is shared with Anvil (served on port 8080 by start-local.sh)
  # The UI env selector switches between deployment configs automatically
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
  wait_for_sync_true "${PROOFER_FULLNODE_RPC_URL}" 240 || {
    echo "Error: proofer fullnode did not sync"
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
  echo "  Proofer API:      http://localhost:${PROOFER_PORT}"
  echo "  Proofer L2 RPC:   http://localhost:${PROOFER_FULLNODE_RPC_PORT}"
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
