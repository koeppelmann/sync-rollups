#!/usr/bin/env bash
# Fresh setup against Gnosis L1:
# - deploy verifier + rollups + rollup config + L1 counter
# - start local fullnodes/builder/proxies/dashboard
# - fund two user accounts on L2 via L1->L2 value transfers
# - deploy advanced Counter on L2 from user #1

set -euo pipefail

cd "$(dirname "$0")"

# ---------- Network / Ports ----------
L1_RPC_URL="${L1_RPC_URL:-https://rpc.gnosischain.com}"
EXPECTED_L1_CHAIN_ID="${EXPECTED_L1_CHAIN_ID:-100}"
ROLLUP_ID="${ROLLUP_ID:-0}"

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
UI_PORT="${UI_PORT:-8080}"

BUILDER_URL="http://localhost:${BUILDER_PORT}"
PROOFER_URL="http://localhost:${PROOFER_PORT}"
PUBLIC_FULLNODE_RPC_URL="http://localhost:${PUBLIC_FULLNODE_RPC_PORT}"
BUILDER_FULLNODE_RPC_URL="http://localhost:${BUILDER_FULLNODE_RPC_PORT}"
PROOFER_FULLNODE_RPC_URL="http://localhost:${PROOFER_FULLNODE_RPC_PORT}"
L2_PROXY_URL="http://localhost:${L2_PROXY_PORT}"

# ---------- Keys (override via env) ----------
# These defaults are for local development only.
PROVER_KEY="${PROVER_KEY:-0xe43216858ac471edc9c3799130fe7337bcdc7d2a8123ca2a8c0f34ec60d7015c}"
BUILDER_KEY="${BUILDER_KEY:-0xad20032e7e86534618be3d579aefdc588d0e9adfd2279589d305dea69ea3c55d}"
USER1_KEY="${USER1_KEY:-0x1c6bdebe45b85aa62d7170a8e43aa0fbf5c51ffc168ec5f58ae377b115f68d31}"
USER2_KEY="${USER2_KEY:-0xa71547650a593008aa8d778643883b78dfad7cecb4e935e61530c6af38220802}"

# ---------- Funding / Rollup ----------
FUND_L1_USER1_ETH="${FUND_L1_USER1_ETH:-0}"
FUND_L1_USER2_ETH="${FUND_L1_USER2_ETH:-0}"
FUND_L2_USER1_ETH="${FUND_L2_USER1_ETH:-0.001}"
FUND_L2_USER2_ETH="${FUND_L2_USER2_ETH:-0.001}"

INITIAL_STATE="0x0000000000000000000000000000000000000000000000000000000000000000"
VK_PLACEHOLDER="0x0000000000000000000000000000000000000000000000000000000000000001"

ENV_FILE="${ENV_FILE:-.env.gnosis}"
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

require_cmd() {
  local cmd="$1"
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "Error: required command not found: $cmd"
    exit 1
  }
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

derive_role_addresses() {
  PROVER_ADDR="$(cast wallet address --private-key "${PROVER_KEY}")"
  BUILDER_ADDR="$(cast wallet address --private-key "${BUILDER_KEY}")"
  USER1_ADDR="$(cast wallet address --private-key "${USER1_KEY}")"
  USER2_ADDR="$(cast wallet address --private-key "${USER2_KEY}")"

  local uniq
  uniq="$(printf '%s\n' "${PROVER_ADDR}" "${BUILDER_ADDR}" "${USER1_ADDR}" "${USER2_ADDR}" | sort -u | wc -l | tr -d ' ')"
  if [ "$uniq" -ne 4 ]; then
    echo "Error: role keys must map to 4 distinct addresses"
    exit 1
  fi
}

