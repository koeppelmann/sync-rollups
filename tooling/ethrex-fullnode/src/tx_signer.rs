/// Transaction signing for operator system calls on L2.
///
/// The operator signs EIP-1559 transactions with zero gas fees.
/// All transactions use maxFeePerGas=0, maxPriorityFeePerGas=0.
use alloy_primitives::{Address, B256, U256};
// alloy_rlp used only for reference; we do manual RLP encoding below
use eyre::Result;
use k256::ecdsa::{SigningKey, signature::hazmat::PrehashSigner};
use tiny_keccak::{Hasher, Keccak};

pub struct TxSigner {
    signing_key: SigningKey,
    pub address: Address,
    chain_id: u64,
    nonce: u64,
}

impl TxSigner {
    pub fn new(private_key: &B256, address: Address, chain_id: u64, initial_nonce: u64) -> Result<Self> {
        let signing_key = SigningKey::from_bytes(private_key.as_slice().into())
            .map_err(|e| eyre::eyre!("Invalid private key: {e}"))?;
        Ok(Self {
            signing_key,
            address,
            chain_id,
            nonce: initial_nonce,
        })
    }

    pub fn nonce(&self) -> u64 {
        self.nonce
    }

    /// Sign and encode an EIP-1559 transaction. Returns the RLP-encoded raw transaction.
    pub fn sign_tx(
        &mut self,
        to: &Address,
        data: &[u8],
        value: U256,
        gas_limit: u64,
    ) -> Result<String> {
        let nonce = self.nonce;
        self.nonce += 1;

        // Build the EIP-1559 transaction fields for signing
        // Type 2 (EIP-1559) transaction
        let mut rlp_for_signing = Vec::new();

        // EIP-1559 signing data: keccak256(0x02 || rlp([chainId, nonce, maxPriorityFeePerGas,
        //   maxFeePerGas, gasLimit, to, value, data, accessList]))
        let mut inner = Vec::new();

        // chainId
        encode_u64(&mut inner, self.chain_id);
        // nonce
        encode_u64(&mut inner, nonce);
        // maxPriorityFeePerGas = 0
        encode_u64(&mut inner, 0);
        // maxFeePerGas = 0
        encode_u64(&mut inner, 0);
        // gasLimit
        encode_u64(&mut inner, gas_limit);
        // to
        encode_address(&mut inner, to);
        // value
        encode_u256(&mut inner, &value);
        // data
        encode_bytes(&mut inner, data);
        // accessList = []
        inner.push(0xc0); // empty list

        // Wrap in RLP list
        let mut rlp_list = Vec::new();
        encode_list_header(&mut rlp_list, inner.len());
        rlp_list.extend_from_slice(&inner);

        // Prepend tx type byte for signing hash
        rlp_for_signing.push(0x02);
        rlp_for_signing.extend_from_slice(&rlp_list);

        // Hash for signing
        let mut hasher = Keccak::v256();
        hasher.update(&rlp_for_signing);
        let mut signing_hash = [0u8; 32];
        hasher.finalize(&mut signing_hash);

        // Sign
        let (signature, recovery_id) = self.signing_key
            .sign_prehash(&signing_hash)
            .map_err(|e| eyre::eyre!("Signing failed: {e}"))?;

        let sig_bytes = signature.to_bytes();
        let r = &sig_bytes[..32];
        let s = &sig_bytes[32..64];
        let v = recovery_id.to_byte();

        // Build the signed transaction RLP
        // 0x02 || rlp([chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit, to,
        //              value, data, accessList, v, r, s])
        let mut signed_inner = inner.clone();
        // v (yParity)
        encode_u64(&mut signed_inner, v as u64);
        // r
        encode_u256_bytes(&mut signed_inner, r);
        // s
        encode_u256_bytes(&mut signed_inner, s);

        let mut signed_rlp = Vec::new();
        signed_rlp.push(0x02); // EIP-1559 tx type
        encode_list_header(&mut signed_rlp, signed_inner.len());
        signed_rlp.extend_from_slice(&signed_inner);

        Ok(format!("0x{}", hex::encode(&signed_rlp)))
    }
}

// Simple RLP encoding helpers

fn encode_u64(buf: &mut Vec<u8>, val: u64) {
    if val == 0 {
        buf.push(0x80); // RLP empty byte string
    } else if val < 128 {
        buf.push(val as u8);
    } else {
        let bytes = val.to_be_bytes();
        let start = bytes.iter().position(|&b| b != 0).unwrap_or(7);
        let len = 8 - start;
        buf.push(0x80 + len as u8);
        buf.extend_from_slice(&bytes[start..]);
    }
}

fn encode_address(buf: &mut Vec<u8>, addr: &Address) {
    buf.push(0x80 + 20);
    buf.extend_from_slice(addr.as_slice());
}

fn encode_u256(buf: &mut Vec<u8>, val: &U256) {
    let bytes: [u8; 32] = val.to_be_bytes();
    encode_u256_bytes(buf, &bytes);
}

fn encode_u256_bytes(buf: &mut Vec<u8>, bytes: &[u8]) {
    // Strip leading zeros
    let start = bytes.iter().position(|&b| b != 0).unwrap_or(bytes.len());
    let significant = &bytes[start..];

    if significant.is_empty() {
        buf.push(0x80); // empty byte string
    } else if significant.len() == 1 && significant[0] < 128 {
        buf.push(significant[0]);
    } else {
        buf.push(0x80 + significant.len() as u8);
        buf.extend_from_slice(significant);
    }
}

fn encode_bytes(buf: &mut Vec<u8>, data: &[u8]) {
    if data.is_empty() {
        buf.push(0x80);
    } else if data.len() == 1 && data[0] < 128 {
        buf.push(data[0]);
    } else if data.len() < 56 {
        buf.push(0x80 + data.len() as u8);
        buf.extend_from_slice(data);
    } else {
        let len_bytes = data.len().to_be_bytes();
        let len_start = len_bytes.iter().position(|&b| b != 0).unwrap_or(7);
        let len_len = 8 - len_start;
        buf.push(0xb7 + len_len as u8);
        buf.extend_from_slice(&len_bytes[len_start..]);
        buf.extend_from_slice(data);
    }
}

fn encode_list_header(buf: &mut Vec<u8>, content_len: usize) {
    if content_len < 56 {
        buf.push(0xc0 + content_len as u8);
    } else {
        let len_bytes = content_len.to_be_bytes();
        let len_start = len_bytes.iter().position(|&b| b != 0).unwrap_or(7);
        let len_len = 8 - len_start;
        buf.push(0xf7 + len_len as u8);
        buf.extend_from_slice(&len_bytes[len_start..]);
    }
}
