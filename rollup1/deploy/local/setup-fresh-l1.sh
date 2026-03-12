#!/usr/bin/env bash
# Fresh local setup:
# - restart L1
# - deploy rollup contracts
# - deploy advanced Counter on L1
# - fund an L2 account through L1->L2 value transfer
# - deploy advanced Counter on L2
# - verify public L2 fullnode catches up to L1 state

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

ADMIN_ADDR=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
ADMIN_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
L2_FUNDED_ADDR=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
L2_FUNDED_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
FUND_ETH=${FUND_ETH:-2}

INITIAL_STATE=0x0000000000000000000000000000000000000000000000000000000000000000
VK_PLACEHOLDER=0x0000000000000000000000000000000000000000000000000000000000000001

NODE_BIN_DEFAULT=/Users/mkoeppelmann/.nvm/versions/node/v20.19.0/bin/node
NODE_BIN=${NODE_BIN:-$NODE_BIN_DEFAULT}
if [ ! -x "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node || true)"
fi
if [ -z "${NODE_BIN:-}" ]; then
  echo "Error: node binary not found"
  exit 1
fi

L1_RPC_URL="http://localhost:${L1_RPC_PORT}"
BUILDER_URL="http://localhost:${BUILDER_PORT}"
PUBLIC_FULLNODE_RPC_URL="http://localhost:${PUBLIC_FULLNODE_RPC_PORT}"
BUILDER_FULLNODE_RPC_URL="http://localhost:${BUILDER_FULLNODE_RPC_PORT}"
L2_PROXY_URL="http://localhost:${L2_PROXY_PORT}"
L1_STATE_DIR="${L1_STATE_DIR:-state/l1}"
L1_STATE_CURRENT_DIR="${L1_STATE_DIR}/current"
L1_STATE_ARCHIVE_DIR="${L1_STATE_DIR}/archives"
L1_ACTIVE_STATE_FILE="${L1_STATE_CURRENT_DIR}/state.json"

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

restart_private_builder_stack() {
  log "Restarting private builder stack (builder fullnode + builder + L2 proxy)..."
  pkill -f "dist/builder/builder.js" 2>/dev/null || true
  pkill -f "dist/builder/l2-rpc-proxy.js" 2>/dev/null || true
  pkill -f "dist/fullnode/fullnode.js -- --rollups ${ROLLUPS_ADDR} --rollup-id 0 --l1-rpc ${L1_RPC_URL} --start-block ${DEPLOYMENT_BLOCK} --l2-port ${BUILDER_L2_EVM_PORT} --rpc-port ${BUILDER_FULLNODE_RPC_PORT}" 2>/dev/null || true
  pkill -f "reth.*--http.port.*${BUILDER_L2_EVM_PORT}" 2>/dev/null || true
  sleep 2

  nohup "${NODE_BIN}" dist/fullnode/fullnode.js -- \
    --rollups "${ROLLUPS_ADDR}" \
    --rollup-id 0 \
    --l1-rpc "${L1_RPC_URL}" \
    --start-block "${DEPLOYMENT_BLOCK}" \
    --l2-port "${BUILDER_L2_EVM_PORT}" \
    --rpc-port "${BUILDER_FULLNODE_RPC_PORT}" \
    --initial-state "${INITIAL_STATE}" \
    --contracts-out "../out" \
    > logs/fullnode-builder.log 2>&1 &
  echo $! > logs/pid-fullnode-builder.txt
  wait_for_rpc_method "${BUILDER_FULLNODE_RPC_URL}" "syncrollups_getStateRoot" 80 || {
    echo "Error: builder fullnode did not restart"
    exit 1
  }

  nohup "${NODE_BIN}" dist/builder/builder.js -- \
    --rollups "${ROLLUPS_ADDR}" \
    --rollup-id 0 \
    --l1-rpc "${L1_RPC_URL}" \
    --admin-key "${ADMIN_KEY}" \
    --fullnode "${BUILDER_FULLNODE_RPC_URL}" \
    --port "${BUILDER_PORT}" \
    > logs/builder.log 2>&1 &
  echo $! > logs/pid-builder.txt
  wait_for_builder_status 80 || {
    echo "Error: builder did not restart"
    exit 1
  }
  wait_for_builder_synced 120 || {
    echo "Error: builder did not become synced after restart"
    exit 1
  }

  nohup "${NODE_BIN}" dist/builder/l2-rpc-proxy.js -- \
    --port "${L2_PROXY_PORT}" \
    --rpc "${PUBLIC_FULLNODE_RPC_URL}" \
    --builder "${BUILDER_URL}" \
    > logs/l2-proxy.log 2>&1 &
  echo $! > logs/pid-l2-proxy.txt
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
  # Before killing L1, request a graceful stop so Anvil persists current state,
  # then archive that snapshot for later recovery.
  if pgrep -f "anvil --port ${L1_RPC_PORT}" >/dev/null 2>&1; then
    local l1_block="unknown"
    l1_block="$(cast block-number --rpc-url "${L1_RPC_URL}" 2>/dev/null || echo "unknown")"
    log "Saving L1 snapshot before reset (block ${l1_block})..."
    pkill -TERM -f "anvil --port ${L1_RPC_PORT}" 2>/dev/null || true
    for _ in $(seq 1 30); do
      if ! pgrep -f "anvil --port ${L1_RPC_PORT}" >/dev/null 2>&1; then
        break
      fi
      sleep 0.2
    done
    if pgrep -f "anvil --port ${L1_RPC_PORT}" >/dev/null 2>&1; then
      log "L1 did not stop gracefully in time, forcing shutdown..."
      pkill -KILL -f "anvil --port ${L1_RPC_PORT}" 2>/dev/null || true
      sleep 1
    fi

    if [ -f "${L1_ACTIVE_STATE_FILE}" ]; then
      local snapshot_ts
      snapshot_ts="$(date +%Y%m%d-%H%M%S)"
      local snapshot_path="${L1_STATE_ARCHIVE_DIR}/l1-state-${snapshot_ts}-block-${l1_block}.json"
      cp "${L1_ACTIVE_STATE_FILE}" "${snapshot_path}"
      printf '%s\n' "${snapshot_path}" > "${L1_STATE_DIR}/latest-archive.txt"
      log "L1 snapshot archived to ${snapshot_path}"
    else
      log "Warning: no persisted L1 state file found at ${L1_ACTIVE_STATE_FILE}"
    fi
  fi

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

start_services() {
  log "Building contracts and services..."
  forge build >/dev/null
  (
    cd ..
    forge build >/dev/null
  )
  npm run build >/dev/null

  log "Starting L1 Anvil on ${L1_RPC_PORT}..."
  # Fresh setup intentionally starts a new L1 chain.
  rm -f "${L1_ACTIVE_STATE_FILE}"
  # Clean L2 state directories from previous runs to prevent stale reth data.
  rm -rf state/l2-*/reth state/l2-*/sync-state.json
  nohup anvil \
    --port "${L1_RPC_PORT}" \
    --state "${L1_ACTIVE_STATE_FILE}" \
    --state-interval 2 \
    --preserve-historical-states \
    > logs/anvil.log 2>&1 &
  echo $! > logs/pid-anvil.txt
  wait_for_rpc_method "$L1_RPC_URL" "eth_blockNumber" 60 || {
    echo "Error: L1 Anvil did not start"
    exit 1
  }

  log "Deploying contracts via Deploy.s.sol..."
  local deploy_output
  deploy_output="$(
    cd ..
    PRIVATE_KEY="${ADMIN_KEY}" STARTING_ROLLUP_ID=0 \
      forge script script/Deploy.s.sol:Deploy \
      --rpc-url "${L1_RPC_URL}" \
      --broadcast \
      --private-key "${ADMIN_KEY}" \
      2>&1
  )"
  echo "${deploy_output}"

  VERIFIER_ADDR="$(echo "${deploy_output}" | rg 'MockZKVerifier deployed at:' | rg -o '0x[0-9a-fA-F]{40}')"
  ROLLUPS_ADDR="$(echo "${deploy_output}" | rg 'Rollups deployed at:' | rg -o '0x[0-9a-fA-F]{40}')"
  if [ -z "${VERIFIER_ADDR}" ] || [ -z "${ROLLUPS_ADDR}" ]; then
    echo "Error: could not parse deployment addresses"
    exit 1
  fi
  log "MockZKVerifier: ${VERIFIER_ADDR}"
  log "Rollups: ${ROLLUPS_ADDR}"

  log "Computing genesis state root for reth..."
  INITIAL_STATE="$(
    npx tsx scripts/compute-genesis-root.ts \
      --rollups "${ROLLUPS_ADDR}" \
      --contracts-out ../out
  )"
  if [ -z "${INITIAL_STATE}" ]; then
    echo "Error: could not compute genesis state root"
    exit 1
  fi
  log "Genesis state root: ${INITIAL_STATE}"

  log "Creating rollup 0..."
  cast send --private-key "${ADMIN_KEY}" \
    "${ROLLUPS_ADDR}" \
    "createRollup(bytes32,bytes32,address)" \
    "${INITIAL_STATE}" \
    "${VK_PLACEHOLDER}" \
    "${ADMIN_ADDR}" \
    --rpc-url "${L1_RPC_URL}" >/dev/null

  DEPLOYMENT_BLOCK="$(cast block-number --rpc-url "${L1_RPC_URL}")"
  log "Deployment block: ${DEPLOYMENT_BLOCK}"

  cat > .env.local <<EOF
# sync-rollups Local Deployment
ROLLUPS_ADDRESS=${ROLLUPS_ADDR}
VERIFIER_ADDRESS=${VERIFIER_ADDR}
DEPLOYMENT_BLOCK=${DEPLOYMENT_BLOCK}
ADMIN_KEY=${ADMIN_KEY}
ROLLUP_ID=0
L1_RPC=${L1_RPC_URL}
L2_CHAIN_ID=10200200
EOF

  log "Starting PUBLIC fullnode (9546/9547)..."
  nohup "${NODE_BIN}" dist/fullnode/fullnode.js -- \
    --rollups "${ROLLUPS_ADDR}" \
    --rollup-id 0 \
    --l1-rpc "${L1_RPC_URL}" \
    --start-block "${DEPLOYMENT_BLOCK}" \
    --l2-port "${PUBLIC_L2_EVM_PORT}" \
    --rpc-port "${PUBLIC_FULLNODE_RPC_PORT}" \
    --initial-state "${INITIAL_STATE}" \
    --contracts-out "../out" \
    > logs/fullnode-public.log 2>&1 &
  echo $! > logs/pid-fullnode-public.txt
  wait_for_rpc_method "${PUBLIC_FULLNODE_RPC_URL}" "syncrollups_getStateRoot" 80 || {
    echo "Error: public fullnode did not start"
    exit 1
  }

  log "Starting PRIVATE builder fullnode (9549/9550)..."
  nohup "${NODE_BIN}" dist/fullnode/fullnode.js -- \
    --rollups "${ROLLUPS_ADDR}" \
    --rollup-id 0 \
    --l1-rpc "${L1_RPC_URL}" \
    --start-block "${DEPLOYMENT_BLOCK}" \
    --l2-port "${BUILDER_L2_EVM_PORT}" \
    --rpc-port "${BUILDER_FULLNODE_RPC_PORT}" \
    --initial-state "${INITIAL_STATE}" \
    --contracts-out "../out" \
    > logs/fullnode-builder.log 2>&1 &
  echo $! > logs/pid-fullnode-builder.txt
  wait_for_rpc_method "${BUILDER_FULLNODE_RPC_URL}" "syncrollups_getStateRoot" 80 || {
    echo "Error: builder fullnode did not start"
    exit 1
  }

  log "Starting builder API on ${BUILDER_PORT}..."
  nohup "${NODE_BIN}" dist/builder/builder.js -- \
    --rollups "${ROLLUPS_ADDR}" \
    --rollup-id 0 \
    --l1-rpc "${L1_RPC_URL}" \
    --admin-key "${ADMIN_KEY}" \
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

  wait_for_sync_true "${PUBLIC_FULLNODE_RPC_URL}" 120 || {
    echo "Error: public fullnode did not reach initial synced state"
    exit 1
  }
  wait_for_sync_true "${BUILDER_FULLNODE_RPC_URL}" 120 || {
    echo "Error: builder fullnode did not reach initial synced state"
    exit 1
  }
}

