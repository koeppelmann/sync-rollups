# sync-rollups tooling

Fullnode and builder infrastructure for [sync-rollups](../) — a synchronous rollup protocol where L2 state is deterministically derived from L1 events.

## Architecture

```
                         L1 (Anvil)
                             |
              +--------------+--------------+
              |                             |
         L1 RPC Proxy                  Rollups Contract
         (port 8546)                   (state root, events)
              |                             |
              v                             v
          Builder API               Public Fullnode
         (port 3200)             (L2 EVM port 9546, RPC 9547)
              |                             |
     Builder Fullnode                  L2 RPC Proxy
  (L2 EVM 9549, RPC 9550)            (port 9548)
```

**Fullnode**: Watches L1 for `StateUpdated` / `L2ExecutionPerformed` events and deterministically replays all L2 executions on a local [reth](https://github.com/paradigmxyz/reth) instance. Every fullnode with the same config independently computes the same L2 state.

**Builder**: Accepts L2 transactions (via L2 proxy) and L1-to-L2 calls (via `/prepare-l1-call`), simulates them on its private fullnode, creates execution plans with state proofs, loads them on L1, and broadcasts the transactions.

**L1 RPC Proxy** (port 8546): Sits between wallets and Anvil. Forwards most requests directly; routes hinted L1-to-L2 transactions through the builder.

**L2 RPC Proxy** (port 9548): Sits between wallets and the public fullnode. Intercepts `eth_sendRawTransaction` and routes L2 transactions through the builder (which wraps them in `executeL2TX` on L1).

## Prerequisites

- **Node.js** >= 18
- **[Foundry](https://book.getfoundry.sh/getting-started/installation)** (`forge`, `cast`, `anvil`)
- **[reth](https://paradigmxyz.github.io/reth/installation/installation.html)** — must be available on `$PATH`
- The **sync-rollups** Solidity contracts must be compiled:
  ```bash
  # From the repo root (parent of this tooling/ directory)
  forge build
  ```

Install tooling dependencies:

```bash
cd tooling
npm install
```

## Quick Start (Local)

The `start-local.sh` script starts a complete local environment:

```bash
./start-local.sh
```

This will:
1. Start an L1 Anvil node (port 8545)
2. Deploy `AdminZKVerifier` and `Rollups` contracts
3. Compute the deterministic L2 genesis state root
4. Create rollup 0 with the computed genesis
5. Start a **public fullnode** (L2 EVM on port 9546, RPC on port 9547)
6. Start a **builder fullnode** (L2 EVM on port 9549, RPC on port 9550)
7. Start the **builder** API (port 3200)
8. Start **L1 RPC Proxy** (port 8546) and **L2 RPC Proxy** (port 9548)
9. Start the **dashboard** UI (port 8080)

### Wallet Configuration

| Network       | Chain ID   | RPC URL                      |
|---------------|------------|------------------------------|
| L1 Anvil      | 31337      | `http://localhost:8546`      |
| L2 Sync Rollup| 10200200   | `http://localhost:9548`      |

Both URLs point to proxies that handle transaction routing automatically.

### Test Accounts (Anvil defaults)

| Account   | Address                                      | Private Key |
|-----------|----------------------------------------------|-------------|
| Admin (#1)| `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` | `0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80` |
| User (#2) | `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` | `0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d` |

### Stopping

```bash
pkill -f 'fullnode|builder|reth|anvil|http.server|rpc-proxy'
```

## How It Works

### L2 Transaction Flow

1. Wallet sends a signed L2 transaction to the **L2 RPC Proxy** (port 9548)
2. The proxy forwards it to the **Builder** API (`/submit`)
3. Builder simulates the transaction on its private fullnode to get the post-execution state root
4. Builder creates an execution plan, signs a proof, and loads it on L1 via `loadExecutions()`
5. Builder calls `executeL2TX()` on L1, which emits an `L2ExecutionPerformed` event
6. Both fullnodes detect the L1 event and replay the L2 transaction on their local reth
7. The public fullnode's reth now has the transaction and its receipt, which the L2 proxy returns to the wallet

### L1-to-L2 Call Flow

1. UI/wallet calls the Builder's `/prepare-l1-call` endpoint with the L2 target, calldata, and value
2. Builder computes a deterministic L2Proxy address, deploys it on L1 if needed
3. Builder simulates the call on its private L2 to get the resulting state root
4. Builder loads the execution plan on L1
5. User sends an L1 transaction to the proxy address (through the L1 RPC Proxy on port 8546)
6. The Rollups contract processes the call using the pre-loaded execution plan
7. Fullnodes detect the L1 event and replay the L1-to-L2 call on their local reth

### L1 Reorg Handling

The fullnode maintains a block hash history and L1-to-L2 checkpoints. When an L1 reorg is detected:

1. Binary search identifies the fork point
2. The checkpoint closest to (but before) the fork point is found
3. reth is stopped, unwound to the checkpoint's L2 block via `reth stage unwind`, and restarted
4. Tracked state is restored from the checkpoint
5. Events are re-processed from the fork point

### Deterministic Genesis

All fullnodes derive the same operator key from public parameters:

```
operatorKey = keccak256("sync-rollups-operator" || rollupsAddress || rollupId || chainId)
```

The genesis state includes:
- **L2Authority** contract at the Rollups contract address (enables proxy deployment and system calls)
- **L2Proxy** implementation contract at its L1 address
- Operator account funded with ETH for transaction signing

This ensures every fullnode independently computes the same genesis state root.

## Running Components Individually

### Fullnode

```bash
npx tsx fullnode/fullnode.ts \
  --rollups <ROLLUPS_ADDRESS> \
  --rollup-id 0 \
  --l1-rpc http://localhost:8545 \
  --start-block <DEPLOYMENT_BLOCK> \
  --l2-port 9546 \
  --rpc-port 9547 \
  --initial-state <GENESIS_STATE_ROOT> \
  --l2-proxy-impl <L2PROXY_IMPL_ADDRESS> \
  --contracts-out /path/to/sync-rollups/out
```

The fullnode:
- Starts a reth instance in dev mode (`--dev --dev.block-time 1s`)
- Generates a custom genesis with L2Authority and L2Proxy contracts
- Polls L1 for events and replays executions on the local reth
- Exposes a JSON-RPC server that multiplexes standard Ethereum RPCs (forwarded to reth) with custom `syncrollups_*` methods

### Builder

```bash
npx tsx builder/builder.ts \
  --rollups <ROLLUPS_ADDRESS> \
  --rollup-id 0 \
  --l1-rpc http://localhost:8545 \
  --admin-key <ADMIN_PRIVATE_KEY> \
  --fullnode http://localhost:9550 \
  --port 3200
```

### L1 RPC Proxy

```bash
npx tsx builder/rpc-proxy.ts \
  --port 8546 \
  --rpc http://localhost:8545 \
  --builder http://localhost:3200
```

### L2 RPC Proxy

```bash
npx tsx builder/l2-rpc-proxy.ts \
  --port 9548 \
  --rpc http://localhost:9547 \
  --builder http://localhost:3200
```

## Custom RPC Methods

The fullnode RPC server exposes these `syncrollups_*` methods alongside standard Ethereum JSON-RPC:

| Method | Description |
|--------|-------------|
| `syncrollups_getStateRoot` | Returns the tracked rollup state root |
| `syncrollups_getActualStateRoot` | Returns the actual L2 EVM state root from reth |
| `syncrollups_getL1State` | Returns the L1 contract's state root and ether balance |
| `syncrollups_isSynced` | Checks if tracked state matches L1 and L2 EVM agrees |
| `syncrollups_loadExecutions` | Pre-load execution plans (used by builder) |
| `syncrollups_simulate` | Simulate an action and return state deltas |
| `syncrollups_simulateL1Call` | Execute an L1-to-L2 call on the builder's L2 |
| `syncrollups_getL2BlockNumber` | Returns the current L2 block number |

## Builder API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/submit` | POST | Submit an L1 or L2 transaction |
| `/prepare-l1-call` | POST | Prepare an L1-to-L2 call (deploy proxy, load executions) |
| `/prepare-l2-call` | POST | Prepare an L2-to-L1 call |
| `/status` | GET | Get builder sync status |

## Project Structure

```
tooling/
├── fullnode/
│   ├── fullnode.ts          # Main orchestrator
│   ├── state-manager.ts     # reth lifecycle, genesis, operator key, system calls
│   ├── event-processor.ts   # L1 event watching, replay, reorg detection
│   └── rpc-server.ts        # JSON-RPC server (Ethereum + syncrollups methods)
├── builder/
│   ├── builder.ts           # Builder API server
│   ├── execution-planner.ts # Simulation and execution plan creation
│   ├── rpc-proxy.ts         # L1 RPC proxy
│   └── l2-rpc-proxy.ts      # L2 RPC proxy
├── scripts/
│   └── compute-genesis-root.ts  # Standalone genesis state root computation
├── ui/
│   └── index.html           # Dashboard (single-file)
├── start-local.sh           # Start complete local environment
├── start-gnosis.sh          # Start against Gnosis Chain (Chiado)
└── setup-gnosis.sh          # Deploy contracts to Gnosis/Chiado
```

## Dashboard

Open `http://localhost:8080` after starting the local environment. The dashboard shows:

- L1 and L2 state roots and sync status
- L2 block number
- Transaction submission form (supports L2 direct transactions and L1-to-L2 proxy calls)
- Contract interaction with function selector dropdown
- Simulation (read-only calls) and transaction sending
