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
  Execution,
  StateDelta,
  Action,
  STATE_DELTA_TUPLE_TYPE,
  ACTION_TUPLE_TYPE,
} from "../fullnode/types.js";

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
    this.l1Provider = new JsonRpcProvider(config.l1RpcUrl);
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
   * Sign proof for loadL2Executions
   * Matches the verification logic in Rollups.loadL2Executions
   */
  async signLoadExecutionsProof(executions: Execution[]): Promise<string> {
    // Build execution hashes as per Rollups.loadL2Executions
    const executionHashes: string[] = [];

    for (const exec of executions) {
      // Get verification keys for each state delta
      const verificationKeys: string[] = [];
      for (const delta of exec.stateDeltas) {
        const rollupData = await this.rollupsContract.rollups(delta.rollupId);
        verificationKeys.push(rollupData.verificationKey);
      }

      // Compute execution hash
      const executionHash = this.computeExecutionHash(
        exec,
        verificationKeys
      );
      executionHashes.push(executionHash);
    }

    // Build public inputs hash
    // First byte indicates proof type: 0x01 = loadL2Executions
    const publicInputsHash = keccak256(
      solidityPacked(
        ["bytes1", "bytes"],
        [
          "0x01",
          this.abiCoder.encode(["bytes32[]"], [executionHashes]),
        ]
      )
    );

    // Sign with admin wallet
    const signature = await this.adminWallet.signMessage(
      getBytes(publicInputsHash)
    );

    return signature;
  }

  /**
   * Compute execution hash as per Rollups.loadL2Executions
   */
  private computeExecutionHash(
    execution: Execution,
    verificationKeys: string[]
  ): string {
    // Encode state deltas
    const stateDeltas = execution.stateDeltas.map((d) => [
      d.rollupId,
      d.currentState,
      d.newState,
      d.etherDelta,
    ]);

    // Encode next action
    const nextAction = [
      execution.nextAction.actionType,
      execution.nextAction.rollupId,
      execution.nextAction.destination,
      execution.nextAction.value,
      execution.nextAction.data,
      execution.nextAction.failed,
      execution.nextAction.sourceAddress,
      execution.nextAction.sourceRollup,
      execution.nextAction.scope,
    ];

    // Build hash matching Solidity
    const encoded = solidityPacked(
      ["bytes", "bytes", "bytes32", "bytes"],
      [
        this.abiCoder.encode([`${STATE_DELTA_TUPLE_TYPE}[]`], [stateDeltas]),
        this.abiCoder.encode(["bytes32[]"], [verificationKeys]),
        execution.actionHash,
        this.abiCoder.encode([ACTION_TUPLE_TYPE], [nextAction]),
      ]
    );

    return keccak256(encoded);
  }

  /**
   * Sign proof for postBatch (not used in single-tx mode but included for completeness)
   */
  async signPostBatchProof(
    commitments: Array<{
      rollupId: bigint;
      newState: string;
      etherIncrement: bigint;
    }>,
    blobCount: number,
    callData: string,
    prevBlockHash: string
  ): Promise<string> {
    // Collect current states and verification keys
    const currentStates: string[] = [];
    const verificationKeys: string[] = [];

    for (const commitment of commitments) {
      const rollupData = await this.rollupsContract.rollups(commitment.rollupId);
      currentStates.push(rollupData.stateRoot);
      verificationKeys.push(rollupData.verificationKey);
    }

    // Note: We can't access blobhash() off-chain, so this would need
    // to be computed differently for actual blob transactions
    const blobHashes: string[] = new Array(blobCount).fill(
      "0x0000000000000000000000000000000000000000000000000000000000000000"
    );

    // Build public inputs hash
    // First byte indicates proof type: 0x00 = postBatch
    const publicInputsHash = keccak256(
      solidityPacked(
        ["bytes1", "bytes32", "bytes", "bytes", "bytes", "bytes", "bytes32"],
        [
          "0x00",
          prevBlockHash,
          this.abiCoder.encode(
            ["tuple(uint256,bytes32,int256)[]"],
            [commitments.map((c) => [c.rollupId, c.newState, c.etherIncrement])]
          ),
          this.abiCoder.encode(["bytes32[]"], [currentStates]),
          this.abiCoder.encode(["bytes32[]"], [verificationKeys]),
          this.abiCoder.encode(["bytes32[]"], [blobHashes]),
          keccak256(callData),
        ]
      )
    );

    // Sign with admin wallet
    const signature = await this.adminWallet.signMessage(
      getBytes(publicInputsHash)
    );

    return signature;
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