check_prereqs() {
  require_cmd cast
  require_cmd forge
  require_cmd jq
  require_cmd curl
  require_cmd npm
  require_cmd python3
  require_cmd anvil
  require_cmd rg

  local chain_id
  chain_id="$(cast chain-id --rpc-url "${L1_RPC_URL}")"
  if [ "${chain_id}" != "${EXPECTED_L1_CHAIN_ID}" ]; then
    echo "Error: L1 RPC chain id mismatch. Expected ${EXPECTED_L1_CHAIN_ID}, got ${chain_id}"
    echo "RPC: ${L1_RPC_URL}"
    exit 1
  fi

  BUILDER_L1_BALANCE_WEI="$(cast balance "${BUILDER_ADDR}" --rpc-url "${L1_RPC_URL}")"
  log "L1 chain id: ${chain_id}"
  log "Builder L1 balance (wei): ${BUILDER_L1_BALANCE_WEI}"
  if [ "${BUILDER_L1_BALANCE_WEI}" -eq 0 ]; then
    echo "Error: builder address has zero balance on L1 (${BUILDER_ADDR})"
    echo "Fund the builder key with xDAI before running setup."
    exit 1
  fi
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
  # Kill port-specific proxy/builder/proofer by port numbers
  lsof -ti :${L1_PROXY_PORT} 2>/dev/null | xargs kill 2>/dev/null || true
  lsof -ti :${L2_PROXY_PORT} 2>/dev/null | xargs kill 2>/dev/null || true
  lsof -ti :${BUILDER_PORT} 2>/dev/null | xargs kill 2>/dev/null || true
  lsof -ti :${PROOFER_PORT} 2>/dev/null | xargs kill 2>/dev/null || true
  lsof -ti :${PUBLIC_FULLNODE_RPC_PORT} 2>/dev/null | xargs kill 2>/dev/null || true
  lsof -ti :${BUILDER_FULLNODE_RPC_PORT} 2>/dev/null | xargs kill 2>/dev/null || true
  lsof -ti :${PROOFER_FULLNODE_RPC_PORT} 2>/dev/null | xargs kill 2>/dev/null || true
  sleep 2
}

deploy_l1_contracts() {
  log "Building contracts and services..."
  forge build >/dev/null
  (
    cd ..
    forge build >/dev/null
  )
  npm run build >/dev/null

  log "Deploying MockZKVerifier (owner = builder)..."
  local verifier_bytecode
  verifier_bytecode="$(jq -r '.bytecode.object' ../out/Deploy.s.sol/MockZKVerifier.json)"
  if [ -z "${verifier_bytecode}" ] || [ "${verifier_bytecode}" = "null" ]; then
    echo "Error: MockZKVerifier bytecode not found in ../out/Deploy.s.sol/MockZKVerifier.json"
    exit 1
  fi
  if [[ "${verifier_bytecode}" != 0x* ]]; then
    verifier_bytecode="0x${verifier_bytecode}"
  fi
  VERIFIER_ADDR="$(
    cast send --private-key "${BUILDER_KEY}" \
      --rpc-url "${L1_RPC_URL}" \
      --create "${verifier_bytecode}" \
      --json | jq -r '.contractAddress'
  )"
  log "MockZKVerifier: ${VERIFIER_ADDR}"

  log "Deploying Rollups..."
  local rollups_bytecode
  rollups_bytecode="$(
    cd ..
    forge inspect Rollups bytecode
  )"
  local encoded_rollups_args
  encoded_rollups_args="$(cast abi-encode "constructor(address,uint256)" "${VERIFIER_ADDR}" "${ROLLUP_ID}")"
  ROLLUPS_ADDR="$(
    cast send --private-key "${BUILDER_KEY}" \
      --rpc-url "${L1_RPC_URL}" \
      --create "${rollups_bytecode}${encoded_rollups_args:2}" \
      --json | jq -r '.contractAddress'
  )"
  log "Rollups: ${ROLLUPS_ADDR}"

  log "Computing L2 genesis state root..."
  local contracts_out
  contracts_out="$(realpath "$(dirname "$0")/../out")"
  GENESIS_STATE="$(npx tsx scripts/compute-genesis-root.ts \
    --rollups "${ROLLUPS_ADDR}" \
    --rollup-id "${ROLLUP_ID}" \
    --contracts-out "${contracts_out}")"
  log "Genesis state root: ${GENESIS_STATE}"

  log "Creating rollup ${ROLLUP_ID} (owner = builder)..."
  cast send --private-key "${BUILDER_KEY}" \
    "${ROLLUPS_ADDR}" \
    "createRollup(bytes32,bytes32,address)" \
    "${GENESIS_STATE}" \
    "${VK_PLACEHOLDER}" \
    "${BUILDER_ADDR}" \
    --rpc-url "${L1_RPC_URL}" >/dev/null

  log "Deploying advanced Counter on L1..."
  local l1_counter_bytecode
  l1_counter_bytecode="$(jq -r '.bytecode.object' out/Counter.sol/Counter.json)"
  if [ -z "${l1_counter_bytecode}" ] || [ "${l1_counter_bytecode}" = "null" ]; then
    echo "Error: Counter bytecode not found"
    exit 1
  fi
  if [[ "${l1_counter_bytecode}" != 0x* ]]; then
    l1_counter_bytecode="0x${l1_counter_bytecode}"
  fi
  L1_COUNTER_ADDR="$(
    cast send --private-key "${BUILDER_KEY}" \
      --rpc-url "${L1_RPC_URL}" \
      --create "${l1_counter_bytecode}" \
      --json | jq -r '.contractAddress'
  )"
  log "L1 Counter: ${L1_COUNTER_ADDR}"

  DEPLOYMENT_BLOCK="$(cast block-number --rpc-url "${L1_RPC_URL}")"
  log "Deployment block: ${DEPLOYMENT_BLOCK}"
}

