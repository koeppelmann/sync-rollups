// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {Rollups, RollupConfig} from "../src/Rollups.sol";
import {CrossChainManagerL2} from "../src/CrossChainManagerL2.sol";
import {CrossChainProxy} from "../src/CrossChainProxy.sol";
import {Action, ActionType, ExecutionEntry, StateDelta, ProxyInfo} from "../src/ICrossChainManager.sol";
import {IZKVerifier} from "../src/IZKVerifier.sol";
import {Counter, CounterAndProxy} from "./mocks/CounterContracts.sol";

contract MockZKVerifier is IZKVerifier {
    function verify(bytes calldata, bytes32) external pure override returns (bool) {
        return true;
    }
}

/// @title IntegrationTest
/// @notice End-to-end test of L1 <-> L2 cross-chain call flow using Counter contracts
///
/// Flow overview:
///   L1: Alice -> CounterAndProxy.increment() -> Counter' (CrossChainProxy) -> Rollups.executeCrossChainCall()
///        -> looks up execution table -> returns RESULT(abi.encode(2)) -> CounterAndProxy sets targetCounter=2, counter=1
///
///   L2: SYSTEM loads execution table -> executeIncomingCrossChainCall() -> CP' (proxy for CounterAndProxy)
///        -> Counter.increment() -> RESULT matched against execution table
contract IntegrationTest is Test {
    // ── L1 contracts ──
    Rollups public rollups;
    MockZKVerifier public verifier;

    // ── L2 contracts ──
    CrossChainManagerL2 public managerL2;
    Counter public counterL2; // The actual Counter deployed on L2

    // ── L1 application contracts ──
    CounterAndProxy public counterAndProxy; // Deployed on L1
    address public counterProxy; // CrossChainProxy for Counter on L1 (Counter' on L1)

    // ── Constants ──
    uint256 constant L2_ROLLUP_ID = 1;
    uint256 constant MAINNET_ROLLUP_ID = 0;
    address constant SYSTEM_ADDRESS = address(0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF);
    bytes32 constant DEFAULT_VK = keccak256("verificationKey");

    address public alice = makeAddr("alice");

    function setUp() public {
        // Deploy L1
        verifier = new MockZKVerifier();
        rollups = new Rollups(address(verifier), 1); // rollupCounter starts at 1

        // Create rollup for L2
        rollups.createRollup(keccak256("l2-initial-state"), DEFAULT_VK, address(this));
        // rollupId = 1 = L2_ROLLUP_ID

        // Deploy L2
        managerL2 = new CrossChainManagerL2(L2_ROLLUP_ID, SYSTEM_ADDRESS);

        // Deploy Counter on L2
        counterL2 = new Counter();

        // On L1: create CrossChainProxy for the L2 Counter (Counter')
        // This proxy represents (counterL2.address, L2_ROLLUP_ID) on L1
        counterProxy = rollups.createCrossChainProxy(address(counterL2), L2_ROLLUP_ID);

        // Deploy CounterAndProxy on L1, pointing at Counter' (the CrossChainProxy)
        counterAndProxy = new CounterAndProxy(counterProxy);
    }

    function _getRollupState(uint256 rollupId) internal view returns (bytes32) {
        (,, bytes32 stateRoot,) = rollups.rollups(rollupId);
        return stateRoot;
    }

    // ═══════════════════════════════════════════════
    //  Test: Full L1 cross-chain call flow
    // ═══════════════════════════════════════════════

    /// @notice Tests the L1 side: Alice calls CounterAndProxy which calls Counter' (CrossChainProxy)
    ///         The execution table is pre-loaded so the RESULT returns abi.encode(2)
    ///         Final state: counterAndProxy.counter = 1, counterAndProxy.targetCounter = 2
    function test_L1_AliceCallsCounterAndProxy() public {
        // ── Pre-increment Counter on L2 once so next increment returns 2 ──
        // (Simulating that counter was already at 1 from a prior call)
        // We just set the expected return value in the execution table.

        bytes memory incrementCallData = abi.encodeWithSelector(Counter.increment.selector);

        // The CALL action that executeCrossChainCall will build when CounterAndProxy calls Counter'
        // sourceAddress = CounterAndProxy (msg.sender as seen by the proxy fallback)
        // sourceRollup = MAINNET_ROLLUP_ID (0)
        // destination = counterL2 address (the original address the proxy represents)
        // rollupId = L2_ROLLUP_ID (the proxy's rollup)
        Action memory callAction = Action({
            actionType: ActionType.CALL,
            rollupId: L2_ROLLUP_ID,
            destination: address(counterL2),
            value: 0,
            data: incrementCallData,
            failed: false,
            sourceAddress: address(counterAndProxy),
            sourceRollup: MAINNET_ROLLUP_ID,
            scope: new uint256[](0)
        });

        // The RESULT that will be returned to CounterAndProxy
        // data = abi.encode(2) means Counter.increment() returned 2
        Action memory resultAction = Action({
            actionType: ActionType.RESULT,
            rollupId: 0,
            destination: address(0),
            value: 0,
            data: abi.encode(uint256(2)),
            failed: false,
            sourceAddress: address(0),
            sourceRollup: 0,
            scope: new uint256[](0)
        });

        // Build the execution entry with state deltas
        bytes32 currentState = keccak256("l2-initial-state");
        bytes32 newState = keccak256("l2-state-after-increment");

        StateDelta[] memory stateDeltas = new StateDelta[](1);
        stateDeltas[0] = StateDelta({
            rollupId: L2_ROLLUP_ID,
            currentState: currentState,
            newState: newState,
            etherDelta: 0
        });

        // Load the execution entry via postBatch (deferred entry)
        ExecutionEntry[] memory entries = new ExecutionEntry[](1);
        entries[0].stateDeltas = stateDeltas;
        entries[0].actionHash = keccak256(abi.encode(callAction));
        entries[0].nextAction = resultAction;

        rollups.postBatch(entries, 0, "", "proof");

        // ── Alice calls CounterAndProxy.increment() ──
        vm.prank(alice);
        counterAndProxy.increment();

        // ── Assert final state ──
        assertEq(counterAndProxy.counter(), 1, "CP.counter should be 1");
        assertEq(counterAndProxy.targetCounter(), 2, "CP.targetCounter should be 2");
        assertEq(_getRollupState(L2_ROLLUP_ID), newState, "L2 rollup state should be updated");
    }

    // ═══════════════════════════════════════════════
    //  Test: Full L2 execution flow
    // ═══════════════════════════════════════════════

    /// @notice Tests the L2 side: system loads execution table, then executeIncomingCrossChainCall
    ///         processes the CALL through a proxy for CounterAndProxy (CP'), which calls Counter.increment()
    ///         The RESULT is matched against the execution table entry.
    function test_L2_ExecuteIncomingCrossChainCall() public {
        bytes memory incrementCallData = abi.encodeWithSelector(Counter.increment.selector);

        // After executing Counter.increment() (counter goes 0->1, returns 1),
        // _processCallAtScope builds a RESULT action.
        // The proxy (CP') calls executeOnBehalf -> Counter.increment()
        // executeOnBehalf uses raw return, so returnData = abi.encode(1)
        Action memory resultFromExecution = Action({
            actionType: ActionType.RESULT,
            rollupId: L2_ROLLUP_ID,
            destination: address(0),
            value: 0,
            data: abi.encode(uint256(1)),
            failed: false,
            sourceAddress: address(0),
            sourceRollup: 0,
            scope: new uint256[](0)
        });

        // Load execution table on L2:
        // Entry 1: CALL action -> nextAction is a RESULT (meaning: after matching the CALL, return this RESULT which tells the system to execute the call at this scope)
        // But wait — on L2, executeCrossChainCall -> _consumeExecution (not _findAndApplyExecution).
        // For executeIncomingCrossChainCall, it goes through newScope -> _processCallAtScope.
        // _processCallAtScope executes the call, builds a RESULT, hashes it, then _consumeExecution(resultHash).
        // So we need to load the RESULT action hash -> final result.

        StateDelta[] memory emptyDeltas = new StateDelta[](0);
        ExecutionEntry[] memory entries = new ExecutionEntry[](1);
        entries[0].stateDeltas = emptyDeltas;
        entries[0].actionHash = keccak256(abi.encode(resultFromExecution));
        entries[0].nextAction = resultFromExecution;

        vm.prank(SYSTEM_ADDRESS);
        managerL2.loadExecutionTable(entries);

        // ── SYSTEM calls executeIncomingCrossChainCall ──
        // This will: enter newScope -> _processCallAtScope -> auto-create CP' proxy
        //   -> CP'.executeOnBehalf(counterL2, increment()) -> Counter.increment() returns 1
        //   -> build RESULT -> _consumeExecution(resultHash) -> return finalResult
        vm.prank(SYSTEM_ADDRESS);
        managerL2.executeIncomingCrossChainCall(
            address(counterL2), // destination
            0, // value
            incrementCallData, // data
            address(counterAndProxy), // sourceAddress
            MAINNET_ROLLUP_ID, // sourceRollup
            new uint256[](0) // scope
        );

        // ── Assert ──
        assertEq(counterL2.counter(), 1, "Counter on L2 should be 1");
        assertEq(managerL2.pendingEntryCount(), 0, "All execution entries consumed");
    }
}
