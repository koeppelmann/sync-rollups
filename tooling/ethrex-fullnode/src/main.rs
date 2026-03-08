/// Ethrex-based L2 fullnode for sync-rollups.
///
/// This binary:
/// 1. Generates a genesis file identical to the reth-based fullnode
/// 2. Starts ethrex as a child process with Engine API enabled
/// 3. Watches L1 for rollup events
/// 4. Replays L2 executions via the Engine API
/// 5. Exposes an RPC endpoint for sync status queries
use alloy_primitives::{Address, B256};
use clap::Parser;
use eyre::Result;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use tokio::time::{Duration, sleep};
use tracing::{error, info, warn};

use sync_rollups_ethrex_fullnode::engine::EngineClient;
use sync_rollups_ethrex_fullnode::event_processor::EventProcessor;
use sync_rollups_ethrex_fullnode::genesis;
use sync_rollups_ethrex_fullnode::l1_watcher::L1Watcher;
use sync_rollups_ethrex_fullnode::rpc_client::RpcClient;
use sync_rollups_ethrex_fullnode::tx_signer::TxSigner;

#[derive(Parser, Debug)]
#[command(name = "sync-rollups-ethrex-fullnode")]
#[command(about = "Ethrex-based L2 fullnode for sync-rollups")]
struct Args {
    /// L1 RPC URL (e.g. http://localhost:8545)
    #[arg(long, env = "L1_RPC_URL", default_value = "http://localhost:8545")]
    l1_rpc_url: String,

    /// Rollups contract address on L1
    #[arg(long, env = "ROLLUPS_ADDRESS")]
    rollups_address: String,

    /// Rollup ID
    #[arg(long, env = "ROLLUP_ID", default_value = "1")]
    rollup_id: u64,

    /// L2 chain ID
    #[arg(long, env = "L2_CHAIN_ID", default_value = "1337")]
    l2_chain_id: u64,

    /// L1 block number at which the Rollups contract was deployed
    #[arg(long, env = "DEPLOYMENT_BLOCK", default_value = "0")]
    deployment_block: u64,

    /// Path to ethrex binary
    #[arg(long, env = "ETHREX_BIN", default_value = "ethrex")]
    ethrex_bin: String,

    /// Path to forge output directory (for CrossChainManagerL2 artifact)
    #[arg(long, env = "CONTRACTS_OUT_DIR", default_value = "../out")]
    contracts_out_dir: PathBuf,

    /// Data directory for ethrex
    #[arg(long, env = "DATADIR", default_value = "./state/ethrex")]
    datadir: PathBuf,

    /// L2 HTTP RPC port
    #[arg(long, env = "L2_RPC_PORT", default_value = "9546")]
    l2_rpc_port: u16,

    /// L2 Engine API (authrpc) port
    #[arg(long, env = "L2_ENGINE_PORT", default_value = "9551")]
    l2_engine_port: u16,

    /// L2 P2P port (discovery)
    #[arg(long, env = "L2_P2P_PORT", default_value = "30305")]
    l2_p2p_port: u16,

    /// Status RPC port for this fullnode process
    #[arg(long, env = "STATUS_RPC_PORT", default_value = "3201")]
    status_rpc_port: u16,

    /// Poll interval in milliseconds
    #[arg(long, env = "POLL_INTERVAL_MS", default_value = "1000")]
    poll_interval_ms: u64,

    /// Log directory for ethrex output
    #[arg(long, env = "LOG_DIR", default_value = "./logs")]
    log_dir: PathBuf,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    let args = Args::parse();

    let rollups_address: Address = args
        .rollups_address
        .parse()
        .map_err(|e| eyre::eyre!("Invalid rollups address: {e}"))?;

    info!("Sync-Rollups Ethrex Fullnode starting");
    info!("  L1 RPC: {}", args.l1_rpc_url);
    info!("  Rollups: {:?}", rollups_address);
    info!("  Rollup ID: {}", args.rollup_id);
    info!("  L2 Chain ID: {}", args.l2_chain_id);

    // Derive operator key (same derivation as TypeScript fullnode)
    let operator_key = genesis::derive_operator_key(&rollups_address, args.rollup_id, args.l2_chain_id);
    let operator_addr = genesis::operator_address(&operator_key)?;
    info!("  Operator: {:?}", operator_addr);

    // Generate JWT secret for Engine API
    let jwt_secret = generate_jwt_secret(&args.datadir)?;
    let jwt_secret_hex = hex::encode(&jwt_secret);

