/// Genesis state generation for the ethrex-based L2 fullnode.
///
/// Produces an identical genesis to the reth-based fullnode:
/// - CrossChainManagerL2 deployed at the Rollups address
/// - Operator account pre-funded with 10^30 wei
///
/// The operator key is derived deterministically:
///   keccak256("sync-rollups-operator" || rollupsAddress || rollupId || chainId)
use alloy_primitives::{Address, B256};
use eyre::Result;
use serde_json::{Value, json};
use std::fs;
use std::path::Path;
use tiny_keccak::{Hasher, Keccak};
use tracing::info;

/// 10^30 wei — same as the TypeScript fullnode
const OPERATOR_INITIAL_BALANCE: &str = "0xc9f2c9cd04674edea40000000";

/// Derive the operator private key deterministically from public parameters.
pub fn derive_operator_key(rollups_address: &Address, rollup_id: u64, chain_id: u64) -> B256 {
    // solidityPackedKeccak256(["string", "address", "uint256", "uint256"], [...])
    // Packed encoding: raw string bytes || 20-byte address || 32-byte uint256 || 32-byte uint256
    let mut data = Vec::new();

    // string: raw UTF-8 bytes (no length prefix in packed encoding)
    data.extend_from_slice(b"sync-rollups-operator");

    // address: 20 bytes
    data.extend_from_slice(rollups_address.as_slice());

    // uint256: 32 bytes, big-endian
    let mut rollup_id_bytes = [0u8; 32];
    rollup_id_bytes[24..32].copy_from_slice(&rollup_id.to_be_bytes());
    data.extend_from_slice(&rollup_id_bytes);

    // uint256: 32 bytes, big-endian
    let mut chain_id_bytes = [0u8; 32];
    chain_id_bytes[24..32].copy_from_slice(&chain_id.to_be_bytes());
    data.extend_from_slice(&chain_id_bytes);

    let mut hasher = Keccak::v256();
    hasher.update(&data);
    let mut output = [0u8; 32];
    hasher.finalize(&mut output);
    B256::from(output)
}

/// Derive the operator address from the private key
pub fn operator_address(private_key: &B256) -> Result<Address> {
    use k256::ecdsa::SigningKey;
    let signing_key = SigningKey::from_bytes(private_key.as_slice().into())
        .map_err(|e| eyre::eyre!("Invalid private key: {e}"))?;
    let public_key = signing_key.verifying_key().to_encoded_point(false);
    let public_key_bytes = &public_key.as_bytes()[1..]; // skip 0x04 prefix

    let mut hasher = Keccak::v256();
    hasher.update(public_key_bytes);
    let mut hash = [0u8; 32];
    hasher.finalize(&mut hash);

    // Address is last 20 bytes of keccak256(pubkey)
    Ok(Address::from_slice(&hash[12..32]))
}

/// Generate a genesis JSON file compatible with ethrex.
///
/// The genesis format follows the standard Ethereum genesis format (geth-compatible).
/// ethrex accepts the same format as reth/geth.
pub fn generate_genesis(
    rollups_address: &Address,
    operator_addr: &Address,
    cross_chain_manager_bytecode: Option<&str>,
    l2_chain_id: u64,
    output_path: &Path,
) -> Result<()> {
    let mut alloc = json!({});

    // Fund the operator account
    let operator_hex = format!("{:?}", operator_addr).to_lowercase();
    alloc[&operator_hex] = json!({
        "balance": OPERATOR_INITIAL_BALANCE,
    });
    info!("Genesis: Operator funded at {operator_hex}");

    // Deploy CrossChainManagerL2 at the Rollups address
    if let Some(bytecode) = cross_chain_manager_bytecode {
        let contract_hex = format!("{:?}", rollups_address).to_lowercase();
        alloc[&contract_hex] = json!({
            "code": bytecode,
            "balance": "0x0",
        });
        info!("Genesis: CrossChainManagerL2 at {contract_hex}");
    }

    let genesis = json!({
        "config": {
            "chainId": l2_chain_id,
            "homesteadBlock": 0,
            "eip150Block": 0,
            "eip155Block": 0,
            "eip158Block": 0,
            "byzantiumBlock": 0,
            "constantinopleBlock": 0,
            "petersburgBlock": 0,
            "istanbulBlock": 0,
            "berlinBlock": 0,
            "londonBlock": 0,
            "shanghaiTime": 0,
            "cancunTime": 0,
            "terminalTotalDifficulty": 0,
            "terminalTotalDifficultyPassed": true,
            "depositContractAddress": "0x4242424242424242424242424242424242424242",
        },
        "nonce": "0x0",
        "timestamp": "0x0",
        "extraData": "0x",
        "gasLimit": "0x1c9c380",
        "difficulty": "0x0",
        "mixHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
        "coinbase": "0x0000000000000000000000000000000000000000",
        "baseFeePerGas": "0x3B9ACA00",
        "number": "0x0",
        "gasUsed": "0x0",
        "parentHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
        "alloc": alloc,
    });

    fs::create_dir_all(output_path.parent().unwrap_or(Path::new(".")))?;
    fs::write(output_path, serde_json::to_string_pretty(&genesis)?)?;
    info!("Genesis written to {}", output_path.display());

    Ok(())
}