write_runtime_files() {
  cat > "${ENV_FILE}" <<EOF
# sync-rollups Gnosis deployment
L1_RPC=${L1_RPC_URL}
L1_CHAIN_ID=${EXPECTED_L1_CHAIN_ID}
ROLLUPS_ADDRESS=${ROLLUPS_ADDR}
VERIFIER_ADDRESS=${VERIFIER_ADDR}
DEPLOYMENT_BLOCK=${DEPLOYMENT_BLOCK}
ROLLUP_ID=${ROLLUP_ID}
L1_COUNTER_ADDRESS=${L1_COUNTER_ADDR}
PROVER_KEY=${PROVER_KEY}
PROVER_ADDRESS=${PROVER_ADDR}
BUILDER_KEY=${BUILDER_KEY}
BUILDER_ADDRESS=${BUILDER_ADDR}
USER1_KEY=${USER1_KEY}
USER1_ADDRESS=${USER1_ADDR}
USER2_KEY=${USER2_KEY}
USER2_ADDRESS=${USER2_ADDR}
L2_CHAIN_ID=10200200
GENESIS_STATE=${GENESIS_STATE}
EOF

  cat > "${UI_WALLETS_FILE}" <<EOF
{
  "users": [
    {
      "label": "User #1",
      "address": "${USER1_ADDR}",
      "privateKey": "${USER1_KEY}"
    },
    {
      "label": "User #2",
      "address": "${USER2_ADDR}",
      "privateKey": "${USER2_KEY}"
    }
  ],
  "builder": {
    "address": "${BUILDER_ADDR}"
  },
  "prover": {
    "address": "${PROVER_ADDR}"
  }
}
EOF

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
  "ethrexRpc": "http://${host_ip}:${ETHREX_STATUS_PORT:-3211}",
  "ethrexEvmRpc": "http://${host_ip}:${ETHREX_L2_EVM_PORT:-9656}",
  "blockscoutL1Url": "https://gnosis.blockscout.com",
  "blockscoutL2Url": "http://${host_ip}:4021",
  "rollupsAddress": "${ROLLUPS_ADDR}",
  "rollupId": "${ROLLUP_ID}",
  "deploymentBlock": "${DEPLOYMENT_BLOCK}"
}
EOF
  log "Wrote ${ENV_FILE}"
  log "Wrote ${UI_WALLETS_FILE}"
  log "Wrote ${UI_SETTINGS_FILE}"
}

