/// Generic JSON-RPC client for communicating with L1 (Anvil) and L2 (ethrex).
use alloy_primitives::B256;
use eyre::{Result, bail};
use reqwest::Client;
use serde_json::{Value, json};
use std::sync::atomic::{AtomicU64, Ordering};
// JSON-RPC client

pub struct RpcClient {
    url: String,
    client: Client,
    id: AtomicU64,
}

impl RpcClient {
    pub fn new(url: &str) -> Self {
        Self {
            url: url.to_string(),
            client: Client::new(),
            id: AtomicU64::new(1),
        }
    }

    /// Send a JSON-RPC request
    pub async fn call(&self, method: &str, params: Value) -> Result<Value> {
        let id = self.id.fetch_add(1, Ordering::SeqCst);
        let body = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
            "id": id,
        });

        let resp = self.client.post(&self.url)
            .json(&body)
            .send()
            .await?
            .json::<Value>()
            .await?;

        if let Some(error) = resp.get("error") {
            bail!("RPC error calling {method}: {error}");
        }

        Ok(resp["result"].clone())
    }

    /// Send a JSON-RPC request with JWT auth (for Engine API)
    pub async fn call_auth(&self, method: &str, params: Value, jwt_token: &str) -> Result<Value> {
        let id = self.id.fetch_add(1, Ordering::SeqCst);
        let body = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
            "id": id,
        });

        let resp = self.client.post(&self.url)
            .header("Authorization", format!("Bearer {jwt_token}"))
            .json(&body)
            .send()
            .await?
            .json::<Value>()
            .await?;

        if let Some(error) = resp.get("error") {
            bail!("Engine API error calling {method}: {error}");
        }

        Ok(resp["result"].clone())
    }

    // Convenience methods

    pub async fn get_block_number(&self) -> Result<u64> {
        let result = self.call("eth_blockNumber", json!([])).await?;
        let hex = result.as_str().unwrap_or("0x0");
        Ok(u64::from_str_radix(hex.strip_prefix("0x").unwrap_or(hex), 16)?)
    }

    pub async fn get_block_by_number(&self, block_number: u64) -> Result<Value> {
        let hex = format!("0x{:x}", block_number);
        self.call("eth_getBlockByNumber", json!([hex, false])).await
    }

    pub async fn get_latest_block(&self) -> Result<Value> {
        self.call("eth_getBlockByNumber", json!(["latest", false])).await
    }

    pub async fn get_transaction_by_hash(&self, tx_hash: B256) -> Result<Value> {
        let hex = format!("0x{}", hex::encode(tx_hash.as_slice()));
        self.call("eth_getTransactionByHash", json!([hex])).await
    }

    pub async fn get_logs(
        &self,
        from_block: u64,
        to_block: u64,
        address: &str,
        topics: &[&str],
    ) -> Result<Vec<Value>> {
        let mut filter = json!({
            "fromBlock": format!("0x{:x}", from_block),
            "toBlock": format!("0x{:x}", to_block),
            "address": address,
        });

        if !topics.is_empty() {
            filter["topics"] = json!(topics);
        }

        let result = self.call("eth_getLogs", json!([filter])).await?;
        Ok(result.as_array().cloned().unwrap_or_default())
    }

    pub async fn get_code(&self, address: &str) -> Result<String> {
        let result = self.call("eth_getCode", json!([address, "latest"])).await?;
        Ok(result.as_str().unwrap_or("0x").to_string())
    }

    pub async fn eth_call(&self, to: &str, data: &str) -> Result<String> {
        let result = self.call("eth_call", json!([{
            "to": to,
            "data": data,
        }, "latest"])).await?;
        Ok(result.as_str().unwrap_or("0x").to_string())
    }

    /// eth_call with from, to, value, and data. Returns (return_data, success).
    /// On revert, returns the revert data with success=false instead of erroring.
    /// Includes the sender's nonce to work around ethrex's nonce validation in eth_call.
    pub async fn eth_call_full(&self, from: &str, to: &str, value: &str, data: &str) -> Result<(String, bool)> {
        // Fetch the sender's current nonce — ethrex validates nonces even in eth_call
        let nonce = self.get_transaction_count(from).await?;
        let nonce_hex = format!("0x{:x}", nonce);

        let id = self.id.fetch_add(1, Ordering::SeqCst);
        let body = json!({
            "jsonrpc": "2.0",
            "method": "eth_call",
            "params": [{
                "from": from,
                "to": to,
                "value": value,
                "data": data,
                "nonce": nonce_hex,
            }, "latest"],
            "id": id,
        });

        let resp = self.client.post(&self.url)
            .json(&body)
            .send()
            .await?
            .json::<Value>()
            .await?;

        if let Some(error) = resp.get("error") {
            // Extract revert data if available
            let revert_data = error.get("data")
                .and_then(|d| d.as_str())
                .unwrap_or("0x")
                .to_string();
            return Ok((revert_data, false));
        }

        let result = resp["result"].as_str().unwrap_or("0x").to_string();
        Ok((result, true))
    }

    pub async fn send_raw_transaction(&self, raw_tx: &str) -> Result<String> {
        let result = self.call("eth_sendRawTransaction", json!([raw_tx])).await?;
        Ok(result.as_str().unwrap_or("").to_string())
    }

    pub async fn get_chain_id(&self) -> Result<u64> {
        let result = self.call("eth_chainId", json!([])).await?;
        let hex = result.as_str().unwrap_or("0x0");
        Ok(u64::from_str_radix(hex.strip_prefix("0x").unwrap_or(hex), 16)?)
    }

    pub async fn get_transaction_count(&self, address: &str) -> Result<u64> {
        let result = self.call("eth_getTransactionCount", json!([address, "latest"])).await?;
        let hex = result.as_str().unwrap_or("0x0");
        Ok(u64::from_str_radix(hex.strip_prefix("0x").unwrap_or(hex), 16)?)
    }

    pub async fn get_transaction_receipt(&self, tx_hash: &str) -> Result<Option<Value>> {
        let result = self.call("eth_getTransactionReceipt", json!([tx_hash])).await?;
        if result.is_null() {
            Ok(None)
        } else {
            Ok(Some(result))
        }
    }

    /// Call authorizedProxies(address) on a contract (Rollups or CrossChainManagerL2).
    /// Returns (originalAddress, originalRollupId).
    pub async fn call_authorized_proxies(
        &self,
        contract_addr: &str,
        proxy_addr: &str,
    ) -> Result<ProxyInfo> {
        // authorizedProxies(address) selector = keccak256("authorizedProxies(address)")[..4]
        use tiny_keccak::{Hasher, Keccak};
        let mut hasher = Keccak::v256();
        hasher.update(b"authorizedProxies(address)");
        let mut hash = [0u8; 32];
        hasher.finalize(&mut hash);
        let selector = &hash[0..4];

        // ABI encode: selector + address padded to 32 bytes
        let proxy_bytes = hex::decode(proxy_addr.strip_prefix("0x").unwrap_or(proxy_addr))?;
        let mut calldata = Vec::from(selector);
        calldata.extend_from_slice(&[0u8; 12]);
        if proxy_bytes.len() == 20 {
            calldata.extend_from_slice(&proxy_bytes);
        } else {
            bail!("Invalid proxy address length: {}", proxy_bytes.len());
        }

        let data_hex = format!("0x{}", hex::encode(&calldata));
        let result = self.eth_call(contract_addr, &data_hex).await?;
        let result_bytes = hex::decode(result.strip_prefix("0x").unwrap_or(&result))?;

        if result_bytes.len() < 64 {
            bail!("authorizedProxies returned too short: {} bytes", result_bytes.len());
        }

        // Returns (address originalAddress, uint64 originalRollupId)
        // Word 0: address (20 bytes, right-aligned in 32 bytes)
        let original_address = alloy_primitives::Address::from_slice(&result_bytes[12..32]);
        // Word 1: uint64 (right-aligned in 32 bytes)
        let original_rollup_id = alloy_primitives::U256::from_be_bytes::<32>(
            result_bytes[32..64].try_into().unwrap_or([0u8; 32]),
        );

        Ok(ProxyInfo {
            original_address,
            original_rollup_id,
        })
    }

    /// Call computeCrossChainProxyAddress(address,uint256,uint256) on a contract.
    /// Returns the deterministic proxy address.
    pub async fn compute_cross_chain_proxy_address(
        &self,
        contract_addr: &str,
        original_address: &alloy_primitives::Address,
        original_rollup_id: alloy_primitives::U256,
        domain: alloy_primitives::U256,
    ) -> Result<alloy_primitives::Address> {
        use tiny_keccak::{Hasher, Keccak};
        let mut hasher = Keccak::v256();
        hasher.update(b"computeCrossChainProxyAddress(address,uint256,uint256)");
        let mut hash = [0u8; 32];
        hasher.finalize(&mut hash);
        let selector = &hash[0..4];

        let mut calldata = Vec::from(selector);
        // address
        calldata.extend_from_slice(&[0u8; 12]);
        calldata.extend_from_slice(original_address.as_slice());
        // originalRollupId
        calldata.extend_from_slice(&original_rollup_id.to_be_bytes::<32>());
        // domain
        calldata.extend_from_slice(&domain.to_be_bytes::<32>());

        let data_hex = format!("0x{}", hex::encode(&calldata));
        let result = self.eth_call(contract_addr, &data_hex).await?;
        let result_bytes = hex::decode(result.strip_prefix("0x").unwrap_or(&result))?;

        if result_bytes.len() < 32 {
            bail!("computeCrossChainProxyAddress returned too short");
        }

        Ok(alloy_primitives::Address::from_slice(&result_bytes[12..32]))
    }
}

/// Proxy identity info returned by authorizedProxies
pub struct ProxyInfo {
    pub original_address: alloy_primitives::Address,
    pub original_rollup_id: alloy_primitives::U256,
}
