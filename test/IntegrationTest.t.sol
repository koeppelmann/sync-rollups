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
/// @notice End-to-end tests of L1 <-> L2 cross-chain call flows using Counter contracts
///
/// Legend:
///   A = CounterAndProxy on L1     B = Counter on L2
///   C = Counter on L1             D = CounterAndProxy on L2
///   X' = CrossChainProxy for X
///
/// Scenarios:
///   1. Alice -> A (-> B') -> B         L1 -> L2 simple           (existing)
///   2. Alice -> D (-> C') -> C         L2 -> L1 simple           (reverse)
///   3. Alice -> A' (-> A -> B') -> B   L2 entry, nested scope    (nested)
///   4. Alice -> D' (-> D -> C') -> C   L1 entry, nested scope    (nested)
contract IntegrationTest is Test {
    // ── L1 contracts ──
    Rollups public rollups;
    MockZKVerifier public verifier;

    // ── L2 contracts ──
    CrossChainManagerL2 public managerL2;
    Counter public counterL2; // B - Counter on L2

    // ── L1 application contracts ──
    CounterAndProxy public counterAndProxy; // A - CounterAndProxy on L1
    address public counterProxy; // B' - CrossChainProxy for B on L1

    // ── Additional contracts for cross-chain scenarios ──
    Counter public counterL1; // C - Counter on L1
    CounterAndProxy public counterAndProxyL2; // D - CounterAndProxy on L2
    address public counterProxyL2; // C' - proxy for C on L2
    address public counterAndProxyProxyL2; // A' - proxy for A on L2
    address public counterAndProxyL2ProxyL1; // D' - proxy for D on L1

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

        // ── Additional contracts ──

        // C: Counter on L1
        counterL1 = new Counter();

        // C': proxy for C on L2 (so L2 contracts can call L1's Counter)
        counterProxyL2 = managerL2.createCrossChainProxy(address(counterL1), MAINNET_ROLLUP_ID);

        // D: CounterAndProxy on L2, targeting C'
        counterAndProxyL2 = new CounterAndProxy(counterProxyL2);

        // A': proxy for A (CounterAndProxy on L1) on L2 — for Scenario 3
        counterAndProxyProxyL2 = managerL2.createCrossChainProxy(address(counterAndProxy), MAINNET_ROLLUP_ID);

        // D': proxy for D (CounterAndProxy on L2) on L1 — for Scenarios 2 & 4
        counterAndProxyL2ProxyL1 = rollups.createCrossChainProxy(address(counterAndProxyL2), L2_ROLLUP_ID);
    }

    function _getRollupState(uint256 rollupId) internal view returns (bytes32) {
        (,, bytes32 stateRoot,) = rollups.rollups(rollupId);
        return stateRoot;
    }

    // ═══════════════════════════════════════════════
    //  Test: Full L1 <-> L2 cross-chain call flow
    // ═══════════════════════════════════════════════

    /// @notice Full flow: L2 executes Counter.increment() (0->1), then L1 resolves with RESULT(1).
    ///         Final L2 state: Counter.counter = 1
    ///         Final L1 state: CounterAndProxy.counter = 1, CounterAndProxy.targetCounter = 1
    function test_FullFlow_L2Execution_ThenL1Resolution() public {
        bytes memory incrementCallData = abi.encodeWithSelector(Counter.increment.selector);

        // ════════════════════════════════════════════
        //  Phase 1: L2 — SYSTEM executes Counter.increment() via CP' proxy
        // ════════════════════════════════════════════

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
        // _processCallAtScope executes the call, builds a RESULT, hashes it, then _consumeExecution(resultHash).
        // So we load the RESULT action hash -> nextAction is the same RESULT (terminal).
        {
            StateDelta[] memory emptyDeltas = new StateDelta[](0);
            ExecutionEntry[] memory entries = new ExecutionEntry[](1);
            entries[0].stateDeltas = emptyDeltas;
            entries[0].actionHash = keccak256(abi.encode(resultFromExecution));
            entries[0].nextAction = resultFromExecution;

            vm.prank(SYSTEM_ADDRESS);
            managerL2.loadExecutionTable(entries);
        }

        // SYSTEM calls executeIncomingCrossChainCall:
        //   newScope -> _processCallAtScope -> auto-create CP' proxy
        //   -> CP'.executeOnBehalf(counterL2, increment()) -> Counter.increment() returns 1
        //   -> build RESULT -> _consumeExecution(resultHash) -> return RESULT
        vm.prank(SYSTEM_ADDRESS);
        managerL2.executeIncomingCrossChainCall(
            address(counterL2), 0, incrementCallData,
            address(counterAndProxy), MAINNET_ROLLUP_ID, new uint256[](0)
        );

        assertEq(counterL2.counter(), 1, "Counter on L2 should be 1");
        assertEq(managerL2.pendingEntryCount(), 0, "All L2 execution entries consumed");

        // ════════════════════════════════════════════
        //  Phase 2: L1 — Resolution (CounterAndProxy gets RESULT(1))
        // ════════════════════════════════════════════

        // The CALL action that executeCrossChainCall will build when CounterAndProxy calls Counter'
        Action memory l1CallAction = Action({
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

        bytes32 currentState = keccak256("l2-initial-state");
        bytes32 newState = keccak256("l2-state-after-increment");

        StateDelta[] memory stateDeltas = new StateDelta[](1);
        stateDeltas[0] = StateDelta({
            rollupId: L2_ROLLUP_ID,
            currentState: currentState,
            newState: newState,
            etherDelta: 0
        });

        // Load deferred execution entry via postBatch.
        // nextAction reuses the same RESULT from L2 (same action hash = same outcome).
        ExecutionEntry[] memory l1Entries = new ExecutionEntry[](1);
        l1Entries[0].stateDeltas = stateDeltas;
        l1Entries[0].actionHash = keccak256(abi.encode(l1CallAction));
        l1Entries[0].nextAction = resultFromExecution;

        rollups.postBatch(l1Entries, 0, "", "proof");

        // Alice calls CounterAndProxy.increment() on L1
        vm.prank(alice);
        counterAndProxy.increment();

        // ── Final assertions ──
        assertEq(counterAndProxy.counter(), 1, "CP.counter should be 1");
        assertEq(counterAndProxy.targetCounter(), 1, "CP.targetCounter should be 1");
        assertEq(_getRollupState(L2_ROLLUP_ID), newState, "L2 rollup state should be updated");
        assertEq(counterL2.counter(), 1, "L2 Counter should be 1");
    }

    // ═══════════════════════════════════════════════
    //  Test 2: Alice -> D (-> C') -> C  (L2 calls L1, simple)
    // ═══════════════════════════════════════════════

    /// @notice Scenario 2: D(CounterAndProxy on L2) calls C'(proxy for Counter on L1).
    ///         Phase 1: L1 executes Counter via executeL2TX + scope navigation.
    ///         Phase 2: L2 resolves via execution table when Alice calls D.
    function test_Scenario2_L2CallsL1() public {
        bytes memory incrementCallData = abi.encodeWithSelector(Counter.increment.selector);

        // ════════════════════════════════════════════
        //  Phase 1: L1 — Execute Counter(C) via executeL2TX
        // ════════════════════════════════════════════

        bytes memory rlpEncodedTx = hex"01"; // arbitrary L2TX data

        // L2TX action that executeL2TX will build
        Action memory l2txAction = Action({
            actionType: ActionType.L2TX,
            rollupId: L2_ROLLUP_ID,
            destination: address(0),
            value: 0,
            data: rlpEncodedTx,
            failed: false,
            sourceAddress: address(0),
            sourceRollup: MAINNET_ROLLUP_ID,
            scope: new uint256[](0)
        });

        // CALL action representing D calling C via C' (what scope navigation will process)
        Action memory callAction = Action({
            actionType: ActionType.CALL,
            rollupId: MAINNET_ROLLUP_ID,
            destination: address(counterL1),
            value: 0,
            data: incrementCallData,
            failed: false,
            sourceAddress: address(counterAndProxyL2),
            sourceRollup: L2_ROLLUP_ID,
            scope: new uint256[](0)
        });

        // RESULT from Counter.increment() returning 1
        Action memory resultAction = Action({
            actionType: ActionType.RESULT,
            rollupId: MAINNET_ROLLUP_ID,
            destination: address(0),
            value: 0,
            data: abi.encode(uint256(1)),
            failed: false,
            sourceAddress: address(0),
            sourceRollup: 0,
            scope: new uint256[](0)
        });

        bytes32 currentState = keccak256("l2-initial-state");
        bytes32 newState = keccak256("l2-state-after-scenario2");

        // postBatch: 2 deferred entries
        // Entry 1: L2TX -> CALL (with L2 state delta)
        // Entry 2: RESULT -> RESULT (terminal, no state delta)
        {
            StateDelta[] memory deltas1 = new StateDelta[](1);
            deltas1[0] = StateDelta({
                rollupId: L2_ROLLUP_ID,
                currentState: currentState,
                newState: newState,
                etherDelta: 0
            });

            ExecutionEntry[] memory entries = new ExecutionEntry[](2);
            entries[0].stateDeltas = deltas1;
            entries[0].actionHash = keccak256(abi.encode(l2txAction));
            entries[0].nextAction = callAction;

            entries[1].stateDeltas = new StateDelta[](0);
            entries[1].actionHash = keccak256(abi.encode(resultAction));
            entries[1].nextAction = resultAction;

            rollups.postBatch(entries, 0, "", "proof");
        }

        // executeL2TX triggers: L2TX -> CALL -> _processCallAtScope
        //   -> D'.executeOnBehalf(counterL1, increment) -> Counter(C).increment() returns 1
        //   -> RESULT matched -> terminal RESULT
        rollups.executeL2TX(L2_ROLLUP_ID, rlpEncodedTx);

        assertEq(counterL1.counter(), 1, "Counter(C) on L1 should be 1 after executeL2TX");
        assertEq(_getRollupState(L2_ROLLUP_ID), newState, "L2 state should be updated");

        // ════════════════════════════════════════════
        //  Phase 2: L2 — Alice calls D, resolves from execution table
        // ════════════════════════════════════════════

        {
            ExecutionEntry[] memory l2Entries = new ExecutionEntry[](1);
            l2Entries[0].stateDeltas = new StateDelta[](0);
            l2Entries[0].actionHash = keccak256(abi.encode(callAction));
            l2Entries[0].nextAction = resultAction;

            vm.prank(SYSTEM_ADDRESS);
            managerL2.loadExecutionTable(l2Entries);
        }

        // Alice calls D.increment() -> D calls C' -> executeCrossChainCall -> RESULT(1)
        vm.prank(alice);
        counterAndProxyL2.increment();

        // ── Final assertions ──
        assertEq(counterAndProxyL2.counter(), 1, "D.counter should be 1");
        assertEq(counterAndProxyL2.targetCounter(), 1, "D.targetCounter should be 1");
        assertEq(counterL1.counter(), 1, "Counter(C) on L1 should still be 1");
        assertEq(managerL2.pendingEntryCount(), 0, "All L2 entries consumed");
    }

    // ═══════════════════════════════════════════════
    //  Test 3: Alice -> A' (-> A -> B') -> B  (nested, L2 scope navigation)
    // ═══════════════════════════════════════════════

    /// @notice Scenario 3: Alice calls A'(proxy for CounterAndProxy on L2).
    ///         Scope navigation on L2: CALL#1 to A resolves to CALL#2 to B(Counter on L2).
    ///         _processCallAtScope executes Counter.increment() on L2 via A' proxy.
    function test_Scenario3_NestedL2Entry() public {
        bytes memory incrementCallData = abi.encodeWithSelector(Counter.increment.selector);

        // CALL#1: built by executeCrossChainCall when A' is called
        // A' proxy info: originalAddress=counterAndProxy(A), originalRollupId=MAINNET
        Action memory call1 = Action({
            actionType: ActionType.CALL,
            rollupId: MAINNET_ROLLUP_ID,
            destination: address(counterAndProxy),
            value: 0,
            data: incrementCallData,
            failed: false,
            sourceAddress: alice,
            sourceRollup: L2_ROLLUP_ID,
            scope: new uint256[](0)
        });

        // CALL#2: inner call from A calling B' -> targets B(Counter on L2) at scope=[0]
        uint256[] memory scope0 = new uint256[](1);
        scope0[0] = 0;

        Action memory call2 = Action({
            actionType: ActionType.CALL,
            rollupId: L2_ROLLUP_ID,
            destination: address(counterL2),
            value: 0,
            data: incrementCallData,
            failed: false,
            sourceAddress: address(counterAndProxy),
            sourceRollup: MAINNET_ROLLUP_ID,
            scope: scope0
        });

        // RESULT from Counter(B).increment() returning 1
        Action memory resultAction = Action({
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

        // Load L2 execution table: 2 entries for scope navigation
        // Entry 1: CALL#1 -> CALL#2 (nested call)
        // Entry 2: RESULT -> RESULT (terminal)
        {
            StateDelta[] memory emptyDeltas = new StateDelta[](0);
            ExecutionEntry[] memory entries = new ExecutionEntry[](2);

            entries[0].stateDeltas = emptyDeltas;
            entries[0].actionHash = keccak256(abi.encode(call1));
            entries[0].nextAction = call2;

            entries[1].stateDeltas = emptyDeltas;
            entries[1].actionHash = keccak256(abi.encode(resultAction));
            entries[1].nextAction = resultAction;

            vm.prank(SYSTEM_ADDRESS);
            managerL2.loadExecutionTable(entries);
        }

        // Alice calls A' on L2 with increment selector
        // A'.fallback -> executeCrossChainCall -> CALL#1 consumed -> CALL#2
        // _resolveScopes -> newScope([0]) -> _processCallAtScope
        // A'.executeOnBehalf(counterL2, increment) -> Counter(B).increment() -> 1
        // RESULT consumed -> terminal RESULT
        vm.prank(alice);
        (bool success,) = counterAndProxyProxyL2.call(incrementCallData);
        assertTrue(success, "A' call should succeed");

        // ── Final assertions ──
        assertEq(counterL2.counter(), 1, "Counter(B) on L2 should be 1 (executed via scope navigation)");
        assertEq(managerL2.pendingEntryCount(), 0, "All L2 entries consumed");
    }

    // ═══════════════════════════════════════════════
    //  Test 4: Alice -> D' (-> D -> C') -> C  (nested, L1 scope navigation)
    // ═══════════════════════════════════════════════

    /// @notice Scenario 4: Alice calls D'(proxy for CounterAndProxy on L1).
    ///         Scope navigation on L1: CALL#1 to D resolves to CALL#2 to C(Counter on L1).
    ///         _processCallAtScope executes Counter.increment() on L1 via D' proxy.
    function test_Scenario4_NestedL1Entry() public {
        bytes memory incrementCallData = abi.encodeWithSelector(Counter.increment.selector);

        // CALL#1: built by executeCrossChainCall when D' is called
        // D' proxy info: originalAddress=counterAndProxyL2(D), originalRollupId=L2_ROLLUP_ID
        Action memory call1 = Action({
            actionType: ActionType.CALL,
            rollupId: L2_ROLLUP_ID,
            destination: address(counterAndProxyL2),
            value: 0,
            data: incrementCallData,
            failed: false,
            sourceAddress: alice,
            sourceRollup: MAINNET_ROLLUP_ID,
            scope: new uint256[](0)
        });

        // CALL#2: inner call from D calling C' -> targets C(Counter on L1) at scope=[0]
        uint256[] memory scope0 = new uint256[](1);
        scope0[0] = 0;

        Action memory call2 = Action({
            actionType: ActionType.CALL,
            rollupId: MAINNET_ROLLUP_ID,
            destination: address(counterL1),
            value: 0,
            data: incrementCallData,
            failed: false,
            sourceAddress: address(counterAndProxyL2),
            sourceRollup: L2_ROLLUP_ID,
            scope: scope0
        });

        // RESULT from Counter(C).increment() returning 1
        Action memory resultAction = Action({
            actionType: ActionType.RESULT,
            rollupId: MAINNET_ROLLUP_ID,
            destination: address(0),
            value: 0,
            data: abi.encode(uint256(1)),
            failed: false,
            sourceAddress: address(0),
            sourceRollup: 0,
            scope: new uint256[](0)
        });

        bytes32 currentState = keccak256("l2-initial-state");
        bytes32 newState = keccak256("l2-state-after-scenario4");

        // postBatch: 2 deferred entries
        // Entry 1: CALL#1 -> CALL#2 (with L2 state delta)
        // Entry 2: RESULT -> RESULT (terminal, no state delta)
        {
            StateDelta[] memory deltas1 = new StateDelta[](1);
            deltas1[0] = StateDelta({
                rollupId: L2_ROLLUP_ID,
                currentState: currentState,
                newState: newState,
                etherDelta: 0
            });

            ExecutionEntry[] memory entries = new ExecutionEntry[](2);
            entries[0].stateDeltas = deltas1;
            entries[0].actionHash = keccak256(abi.encode(call1));
            entries[0].nextAction = call2;

            entries[1].stateDeltas = new StateDelta[](0);
            entries[1].actionHash = keccak256(abi.encode(resultAction));
            entries[1].nextAction = resultAction;

            rollups.postBatch(entries, 0, "", "proof");
        }

        // Alice calls D' on L1 with increment selector
        // D'.fallback -> executeCrossChainCall -> CALL#1 matched -> state delta applied -> CALL#2
        // _resolveScopes -> newScope([0]) -> _processCallAtScope
        // D'.executeOnBehalf(counterL1, increment) -> Counter(C).increment() -> 1
        // RESULT matched -> terminal RESULT
        vm.prank(alice);
        (bool success,) = counterAndProxyL2ProxyL1.call(incrementCallData);
        assertTrue(success, "D' call should succeed");

        // ── Final assertions ──
        assertEq(counterL1.counter(), 1, "Counter(C) on L1 should be 1 (executed via scope navigation)");
        assertEq(_getRollupState(L2_ROLLUP_ID), newState, "L2 state should be updated");
    }
}