start_services() {
  local contracts_out
  contracts_out="$(realpath "$(dirname "$0")/../out")"

  log "Starting PUBLIC fullnode (${PUBLIC_L2_EVM_PORT}/${PUBLIC_FULLNODE_RPC_PORT})..."
  nohup "${NODE_BIN}" dist/fullnode/fullnode.js -- \
    --rollups "${ROLLUPS_ADDR}" \
    --rollup-id "${ROLLUP_ID}" \
    --l1-rpc "${L1_RPC_URL}" \
    --start-block "${DEPLOYMENT_BLOCK}" \
    --l2-port "${PUBLIC_L2_EVM_PORT}" \
    --rpc-port "${PUBLIC_FULLNODE_RPC_PORT}" \
    --initial-state "${GENESIS_STATE}" \
    --contracts-out "${contracts_out}" \
    > logs/fullnode-public.log 2>&1 &
  echo $! > logs/pid-gnosis-fullnode-public.txt
  wait_for_rpc_method "${PUBLIC_FULLNODE_RPC_URL}" "syncrollups_getStateRoot" 120 || {
    echo "Error: public fullnode did not start"
    exit 1
  }

  log "Starting PRIVATE builder fullnode (${BUILDER_L2_EVM_PORT}/${BUILDER_FULLNODE_RPC_PORT})..."
  nohup "${NODE_BIN}" dist/fullnode/fullnode.js -- \
    --rollups "${ROLLUPS_ADDR}" \
    --rollup-id "${ROLLUP_ID}" \
    --l1-rpc "${L1_RPC_URL}" \
    --start-block "${DEPLOYMENT_BLOCK}" \
    --l2-port "${BUILDER_L2_EVM_PORT}" \
    --rpc-port "${BUILDER_FULLNODE_RPC_PORT}" \
    --initial-state "${GENESIS_STATE}" \
    --contracts-out "${contracts_out}" \
    > logs/fullnode-builder.log 2>&1 &
  echo $! > logs/pid-gnosis-fullnode-builder.txt
  wait_for_rpc_method "${BUILDER_FULLNODE_RPC_URL}" "syncrollups_getStateRoot" 120 || {
    echo "Error: builder fullnode did not start"
    exit 1
  }

  log "Starting PROOFER fullnode (${PROOFER_L2_EVM_PORT}/${PROOFER_FULLNODE_RPC_PORT})..."
  nohup "${NODE_BIN}" dist/fullnode/fullnode.js -- \
    --rollups "${ROLLUPS_ADDR}" \
    --rollup-id "${ROLLUP_ID}" \
    --l1-rpc "${L1_RPC_URL}" \
    --start-block "${DEPLOYMENT_BLOCK}" \
    --l2-port "${PROOFER_L2_EVM_PORT}" \
    --rpc-port "${PROOFER_FULLNODE_RPC_PORT}" \
    --initial-state "${GENESIS_STATE}" \
    --contracts-out "${contracts_out}" \
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
    --proof-key "${PROVER_KEY}" \
    --fullnode "http://localhost:${PROOFER_FULLNODE_RPC_PORT}" \
    --port "${PROOFER_PORT}" \
    > logs/proofer.log 2>&1 &
  echo $! > logs/pid-gnosis-proofer.txt

  log "Starting builder API on ${BUILDER_PORT}..."
  nohup "${NODE_BIN}" dist/builder/builder.js -- \
    --rollups "${ROLLUPS_ADDR}" \
    --rollup-id "${ROLLUP_ID}" \
    --l1-rpc "${L1_RPC_URL}" \
    --admin-key "${BUILDER_KEY}" \
    --proofer "http://localhost:${PROOFER_PORT}" \
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

  # Dashboard is shared with Anvil (served on port 8080 by start-local.sh)
  # The UI env selector switches between deployment configs automatically

  wait_for_sync_true "${PUBLIC_FULLNODE_RPC_URL}" 240 || {
    echo "Error: public fullnode did not reach synced state"
    exit 1
  }
  wait_for_sync_true "${BUILDER_FULLNODE_RPC_URL}" 240 || {
    echo "Error: builder fullnode did not reach synced state"
    exit 1
  }
  wait_for_builder_synced 240 || {
    echo "Error: builder did not reach synced state"
    exit 1
  }
}

