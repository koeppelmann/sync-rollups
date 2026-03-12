/**
 * Proof Generator for sync-rollups builder
 * Signs proofs using admin wallet (POC) or generates ZK proofs (production)
 */

import {
  Wallet,
  keccak256,
  solidityPacked,
  AbiCoder,
  getBytes,
  Contract,
  JsonRpcProvider,
  verifyMessage,
} from "ethers";
import {
  ExecutionEntry,
  StateDelta,
  Action,
  STATE_DELTA_TUPLE_TYPE,
  ACTION_TUPLE_TYPE,
} from "../reth-fullnode/types.js";

export interface ProofGeneratorConfig {
  adminPrivateKey: string;
  l1RpcUrl: string;
  rollupsAddress: string;
}

// Rollups ABI for reading verification keys
const ROLLUPS_ABI = [
  "function rollups(uint256) view returns (address owner, bytes32 verificationKey, bytes32 stateRoot, uint256 etherBalance)",
];

export class ProofGenerator {
  private config: ProofGeneratorConfig;
  private adminWallet: Wallet;
  private l1Provider: JsonRpcProvider;
  private rollupsContract: Contract;
  private abiCoder: AbiCoder;

  constructor(config: ProofGeneratorConfig) {
    this.config = config;
    this.l1Provider = new JsonRpcProvider(config.l1RpcUrl, undefined, { batchMaxCount: 1 });
    this.adminWallet = new Wallet(config.adminPrivateKey, this.l1Provider);
    this.rollupsContract = new Contract(
      config.rollupsAddress,
      ROLLUPS_ABI,
      this.l1Provider
    );
    this.abiCoder = AbiCoder.defaultAbiCoder();
  }

  /**
   * Get admin address
   */
  getAdminAddress(): string {
    return this.adminWallet.address;
  }

  /**
   * Sign proof for postBatch.
   * Matches the verification logic in Rollups.postBatch.
   *
   * The publicInputsHash includes blockhash(block.number-1) and block.number
   * which we can't predict off-chain. For the AdminZKVerifier (POC), the
   * verifier just checks the signature against the admin address, ignoring
   * the public inputs hash. So we sign a deterministic hash of the entries.
   */
  async signPostBatchProof(entries: ExecutionEntry[]): Promise<string> {
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

    // For AdminZKVerifier/MockZKVerifier, the proof is just an admin signature.
    // We sign a hash of the entry hashes so the verifier can validate the admin signed something.
    const dataHash = keccak256(
      this.abiCoder.encode(["bytes32[]"], [entryHashes])
    );

    const signature = await this.adminWallet.signMessage(
      getBytes(dataHash)
    );

    return signature;
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
      return recoveredAddress.toLowerCase() === this.adminWallet.address.toLowerCase();
    } catch {
      return false;
    }
  }
}