    // Generate genesis
    let genesis_path = args.datadir.join("genesis.json");
    let bytecode = genesis::load_cross_chain_manager_bytecode(
        &args.contracts_out_dir,
        args.rollup_id,
        &operator_addr,
    )?;

    genesis::generate_genesis(
        &rollups_address,
        &operator_addr,
        bytecode.as_deref(),
        args.l2_chain_id,
        &genesis_path,
    )?;

    // Start ethrex
    let mut ethrex_process = start_ethrex(
        &args.ethrex_bin,
        &genesis_path,
        &args.datadir,
        &jwt_secret_hex,
        args.l2_rpc_port,
        args.l2_engine_port,
        args.l2_p2p_port,
        &args.log_dir,
    )?;

    // Wait for ethrex to be ready
    let l2_rpc_url = format!("http://localhost:{}", args.l2_rpc_port);
    let l2_engine_url = format!("http://localhost:{}", args.l2_engine_port);
    wait_for_rpc(&l2_rpc_url, 30).await?;

    // Get initial state root from genesis block
    let l2_client = RpcClient::new(&l2_rpc_url);
    let genesis_block = l2_client.get_latest_block().await?;
    let initial_state_root_hex = genesis_block["stateRoot"].as_str().unwrap_or("0x");
    let initial_state_root_bytes = hex::decode(
        initial_state_root_hex.strip_prefix("0x").unwrap_or(initial_state_root_hex),
    )?;
    let initial_state_root = if initial_state_root_bytes.len() == 32 {
        B256::from_slice(&initial_state_root_bytes)
    } else {
        B256::ZERO
    };
    info!("Genesis state root: 0x{}", hex::encode(&initial_state_root.0));

    // Verify chain ID
    let chain_id = l2_client.get_chain_id().await?;
    if chain_id != args.l2_chain_id {
        eyre::bail!(
            "Chain ID mismatch: expected {}, got {}",
            args.l2_chain_id,
            chain_id
        );
    }

    // Initialize operator nonce
    let operator_addr_hex = format!("{:?}", operator_addr);
    let initial_nonce = l2_client.get_transaction_count(&operator_addr_hex).await?;

    // Create components
    let engine = EngineClient::new(&l2_engine_url, &jwt_secret_hex);
    let tx_signer = TxSigner::new(&operator_key, operator_addr, args.l2_chain_id, initial_nonce)?;
    let l1_watcher = L1Watcher::new(
        &args.l1_rpc_url,
        rollups_address,
        args.rollup_id,
        args.deployment_block,
    );

    let mut event_processor = EventProcessor::new(
        l1_watcher,
        l2_client,
        engine,
        tx_signer,
        rollups_address,
        args.rollup_id,
        args.l2_chain_id,
        initial_state_root,
    );

    // Start status RPC server
    let status_port = args.status_rpc_port;
    let l2_rpc_url_clone = l2_rpc_url.clone();
    tokio::spawn(async move {
        if let Err(e) = run_status_rpc(status_port, &l2_rpc_url_clone).await {
            error!("Status RPC server error: {e}");
        }
    });

    info!("Starting L1 event polling (interval: {}ms)", args.poll_interval_ms);
    let poll_interval = Duration::from_millis(args.poll_interval_ms);

    // Main loop
    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                info!("Shutting down...");
                let _ = ethrex_process.kill();
                break;
            }
            _ = async {
                match event_processor.process_cycle().await {
                    Ok(true) => {
                        info!(
                            "Events processed. State: 0x{}..., L1 block: {}",
                            &hex::encode(&event_processor.tracked_state_root().0)[..8],
                            event_processor.last_processed_l1_block(),
                        );
                    }
                    Ok(false) => {} // No new events
                    Err(e) => {
                        warn!("Error processing events: {e}");
                    }
                }
                sleep(poll_interval).await;
            } => {}
        }
    }

    Ok(())
}

/// Generate a deterministic JWT secret for Engine API auth.
/// Uses a fixed secret derived from the data directory path.
fn generate_jwt_secret(datadir: &Path) -> Result<Vec<u8>> {
    use tiny_keccak::{Hasher, Keccak};

    let jwt_path = datadir.join("jwt.hex");
    if jwt_path.exists() {
        let content = std::fs::read_to_string(&jwt_path)?;
        return Ok(hex::decode(content.trim())?);
    }

    // Generate deterministic secret
    let mut hasher = Keccak::v256();
    hasher.update(b"sync-rollups-ethrex-jwt");
    hasher.update(datadir.to_string_lossy().as_bytes());
    let mut secret = [0u8; 32];
    hasher.finalize(&mut secret);

    std::fs::create_dir_all(datadir)?;
    std::fs::write(&jwt_path, hex::encode(&secret))?;
    info!("JWT secret written to {}", jwt_path.display());

    Ok(secret.to_vec())
}

