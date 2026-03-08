/// Types matching the sync-rollups Solidity contracts.
/// Used to decode L1 events and transactions.
use alloy_primitives::{Address, B256, U256};
use serde::{Deserialize, Serialize};

/// Action type enum matching Solidity ActionType
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum ActionType {
    Call = 0,
    Result = 1,
    L2TX = 2,
    Revert = 3,
    RevertContinue = 4,
}

impl From<u8> for ActionType {
    fn from(v: u8) -> Self {
        match v {
            0 => ActionType::Call,
            1 => ActionType::Result,
            2 => ActionType::L2TX,
            3 => ActionType::Revert,
            4 => ActionType::RevertContinue,
            _ => ActionType::Result,
        }
    }
}

/// Decoded Action struct from ExecutionConsumed event
#[derive(Debug, Clone)]
pub struct Action {
    pub action_type: ActionType,
    pub rollup_id: U256,
    pub destination: Address,
    pub value: U256,
    pub data: Vec<u8>,
    pub failed: bool,
    pub source_address: Address,
    pub source_rollup: U256,
    pub scope: Vec<U256>,
}

/// Decoded L1 event: L2ExecutionPerformed
#[derive(Debug, Clone)]
pub struct L2ExecutionPerformed {
    pub rollup_id: U256,
    pub current_state: B256,
    pub new_state: B256,
    pub l1_block_number: u64,
    pub l1_tx_hash: B256,
}

/// Decoded L1 event: ExecutionConsumed
#[derive(Debug, Clone)]
pub struct ExecutionConsumed {
    pub action_hash: B256,
    pub action: Action,
}

/// Decoded L1 event: StateUpdated
#[derive(Debug, Clone)]
pub struct StateUpdated {
    pub rollup_id: U256,
    pub new_state_root: B256,
}

/// Fullnode configuration
#[derive(Debug, Clone)]
pub struct FullnodeConfig {
    pub l1_rpc_url: String,
    pub l2_rpc_url: String,
    pub l2_engine_url: String,
    pub rollups_address: Address,
    pub rollup_id: u64,
    pub l2_chain_id: u64,
    pub initial_state_root: B256,
    pub deployment_block: u64,
    pub jwt_secret: String,
    pub rpc_port: u16,
}

/// Event signatures (keccak256 hashes)
pub mod event_sigs {
    use alloy_primitives::B256;

    /// keccak256("L2ExecutionPerformed(uint256,bytes32,bytes32)")
    pub fn l2_execution_performed() -> B256 {
        keccak256_str("L2ExecutionPerformed(uint256,bytes32,bytes32)")
    }

    /// keccak256("ExecutionConsumed(bytes32,(uint8,uint256,address,uint256,bytes,bool,address,uint256,uint256[]))")
    pub fn execution_consumed() -> B256 {
        keccak256_str("ExecutionConsumed(bytes32,(uint8,uint256,address,uint256,bytes,bool,address,uint256,uint256[]))")
    }

    /// keccak256("StateUpdated(uint256,bytes32)")
    pub fn state_updated() -> B256 {
        keccak256_str("StateUpdated(uint256,bytes32)")
    }

    fn keccak256_str(s: &str) -> B256 {
        use tiny_keccak::{Hasher, Keccak};
        let mut hasher = Keccak::v256();
        hasher.update(s.as_bytes());
        let mut output = [0u8; 32];
        hasher.finalize(&mut output);
        B256::from(output)
    }
}

/// Function selectors
pub mod fn_selectors {
    /// executeL2TX(uint256,bytes) — first 4 bytes of keccak256
    pub fn execute_l2tx() -> [u8; 4] {
        selector("executeL2TX(uint256,bytes)")
    }

    /// createCrossChainProxy(address,uint256)
    pub fn create_cross_chain_proxy() -> [u8; 4] {
        selector("createCrossChainProxy(address,uint256)")
    }

    /// computeCrossChainProxyAddress(address,uint256,uint256)
    pub fn compute_cross_chain_proxy_address() -> [u8; 4] {
        selector("computeCrossChainProxyAddress(address,uint256,uint256)")
    }

    fn selector(sig: &str) -> [u8; 4] {
        use tiny_keccak::{Hasher, Keccak};
        let mut hasher = Keccak::v256();
        hasher.update(sig.as_bytes());
        let mut output = [0u8; 32];
        hasher.finalize(&mut output);
        [output[0], output[1], output[2], output[3]]
    }
}