fund_l1_user_if_requested() {
  local to="$1"
  local amount_eth="$2"
  local label="$3"
  local amount_wei
  amount_wei="$(cast to-wei "${amount_eth}" ether)"
  if [ "${amount_wei}" -eq 0 ]; then
    return 0
  fi

  log "Funding ${label} on L1 with ${amount_eth} xDAI..."
  cast send --private-key "${BUILDER_KEY}" \
    --rpc-url "${L1_RPC_URL}" \
    "${to}" \
    --value "${amount_eth}ether" >/dev/null
}

fund_l2_user_via_l1() {
  local l2_user_addr="$1"
  local amount_eth="$2"
  local label="$3"
  local amount_wei
  amount_wei="$(cast to-wei "${amount_eth}" ether)"
  if [ "${amount_wei}" -eq 0 ]; then
    log "Skipping L2 funding for ${label} (amount = 0)"
    return 0
  fi

  log "Funding ${label} on L2 via L1->L2 (${amount_eth} ETH)..."
  local amount_hex
  amount_hex="$(cast to-hex "${amount_wei}")"

  local prepare_payload
  prepare_payload="$(
    jq -cn \
      --arg l2Target "${l2_user_addr}" \
      --arg value "${amount_hex}" \
      --arg data "0x" \
      --arg sourceAddress "${BUILDER_ADDR}" \
      '{l2Target:$l2Target, value:$value, data:$data, sourceAddress:$sourceAddress}'
  )"

  local prepare_resp
  prepare_resp="$(curl -s "${BUILDER_URL}/prepare-l1-call" \
    -H "Content-Type: application/json" \
    -d "${prepare_payload}")"

  local ok
  ok="$(echo "${prepare_resp}" | jq -r '.success // false')"
  if [ "${ok}" != "true" ]; then
    echo "Error: prepare-l1-call failed for ${label}"
    echo "${prepare_resp}" | jq .
    exit 1
  fi

  local proxy_addr
  proxy_addr="$(echo "${prepare_resp}" | jq -r '.proxyAddress')"
  if [ -z "${proxy_addr}" ] || [ "${proxy_addr}" = "null" ]; then
    echo "Error: missing proxyAddress for ${label}"
    exit 1
  fi
  log "  Proxy: ${proxy_addr}"

  local tx_hash
  tx_hash="$(
    cast send --private-key "${BUILDER_KEY}" \
      --rpc-url "${L1_RPC_URL}" \
      "${proxy_addr}" \
      --value "${amount_eth}ether" \
      --json | jq -r '.transactionHash'
  )"
  log "  L1 tx hash: ${tx_hash}"

  wait_for_sync_true "${PUBLIC_FULLNODE_RPC_URL}" 240 || {
    echo "Error: public fullnode did not re-sync after funding ${label}"
    exit 1
  }
  wait_for_sync_true "${BUILDER_FULLNODE_RPC_URL}" 240 || {
    echo "Error: builder fullnode did not re-sync after funding ${label}"
    exit 1
  }
  wait_for_builder_synced 240 || {
    echo "Error: builder did not re-sync after funding ${label}"
    exit 1
  }
}