/// Start ethrex as a child process
fn start_ethrex(
    ethrex_bin: &str,
    genesis_path: &Path,
    datadir: &Path,
    _jwt_secret_hex: &str,
    rpc_port: u16,
    engine_port: u16,
    p2p_port: u16,
    log_dir: &Path,
) -> Result<Child> {
    std::fs::create_dir_all(log_dir)?;

    let jwt_path = datadir.join("jwt.hex");

    let stdout_file = std::fs::File::create(log_dir.join("ethrex-stdout.log"))?;
    let stderr_file = std::fs::File::create(log_dir.join("ethrex-stderr.log"))?;

    info!("Starting ethrex: {} --network {} --datadir {} --http.port {} --authrpc.port {} --discovery.port {}",
        ethrex_bin,
        genesis_path.display(),
        datadir.display(),
        rpc_port,
        engine_port,
        p2p_port,
    );

    // Use a separate subdirectory for ethrex's database to avoid conflicts with genesis/jwt files
    let db_dir = datadir.join("db");
    std::fs::create_dir_all(&db_dir)?;

    let child = Command::new(ethrex_bin)
        .arg("--network")
        .arg(genesis_path)
        .arg("--datadir")
        .arg(&db_dir)
        .arg("--http.port")
        .arg(rpc_port.to_string())
        .arg("--authrpc.port")
        .arg(engine_port.to_string())
        .arg("--authrpc.jwtsecret")
        .arg(&jwt_path)
        .arg("--p2p.port")
        .arg(p2p_port.to_string())
        .arg("--discovery.port")
        .arg(p2p_port.to_string())
        .arg("--syncmode")
        .arg("full")
        .stdout(Stdio::from(stdout_file))
        .stderr(Stdio::from(stderr_file))
        .spawn()
        .map_err(|e| eyre::eyre!("Failed to start ethrex: {e}"))?;

    info!("ethrex started with PID {}", child.id());
    Ok(child)
}

/// Wait for the L2 RPC to become available
async fn wait_for_rpc(url: &str, timeout_secs: u64) -> Result<()> {
    let client = RpcClient::new(url);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout_secs);

    info!("Waiting for ethrex RPC at {url}...");
    loop {
        match client.get_block_number().await {
            Ok(block) => {
                info!("ethrex ready at block {block}");
                return Ok(());
            }
            Err(_) => {
                if tokio::time::Instant::now() > deadline {
                    eyre::bail!("Timeout waiting for ethrex RPC at {url}");
                }
                sleep(Duration::from_millis(500)).await;
            }
        }
    }
}

/// Simple status RPC server (syncrollups_isSynced, syncrollups_status)
async fn run_status_rpc(port: u16, l2_rpc_url: &str) -> Result<()> {
    use std::io::{Read as _, Write as _};
    use std::net::TcpListener;

    let listener = TcpListener::bind(format!("0.0.0.0:{port}"))?;
    listener.set_nonblocking(true)?;
    info!("Status RPC listening on port {port}");

    let l2_url = l2_rpc_url.to_string();

    loop {
        match listener.accept() {
            Ok((mut stream, _)) => {
                let l2_url = l2_url.clone();
                tokio::task::spawn_blocking(move || {
                    let mut buf = [0u8; 4096];
                    let n = stream.read(&mut buf).unwrap_or(0);
                    let request = String::from_utf8_lossy(&buf[..n]);

                    // Extract JSON body (after \r\n\r\n)
                    let body = request
                        .split("\r\n\r\n")
                        .nth(1)
                        .unwrap_or("")
                        .to_string();

                    let response_body = handle_status_request(&body, &l2_url);

                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: Content-Type\r\nContent-Length: {}\r\n\r\n{}",
                        response_body.len(),
                        response_body
                    );
                    let _ = stream.write_all(response.as_bytes());
                });
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Err(e) => {
                warn!("Status RPC accept error: {e}");
            }
        }
    }
}

fn handle_status_request(body: &str, _l2_rpc_url: &str) -> String {
    let parsed: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
    let method = parsed["method"].as_str().unwrap_or("");
    let id = &parsed["id"];

    let result = match method {
        "syncrollups_isSynced" => serde_json::json!(true),
        "syncrollups_status" => serde_json::json!({
            "client": "ethrex",
            "synced": true,
        }),
        _ => serde_json::json!(null),
    };

    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result,
    })
    .to_string()
}
