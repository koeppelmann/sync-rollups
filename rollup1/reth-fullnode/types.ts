/**
 * TypeScript types matching the sync-rollups Solidity structs
 * See: sync-rollups/src/Rollups.sol
 */

// Action type enum matching Solidity
export enum ActionType {
  CALL = 0,
  RESULT = 1,
  L2TX = 2,
  REVERT = 3,
  REVERT_CONTINUE = 4,
}

/**
 * Represents an action in the state transition
 * For CALL: rollupId, destination, value, data (callData), sourceAddress, sourceRollup, and scope are used
 * For RESULT: failed and data (returnData) are used
 * For L2TX: rollupId and data (rlpEncodedTx) are used
 */
export interface Action {
  actionType: ActionType;
  rollupId: bigint;
  destination: string; // address
  value: bigint;
  data: string; // bytes (hex)
  failed: boolean;
  sourceAddress: string; // address
  sourceRollup: bigint;
  scope: bigint[];
}

/**
 * Represents a state delta for a single rollup (before/after snapshot)
 */
export interface StateDelta {
  rollupId: bigint;
  currentState: string; // bytes32
  newState: string; // bytes32
  etherDelta: bigint; // int256
}

/**
 * Represents a pre-computed execution that can affect multiple rollups
 */
export interface ExecutionEntry {
  stateDeltas: StateDelta[];
  actionHash: string; // bytes32
  nextAction: Action;
}

/**
 * Rollup configuration
 */
export interface RollupConfig {
  owner: string; // address
  verificationKey: string; // bytes32
  stateRoot: string; // bytes32
  etherBalance: bigint;
}

/**
 * Local rollup state tracked by the fullnode
 */
export interface RollupState {
  rollupId: bigint;
  stateRoot: string; // bytes32
  etherBalance: bigint;
  blockNumber: bigint; // L1 block when last updated
}

/**
 * Execution plan returned by the builder
 */
export interface ExecutionPlan {
  entries: ExecutionEntry[];
  rootActionHash: string; // Entry point action hash
  rootActions: Action[]; // Root actions for each entry (used by proofer for verification)
  proof: string; // Admin signature or ZK proof
}

/**
 * Result of simulating an action
 */
export interface SimulationResult {
  nextAction: Action;
  stateDeltas: StateDelta[];
  success: boolean;
  error?: string;
}

// ABI encoding helpers
export const ACTION_TUPLE_TYPE =
  "tuple(uint8 actionType, uint256 rollupId, address destination, uint256 value, bytes data, bool failed, address sourceAddress, uint256 sourceRollup, uint256[] scope)";

export const STATE_DELTA_TUPLE_TYPE =
  "tuple(uint256 rollupId, bytes32 currentState, bytes32 newState, int256 etherDelta)";

export const EXECUTION_ENTRY_TUPLE_TYPE = `tuple(${STATE_DELTA_TUPLE_TYPE}[] stateDeltas, bytes32 actionHash, ${ACTION_TUPLE_TYPE} nextAction)`;

// Event signatures for the Rollups contract
export const ROLLUPS_EVENTS = {
  RollupCreated:
    "RollupCreated(uint256 indexed rollupId, address indexed owner, bytes32 verificationKey, bytes32 initialState)",
  StateUpdated: "StateUpdated(uint256 indexed rollupId, bytes32 newStateRoot)",
  VerificationKeyUpdated:
    "VerificationKeyUpdated(uint256 indexed rollupId, bytes32 newVerificationKey)",
  OwnershipTransferred:
    "OwnershipTransferred(uint256 indexed rollupId, address indexed previousOwner, address indexed newOwner)",
  CrossChainProxyCreated:
    "CrossChainProxyCreated(address indexed proxy, address indexed originalAddress, uint256 indexed originalRollupId)",
  L2ExecutionPerformed:
    "L2ExecutionPerformed(uint256 indexed rollupId, bytes32 currentState, bytes32 newState)",
};

// Helper to create an empty action
export function emptyAction(): Action {
  return {
    actionType: ActionType.RESULT,
    rollupId: 0n,
    destination: "0x0000000000000000000000000000000000000000",
    value: 0n,
    data: "0x",
    failed: false,
    sourceAddress: "0x0000000000000000000000000000000000000000",
    sourceRollup: 0n,
    scope: [],
  };
}

