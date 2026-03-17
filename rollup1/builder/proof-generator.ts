/**
 * Proof Generator for sync-rollups builder
 * Signs proofs using a dedicated proof signer key.
 *
 * Supports two modes:
 * - MockZKVerifier (legacy): signs a hash of entry hashes using EIP-191 (signMessage)
 * - tmpECDSAVerifier: signs the real publicInputsHash as raw ECDSA (no prefix)
 *   The publicInputsHash includes blockhash(block.number-1) and block.number,
 *   so the caller must provide targetBlockNumber and parentBlockHash.
 */

import {
  Wallet,
  SigningKey,
  keccak256,
  solidityPacked,
  AbiCoder,
  getBytes,
  Contract,
  JsonRpcProvider,
  verifyMessage,
  concat,
  zeroPadValue,
  toBeHex,
} from "ethers";
import {
  ExecutionEntry,
  StateDelta,
  Action,
  STATE_DELTA_TUPLE_TYPE,
  ACTION_TUPLE_TYPE,
} from "../reth-fullnode/types.js";

export interface ProofGeneratorConfig {
  signerPrivateKey: string;
  l1RpcUrl: string;
  rollupsAddress: string;
}

/**
 * Optional parameters for ECDSA signing mode (tmpECDSAVerifier).
 * When provided, the proof signs the real publicInputsHash matching the contract.
 */
export interface ECDSASigningParams {
  targetBlockNumber: number;
  parentBlockHash: string;
}

// Rollups ABI for reading verification keys
const ROLLUPS_ABI = [
  "function rollups(uint256) view returns (address owner, bytes32 verificationKey, bytes32 stateRoot, uint256 etherBalance)",
];

export class ProofGenerator {
  private config: ProofGeneratorConfig;
  private signerWallet: Wallet;
  private signingKey: SigningKey;
  private l1Provider: JsonRpcProvider;
  private rollupsContract: Contract;
  private abiCoder: AbiCoder;

  constructor(config: ProofGeneratorConfig) {
    this.config = config;
    this.l1Provider = new JsonRpcProvider(config.l1RpcUrl, undefined, { batchMaxCount: 1 });
    this.signerWallet = new Wallet(config.signerPrivateKey, this.l1Provider);
    this.signingKey = new SigningKey(config.signerPrivateKey);
    this.rollupsContract = new Contract(
      config.rollupsAddress,
      ROLLUPS_ABI,
      this.l1Provider
    );
    this.abiCoder = AbiCoder.defaultAbiCoder();
  }

  /**
   * Get proof signer address
   */
  getSignerAddress(): string {
    return this.signerWallet.address;
  }

  /**
   * Sign proof for postBatch.
   *
   * If ecdsaParams is provided, computes the real publicInputsHash (matching
   * Rollups.sol) and signs it as raw ECDSA (for tmpECDSAVerifier).
   *
   * If ecdsaParams is omitted, falls back to MockZKVerifier mode: signs a
   * hash of entry hashes using EIP-191 signMessage.
   */
  async signPostBatchProof(
    entries: ExecutionEntry[],
    ecdsaParams?: ECDSASigningParams
  ): Promise<string> {
    // Build entry hashes as per Rollups.postBatch
    const entryHashes: string[] = [];

    for (const entry of entries) {
      const verificationKeys: string[] = [];
      for (const delta of entry.stateDeltas) {
        const rollupData = await this.rollupsContract.rollups(delta.rollupId);
        verificationKeys.push(rollupData.verificationKey);
      }

      const entryHash = this.computeEntryHash(entry, verificationKeys);
      entryHashes.push(entryHash);
    }

    if (ecdsaParams) {
      // tmpECDSAVerifier mode: compute the real publicInputsHash and sign raw
      const publicInputsHash = this.computePublicInputsHash(
        entryHashes,
        ecdsaParams.parentBlockHash,
        ecdsaParams.targetBlockNumber,
        [],   // no blob hashes
        "0x"  // empty callData
      );

      console.log(`[ProofGenerator] ECDSA mode: target block ${ecdsaParams.targetBlockNumber}, parentHash ${ecdsaParams.parentBlockHash.slice(0, 18)}...`);
      console.log(`[ProofGenerator] publicInputsHash: ${publicInputsHash}`);

      // Raw ECDSA sign — no EIP-191 prefix
      const sig = this.signingKey.sign(publicInputsHash);
      // Pack as r(32) + s(32) + v(1) — 65 bytes total
      const proof = concat([sig.r, sig.s, toBeHex(sig.v, 1)]);
      return proof;
    }

    // MockZKVerifier fallback: sign a hash of entry hashes with EIP-191
    const dataHash = keccak256(
      this.abiCoder.encode(["bytes32[]"], [entryHashes])
    );

    const signature = await this.signerWallet.signMessage(
      getBytes(dataHash)
    );

    return signature;
  }

  /**
   * Compute publicInputsHash exactly as Rollups.sol does:
   * keccak256(abi.encodePacked(
   *   blockhash(block.number - 1),
   *   block.number,
   *   abi.encode(entryHashes),
   *   abi.encode(blobHashes),
   *   keccak256(callData)
   * ))
   */
  computePublicInputsHash(
    entryHashes: string[],
    parentBlockHash: string,
    blockNumber: number,
    blobHashes: string[],
    callData: string
  ): string {
    const encodedEntryHashes = this.abiCoder.encode(["bytes32[]"], [entryHashes]);
    const encodedBlobHashes = this.abiCoder.encode(["bytes32[]"], [blobHashes]);
    const callDataHash = keccak256(callData === "0x" ? "0x" : callData);

    return keccak256(
      solidityPacked(
        ["bytes32", "uint256", "bytes", "bytes", "bytes32"],
        [parentBlockHash, blockNumber, encodedEntryHashes, encodedBlobHashes, callDataHash]
      )
    );
  }

  /**
   * Compute entry hash as per Rollups.postBatch
   */
  private computeEntryHash(
    entry: ExecutionEntry,
    verificationKeys: string[]
  ): string {
    const stateDeltas = entry.stateDeltas.map((d) => [
      d.rollupId,
      d.currentState,
      d.newState,
      d.etherDelta,
    ]);

    const nextAction = [
      entry.nextAction.actionType,
      entry.nextAction.rollupId,
      entry.nextAction.destination,
      entry.nextAction.value,
      entry.nextAction.data,
      entry.nextAction.failed,
      entry.nextAction.sourceAddress,
      entry.nextAction.sourceRollup,
      entry.nextAction.scope,
    ];

    const encoded = solidityPacked(
      ["bytes", "bytes", "bytes32", "bytes"],
      [
        this.abiCoder.encode([`${STATE_DELTA_TUPLE_TYPE}[]`], [stateDeltas]),
        this.abiCoder.encode(["bytes32[]"], [verificationKeys]),
        entry.actionHash,
        this.abiCoder.encode([ACTION_TUPLE_TYPE], [nextAction]),
      ]
    );

    return keccak256(encoded);
  }

  /**
   * Verify a signature against expected public inputs hash
   */
  verifySignature(signature: string, publicInputsHash: string): boolean {
    try {
      const recoveredAddress = verifyMessage(
        getBytes(publicInputsHash),
        signature
      );
      return recoveredAddress.toLowerCase() === this.signerWallet.address.toLowerCase();
    } catch {
      return false;
    }
  }
}