fund_l2_account_via_l1_to_l2() {
  log "Funding L2 account ${L2_FUNDED_ADDR} via L1->L2 value transfer (${FUND_ETH} ETH)..."
  local fund_wei
  fund_wei="$(cast to-wei "${FUND_ETH}" ether)"
  local fund_hex
  fund_hex="$(cast to-hex "${fund_wei}")"

  local prepare_payload
  prepare_payload="$(
    jq -cn \
      --arg l2Target "${L2_FUNDED_ADDR}" \
      --arg value "${fund_hex}" \
      --arg data "0x" \
      --arg sourceAddress "${ADMIN_ADDR}" \
      '{l2Target:$l2Target, value:$value, data:$data, sourceAddress:$sourceAddress}'
  )"

  local prepare_resp
  prepare_resp="$(curl -s "${BUILDER_URL}/prepare-l1-call" \
    -H "Content-Type: application/json" \
    -d "${prepare_payload}")"

  local ok
  ok="$(echo "${prepare_resp}" | jq -r '.success // false')"
  if [ "${ok}" != "true" ]; then
    echo "Error: prepare-l1-call failed"
    echo "${prepare_resp}" | jq .
    exit 1
  fi

  FUND_PROXY_ADDR="$(echo "${prepare_resp}" | jq -r '.proxyAddress')"
  FUND_SOURCE_PROXY="$(echo "${prepare_resp}" | jq -r '.sourceProxyAddress // ""')"
  log "Funding proxy: ${FUND_PROXY_ADDR}"
  if [ -n "${FUND_SOURCE_PROXY}" ]; then
    log "L2 sender proxy: ${FUND_SOURCE_PROXY}"
  fi

  FUND_L1_TX_HASH="$(
    cast send --private-key "${ADMIN_KEY}" \
      --rpc-url "${L1_RPC_URL}" \
      "${FUND_PROXY_ADDR}" \
      --value "${FUND_ETH}ether" \
      --json | jq -r '.transactionHash'
  )"
  log "Funding tx hash: ${FUND_L1_TX_HASH}"

  wait_for_sync_true "${PUBLIC_FULLNODE_RPC_URL}" 120 || {
    echo "Error: public fullnode did not re-sync after L1->L2 funding"
    exit 1
  }
  restart_private_builder_stack

  L2_FUNDED_BALANCE_WEI="$(cast balance "${L2_FUNDED_ADDR}" --rpc-url "${PUBLIC_FULLNODE_RPC_URL}")"
  if [ "${L2_FUNDED_BALANCE_WEI}" -le 0 ]; then
    echo "Error: funded L2 balance is still zero"
    exit 1
  fi
  log "Funded L2 balance (wei): ${L2_FUNDED_BALANCE_WEI}"
}

