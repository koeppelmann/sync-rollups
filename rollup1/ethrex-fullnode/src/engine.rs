/// Engine API client for driving ethrex block production.
///
/// Uses the Engine API (V3/Cancun) to:
/// 1. Request a new payload (forkchoiceUpdatedV3 with payload attributes)
/// 2. Get the built payload (getPayloadV3)
/// 3. Submit the new payload (newPayloadV3)
/// 4. Update fork choice to make it canonical (forkchoiceUpdatedV3)
use eyre::{Result, bail};
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::Sha256;
use tracing::debug;

use crate::rpc_client::RpcClient;

pub struct EngineClient {
    client: RpcClient,
    jwt_secret: Vec<u8>,
}

impl EngineClient {
    pub fn new(engine_url: &str, jwt_secret_hex: &str) -> Self {
        let jwt_secret = hex::decode(jwt_secret_hex.trim()).unwrap_or_default();
        Self {
            client: RpcClient::new(engine_url),
            jwt_secret,
        }
    }

    /// Generate a JWT token for engine API authentication (HS256)
    fn generate_jwt(&self) -> String {
        let header = base64url_encode(r#"{"alg":"HS256","typ":"JWT"}"#.as_bytes());
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let payload = base64url_encode(format!(r#"{{"iat":{now}}}"#).as_bytes());

        let signing_input = format!("{header}.{payload}");
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.jwt_secret)
            .expect("HMAC can take key of any size");
        mac.update(signing_input.as_bytes());
        let signature = base64url_encode(&mac.finalize().into_bytes());

        format!("{signing_input}.{signature}")
    }

    /// Call an engine API method with JWT auth
    async fn engine_call(&self, method: &str, params: Value) -> Result<Value> {
        let token = self.generate_jwt();
        self.client.call_auth(method, params, &token).await
    }

    /// Mine a block using the Engine API.
    ///
    /// This produces one L2 block containing all pending txpool transactions.
    /// The coinbase and timestamp can be specified per the state transition spec.
    ///
    /// Returns the new block hash and state root.
    pub async fn mine_block(
        &self,
        l2_client: &RpcClient,
        coinbase: Option<&str>,
        timestamp: Option<u64>,
    ) -> Result<(String, String)> {
        // Get the current head block
        let head_block = l2_client.get_latest_block().await?;
        let head_hash = head_block["hash"].as_str().unwrap_or_default().to_string();
        let head_timestamp = u64::from_str_radix(
            head_block["timestamp"]
                .as_str()
                .unwrap_or("0x0")
                .strip_prefix("0x")
                .unwrap_or("0"),
            16,
        )?;

        // Use provided timestamp or increment by 1
        let mut block_timestamp = timestamp.unwrap_or(head_timestamp + 1);
        if block_timestamp <= head_timestamp {
            block_timestamp = head_timestamp + 1;
        }

        let fee_recipient = coinbase.unwrap_or("0x0000000000000000000000000000000000000000");

        // Step 1: forkchoiceUpdated with payload attributes
        let payload_attributes = json!({
            "timestamp": format!("0x{:x}", block_timestamp),
            "prevRandao": "0x0000000000000000000000000000000000000000000000000000000000000000",
            "suggestedFeeRecipient": fee_recipient,
            "withdrawals": [],
            "parentBeaconBlockRoot": "0x0000000000000000000000000000000000000000000000000000000000000000",
        });

        let fcu_result = self.engine_call("engine_forkchoiceUpdatedV3", json!([
            {
                "headBlockHash": head_hash,
                "safeBlockHash": head_hash,
                "finalizedBlockHash": head_hash,
            },
            payload_attributes,
        ])).await?;

        let payload_id = fcu_result["payloadId"]
            .as_str()
            .ok_or_else(|| eyre::eyre!("engine_forkchoiceUpdatedV3 did not return payloadId"))?
            .to_string();

        debug!("Got payloadId: {payload_id}");

        // Step 2: Get the built payload
        let payload = self.engine_call("engine_getPayloadV3", json!([payload_id])).await?;
        let execution_payload = &payload["executionPayload"];

        // Step 3: Submit the new payload
        let new_payload_result = self.engine_call("engine_newPayloadV3", json!([
            execution_payload,
            [],  // no blob versioned hashes
            "0x0000000000000000000000000000000000000000000000000000000000000000",  // parentBeaconBlockRoot
        ])).await?;

        let status = new_payload_result["status"].as_str().unwrap_or("");
        if status != "VALID" {
            let validation_error = new_payload_result["validationError"]
                .as_str()
                .unwrap_or("unknown");
            bail!("engine_newPayloadV3 returned {status}: {validation_error}");
        }

        // Step 4: Update fork choice to make the new block canonical
        let new_hash = execution_payload["blockHash"]
            .as_str()
            .unwrap_or_default()
            .to_string();

        self.engine_call("engine_forkchoiceUpdatedV3", json!([
            {
                "headBlockHash": new_hash,
                "safeBlockHash": new_hash,
                "finalizedBlockHash": new_hash,
            },
            null,
        ])).await?;

        // Get the state root from the execution payload
        let state_root = execution_payload["stateRoot"]
            .as_str()
            .unwrap_or_default()
            .to_string();

        debug!("Mined block {new_hash}, stateRoot: {state_root}");

        Ok((new_hash, state_root))
    }
}

/// Base64url encode without padding
fn base64url_encode(data: &[u8]) -> String {
    // Manual base64url implementation (no extra dependency)
    let encoded: String = data
        .chunks(3)
        .flat_map(|chunk| {
            let b0 = chunk[0] as u32;
            let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
            let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
            let triple = (b0 << 16) | (b1 << 8) | b2;

            let chars: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
            let mut result = vec![chars[((triple >> 18) & 0x3F) as usize] as char];
            result.push(chars[((triple >> 12) & 0x3F) as usize] as char);
            if chunk.len() > 1 {
                result.push(chars[((triple >> 6) & 0x3F) as usize] as char);
            }
            if chunk.len() > 2 {
                result.push(chars[(triple & 0x3F) as usize] as char);
            }
            result
        })
        .collect();
    encoded
}