deploy_counter_on_l2_from_user1() {
  log "Deploying advanced Counter on L2 from User #1..."

  local deploy_nonce
  deploy_nonce="$(cast nonce "${USER1_ADDR}" --rpc-url "${PUBLIC_FULLNODE_RPC_URL}")"
  COUNTER_ADDR="$(
    cast compute-address --nonce "${deploy_nonce}" "${USER1_ADDR}" \
      | rg -o '0x[0-9a-fA-F]{40}' \
      | tail -n 1
  )"
  if [ -z "${COUNTER_ADDR}" ]; then
    echo "Error: could not compute expected L2 Counter address"
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
      --private-key "${USER1_KEY}" \
      --rpc-url "${L2_PROXY_URL}" \
      --create "${counter_bytecode}" 2>&1
  )"
  COUNTER_L1_TX_HASH="$(echo "${deploy_out}" | rg -o '0x[0-9a-fA-F]{64}' | tail -n 1)"
  if [ -z "${COUNTER_L1_TX_HASH}" ]; then
    echo "Error: could not parse Counter deploy tx hash"
    echo "${deploy_out}"
    exit 1
  fi
  log "Counter deploy L1 tx hash: ${COUNTER_L1_TX_HASH}"
  log "Expected L2 Counter address: ${COUNTER_ADDR}"

  wait_for_sync_true "${PUBLIC_FULLNODE_RPC_URL}" 240 || {
    echo "Error: public fullnode did not re-sync after L2 Counter deploy"
    exit 1
  }
  wait_for_sync_true "${BUILDER_FULLNODE_RPC_URL}" 240 || {
    echo "Error: builder fullnode did not re-sync after L2 Counter deploy"
    exit 1
  }
  wait_for_builder_synced 240 || {
    echo "Error: builder did not re-sync after L2 Counter deploy"
    exit 1
  }

  local code
  code="$(cast code "${COUNTER_ADDR}" --rpc-url "${PUBLIC_FULLNODE_RPC_URL}")"
  if [ "${code}" = "0x" ]; then
    echo "Error: deployed Counter code empty on L2"
    exit 1
  fi
}

print_summary() {
  local builder_status
  builder_status="$(curl -s "${BUILDER_URL}/status")"
  local public_sync
  public_sync="$(curl -s "${PUBLIC_FULLNODE_RPC_URL}" \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","method":"syncrollups_isSynced","params":[],"id":1}' | jq -r '.result')"

  echo ""
  echo "============================================"
  echo "Gnosis setup complete"
  echo "============================================"
  echo "L1 RPC:             ${L1_RPC_URL}"
  echo "Rollups:            ${ROLLUPS_ADDR}"
  echo "Verifier:           ${VERIFIER_ADDR}"
  echo "Deployment block:   ${DEPLOYMENT_BLOCK}"
  echo "L1 Counter:         ${L1_COUNTER_ADDR}"
  echo ""
  echo "Roles:"
  echo "  Prover:           ${PROVER_ADDR}"
  echo "  Builder:          ${BUILDER_ADDR}"
  echo "  User #1:          ${USER1_ADDR}"
  echo "  User #2:          ${USER2_ADDR}"
  echo ""
  echo "L2 deployment:"
  echo "  L2 Counter:       ${COUNTER_ADDR}"
  echo "  L1 tx hash:       ${COUNTER_L1_TX_HASH}"
  echo ""
  echo "Sync:"
  echo "  Public fullnode:  ${public_sync}"
  echo "  Builder synced:   $(echo "${builder_status}" | jq -r '.isSynced')"
  echo ""
  echo "Files:"
  echo "  Env:              ${ENV_FILE}"
  echo "  UI wallets:       ${UI_WALLETS_FILE}"
  echo ""
  echo "Endpoints:"
  echo "  Dashboard:        http://localhost:${UI_PORT}"
  echo "  L1 Proxy:         http://localhost:${L1_PROXY_PORT}"
  echo "  L2 Proxy:         http://localhost:${L2_PROXY_PORT}"
  echo "  Public L2 RPC:    ${PUBLIC_FULLNODE_RPC_URL}"
  echo "  Builder API:      ${BUILDER_URL}"
  echo "  Proofer API:      ${PROOFER_URL}"
  echo "  Proofer L2 RPC:   ${PROOFER_FULLNODE_RPC_URL}"
  echo ""
}

# ---------- Run ----------
derive_role_addresses
check_prereqs
stop_existing_services
deploy_l1_contracts
write_runtime_files
start_services
fund_l1_user_if_requested "${USER1_ADDR}" "${FUND_L1_USER1_ETH}" "User #1"
fund_l1_user_if_requested "${USER2_ADDR}" "${FUND_L1_USER2_ETH}" "User #2"
fund_l2_user_via_l1 "${USER1_ADDR}" "${FUND_L2_USER1_ETH}" "User #1"
fund_l2_user_via_l1 "${USER2_ADDR}" "${FUND_L2_USER2_ETH}" "User #2"
deploy_counter_on_l2_from_user1
print_summary