deploy_advanced_counter_on_l2() {
  log "Deploying advanced Counter contract on L2 via builder path..."
  wait_for_builder_synced 120 || {
    echo "Error: builder not synced before counter deployment"
    exit 1
  }

  local deploy_nonce
  deploy_nonce="$(cast nonce "${L2_FUNDED_ADDR}" --rpc-url "${PUBLIC_FULLNODE_RPC_URL}")"
  COUNTER_ADDR="$(
    cast compute-address --nonce "${deploy_nonce}" "${L2_FUNDED_ADDR}" \
      | rg -o '0x[0-9a-fA-F]{40}' \
      | tail -n 1
  )"
  if [ -z "${COUNTER_ADDR}" ]; then
    echo "Error: could not parse computed counter address"
    exit 1
  fi

  local counter_bytecode
  counter_bytecode="$(jq -r '.bytecode.object' out/Counter.sol/Counter.json)"
  if [ -z "${counter_bytecode}" ] || [ "${counter_bytecode}" = "null" ]; then
    echo "Error: Counter bytecode not found"
    exit 1
  fi
  if [[ "${counter_bytecode}" != 0x* ]]; then
    counter_bytecode="0x${counter_bytecode}"
  fi

  local deploy_out
  deploy_out="$(
    cast send --async \
      --private-key "${L2_FUNDED_KEY}" \
      --rpc-url "${L2_PROXY_URL}" \
      --create "${counter_bytecode}" 2>&1
  )"
  COUNTER_L1_TX_HASH="$(echo "${deploy_out}" | rg -o '0x[0-9a-fA-F]{64}' | tail -n 1)"
  if [ -z "${COUNTER_L1_TX_HASH}" ]; then
    echo "Error: could not parse counter deploy tx hash"
    echo "${deploy_out}"
    exit 1
  fi
  log "Counter deploy L1 tx hash: ${COUNTER_L1_TX_HASH}"
  log "Expected counter address: ${COUNTER_ADDR}"

  wait_for_sync_true "${PUBLIC_FULLNODE_RPC_URL}" 120 || {
    echo "Error: public fullnode did not re-sync after counter deploy"
    exit 1
  }
  wait_for_sync_true "${BUILDER_FULLNODE_RPC_URL}" 120 || {
    echo "Error: builder private fullnode did not re-sync after counter deploy"
    exit 1
  }
  wait_for_builder_synced 120 || {
    echo "Error: builder did not report synced after counter deploy"
    exit 1
  }
  local code
  code="$(cast code "${COUNTER_ADDR}" --rpc-url "${PUBLIC_FULLNODE_RPC_URL}")"
  if [ "${code}" = "0x" ]; then
    echo "Error: counter code is empty on L2"
    exit 1
  fi

  COUNTER_COUNT="$(cast call "${COUNTER_ADDR}" "getCount()(uint256)" --rpc-url "${PUBLIC_FULLNODE_RPC_URL}")"
  COUNTER_LAST_CALLER="$(cast call "${COUNTER_ADDR}" "lastCaller()(address)" --rpc-url "${PUBLIC_FULLNODE_RPC_URL}")"
}