// Helper to create an L2TX action
export function createL2TXAction(
  rollupId: bigint,
  rlpEncodedTx: string
): Action {
  return {
    actionType: ActionType.L2TX,
    rollupId,
    destination: "0x0000000000000000000000000000000000000000",
    value: 0n,
    data: rlpEncodedTx,
    failed: false,
    sourceAddress: "0x0000000000000000000000000000000000000000",
    sourceRollup: 0n,
    scope: [],
  };
}

// Helper to create a CALL action
export function createCallAction(
  rollupId: bigint,
  destination: string,
  value: bigint,
  data: string,
  sourceAddress: string,
  sourceRollup: bigint,
  scope: bigint[]
): Action {
  return {
    actionType: ActionType.CALL,
    rollupId,
    destination,
    value,
    data,
    failed: false,
    sourceAddress,
    sourceRollup,
    scope,
  };
}

// Helper to create a RESULT action
export function createResultAction(
  rollupId: bigint,
  data: string,
  failed: boolean
): Action {
  return {
    actionType: ActionType.RESULT,
    rollupId,
    destination: "0x0000000000000000000000000000000000000000",
    value: 0n,
    data,
    failed,
    sourceAddress: "0x0000000000000000000000000000000000000000",
    sourceRollup: 0n,
    scope: [],
  };
}

// JSON serializable versions (BigInt -> hex string)
export interface ActionJson {
  actionType: ActionType;
  rollupId: string;
  destination: string;
  value: string;
  data: string;
  failed: boolean;
  sourceAddress: string;
  sourceRollup: string;
  scope: string[];
}

export interface StateDeltaJson {
  rollupId: string;
  currentState: string;
  newState: string;
  etherDelta: string;
}

export interface ExecutionEntryJson {
  stateDeltas: StateDeltaJson[];
  actionHash: string;
  nextAction: ActionJson;
}

// Serialize Action to JSON-safe format
export function actionToJson(action: Action): ActionJson {
  return {
    actionType: action.actionType,
    rollupId: "0x" + action.rollupId.toString(16),
    destination: action.destination,
    value: "0x" + action.value.toString(16),
    data: action.data,
    failed: action.failed,
    sourceAddress: action.sourceAddress,
    sourceRollup: "0x" + action.sourceRollup.toString(16),
    scope: action.scope.map(s => "0x" + s.toString(16)),
  };
}

// Deserialize Action from JSON
export function actionFromJson(json: ActionJson): Action {
  return {
    actionType: json.actionType,
    rollupId: BigInt(json.rollupId),
    destination: json.destination,
    value: BigInt(json.value),
    data: json.data,
    failed: json.failed,
    sourceAddress: json.sourceAddress,
    sourceRollup: BigInt(json.sourceRollup),
    scope: json.scope.map(s => BigInt(s)),
  };
}

// Serialize StateDelta to JSON-safe format
export function stateDeltaToJson(delta: StateDelta): StateDeltaJson {
  return {
    rollupId: "0x" + delta.rollupId.toString(16),
    currentState: delta.currentState,
    newState: delta.newState,
    etherDelta: delta.etherDelta >= 0n
      ? "0x" + delta.etherDelta.toString(16)
      : "-0x" + (-delta.etherDelta).toString(16),
  };
}

// Deserialize StateDelta from JSON
export function stateDeltaFromJson(json: StateDeltaJson): StateDelta {
  let etherDelta: bigint;
  if (json.etherDelta.startsWith("-")) {
    etherDelta = -BigInt(json.etherDelta.slice(1));
  } else {
    etherDelta = BigInt(json.etherDelta);
  }
  return {
    rollupId: BigInt(json.rollupId),
    currentState: json.currentState,
    newState: json.newState,
    etherDelta,
  };
}

// Serialize Execution to JSON-safe format
export function executionEntryToJson(exec: ExecutionEntry): ExecutionEntryJson {
  return {
    stateDeltas: exec.stateDeltas.map(stateDeltaToJson),
    actionHash: exec.actionHash,
    nextAction: actionToJson(exec.nextAction),
  };
}

// Deserialize Execution from JSON
export function executionEntryFromJson(json: ExecutionEntryJson): ExecutionEntry {
  return {
    stateDeltas: json.stateDeltas.map(stateDeltaFromJson),
    actionHash: json.actionHash,
    nextAction: actionFromJson(json.nextAction),
  };
}