/// Load the CrossChainManagerL2 deployed bytecode from the forge artifact
/// and splice in immutable values (ROLLUP_ID, SYSTEM_ADDRESS).
pub fn load_cross_chain_manager_bytecode(
    contracts_out_dir: &Path,
    rollup_id: u64,
    system_address: &Address,
) -> Result<Option<String>> {
    let artifact_path = contracts_out_dir
        .join("CrossChainManagerL2.sol")
        .join("CrossChainManagerL2.json");

    if !artifact_path.exists() {
        tracing::warn!("CrossChainManagerL2 artifact not found at {}", artifact_path.display());
        return Ok(None);
    }

    let artifact: Value = serde_json::from_str(&fs::read_to_string(&artifact_path)?)?;

    let bytecode_hex = artifact["deployedBytecode"]["object"]
        .as_str()
        .ok_or_else(|| eyre::eyre!("No deployedBytecode in artifact"))?;

    let mut code = bytecode_hex
        .strip_prefix("0x")
        .unwrap_or(bytecode_hex)
        .to_string();

    // Splice in immutables using the immutableReferences from the artifact
    if let Some(refs) = artifact["deployedBytecode"]["immutableReferences"].as_object() {
        // Build AST ID → name mapping
        let mut ast_id_to_name: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();

        if let Some(ast) = artifact.get("ast") {
            find_immutables(ast, &mut ast_id_to_name);
        }

        let rollup_id_hex = format!("{:064x}", rollup_id);
        let system_addr_hex = format!("{:0>64}", hex::encode(system_address.as_slice()));

        for (ast_id, ref_list) in refs {
            let name = ast_id_to_name.get(ast_id).map(|s| s.as_str()).unwrap_or("");
            let value = match name {
                "ROLLUP_ID" => &rollup_id_hex,
                "SYSTEM_ADDRESS" => &system_addr_hex,
                _ => {
                    tracing::warn!("Unknown immutable AST ID {ast_id} (name: {name})");
                    continue;
                }
            };

            if let Some(ref_array) = ref_list.as_array() {
                for r in ref_array {
                    let start = r["start"].as_u64().unwrap_or(0) as usize;
                    let length = r["length"].as_u64().unwrap_or(0) as usize;
                    let padded = format!("{:0>width$}", value, width = length * 2);
                    code.replace_range(start * 2..(start + length) * 2, &padded);
                }
            }
        }
    }

    Ok(Some(format!("0x{code}")))
}

/// Recursively find immutable variable declarations in the AST
fn find_immutables(node: &Value, result: &mut std::collections::HashMap<String, String>) {
    if let Some(node_type) = node["nodeType"].as_str() {
        if node_type == "VariableDeclaration" {
            if let Some(mutability) = node["mutability"].as_str() {
                if mutability == "immutable" {
                    if let (Some(id), Some(name)) = (node["id"].as_u64(), node["name"].as_str()) {
                        result.insert(id.to_string(), name.to_string());
                    }
                }
            }
        }
    }

    // Recurse into child nodes
    if let Some(obj) = node.as_object() {
        for (_, v) in obj {
            if v.is_object() {
                find_immutables(v, result);
            } else if let Some(arr) = v.as_array() {
                for item in arr {
                    if item.is_object() {
                        find_immutables(item, result);
                    }
                }
            }
        }
    }
}