print_summary() {
  local builder_status
  builder_status="$(curl -s "${BUILDER_URL}/status")"
  local public_sync
  public_sync="$(curl -s "${PUBLIC_FULLNODE_RPC_URL}" \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","method":"syncrollups_isSynced","params":[],"id":1}' | jq -r '.result')"
  local public_l1_root
  public_l1_root="$(curl -s "${PUBLIC_FULLNODE_RPC_URL}" \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","method":"syncrollups_getL1State","params":[],"id":1}' | jq -r '.result.stateRoot')"
  local public_tracked_root
  public_tracked_root="$(curl -s "${PUBLIC_FULLNODE_RPC_URL}" \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","method":"syncrollups_getStateRoot","params":[],"id":1}' | jq -r '.result')"
  local public_actual_root
  public_actual_root="$(curl -s "${PUBLIC_FULLNODE_RPC_URL}" \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","method":"syncrollups_getActualStateRoot","params":[],"id":1}' | jq -r '.result')"
  local builder_sync
  builder_sync="$(echo "${builder_status}" | jq -r '.isSynced')"
  local builder_root
  builder_root="$(echo "${builder_status}" | jq -r '.fullnodeStateRoot')"
  local builder_l1_root
  builder_l1_root="$(echo "${builder_status}" | jq -r '.l1StateRoot')"
  echo ""
  echo "============================================"
  echo "Fresh setup complete"
  echo "============================================"
  echo "Rollups:            ${ROLLUPS_ADDR}"
  echo "Verifier:           ${VERIFIER_ADDR}"
  echo "Deployment block:   ${DEPLOYMENT_BLOCK}"
  echo ""
  echo "L2 funding:"
  echo "  L2 account:       ${L2_FUNDED_ADDR}"
  echo "  Funding tx:       ${FUND_L1_TX_HASH}"
  echo "  L1 proxy used:    ${FUND_PROXY_ADDR}"
  echo "  L2 balance (wei): ${L2_FUNDED_BALANCE_WEI}"
  echo ""
  echo "Sync verification:"
  echo "  Public fullnode syncrollups_isSynced: ${public_sync}"
  echo "  Public L1 root:                 ${public_l1_root}"
  echo "  Public tracked L2 root:         ${public_tracked_root}"
  echo "  Public actual L2 root:          ${public_actual_root}"
  echo "  Builder status isSynced:        ${builder_sync}"
  echo "  Builder L1 root:                ${builder_l1_root}"
  echo "  Builder private fullnode root:  ${builder_root}"
  echo ""
  echo "Endpoints:"
  echo "  Dashboard:        http://localhost:${UI_PORT}"
  echo "  L1 RPC:           ${L1_RPC_URL}"
  echo "  L1 Proxy:         http://localhost:${L1_PROXY_PORT}"
  echo "  Public L2 RPC:    ${PUBLIC_FULLNODE_RPC_URL}"
  echo "  L2 Proxy:         ${L2_PROXY_URL}"
  echo "  Builder:          ${BUILDER_URL}"
  echo ""
  echo "Logs: ./logs/"
  echo "To stop: pkill -f 'dist/fullnode/fullnode.js|dist/builder/builder.js|dist/builder/rpc-proxy.js|dist/builder/l2-rpc-proxy.js|anvil --port ${L1_RPC_PORT}|reth.*${PUBLIC_L2_EVM_PORT}|reth.*${BUILDER_L2_EVM_PORT}|http.server ${UI_PORT}'"
}

# ---------- Run ----------
stop_existing_services
start_services
fund_l2_account_via_l1_to_l2
print_summary
