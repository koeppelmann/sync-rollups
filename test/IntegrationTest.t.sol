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
///   L2: SYSTEM loads execution table -> executeIncomingCrossChainCall() -> CP' (proxy for CounterAndProxy)
///        -> Counter.increment() -> RESULT matched against execution table
///
///   L1: Alice -> CounterAndProxy.increment() -> Counter' (CrossChainProxy) -> Rollups.executeCrossChainCall()
///        -> looks up execution table -> returns RESULT(abi.encode(1)) -> CounterAndProxy sets targetCounter=1, counter=1
contract IntegrationTest is Test {
    // ── L1 contracts ──
    Rollups public rollups;
    MockZKVerifier public verifier;
    Counter public counterL1; // C: Counter on L1 (for scenarios 2 & 4)

    // ── L2 contracts ──
    CrossChainManagerL2 public managerL2;
    Counter public counterL2; // B: Counter on L2
    CounterAndProxy public counterAndProxyL2; // D: CounterAndProxy on L2

    // ── L1 application contracts ──
    CounterAndProxy public counterAndProxy; // A: CounterAndProxy on L1
    address public counterProxy; // B': CrossChainProxy for Counter on L1 (Counter' on L1)

    // ── L2 proxies ──
    address public counterProxyL2; // C': proxy for counterL1 on L2
    address public counterAndProxyProxyL2; // A': proxy for counterAndProxy (A) on L2

    // ── L1 proxies for L2 contracts ──
    address public counterAndProxyL2ProxyL1; // D': proxy for counterAndProxyL2 (D) on L1

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

        // Deploy Counter on L2 (B)
        counterL2 = new Counter();

        // Deploy Counter on L1 (C)
        counterL1 = new Counter();

        // On L1: create CrossChainProxy for the L2 Counter (B')
        counterProxy = rollups.createCrossChainProxy(address(counterL2), L2_ROLLUP_ID);

        // Deploy CounterAndProxy on L1 (A), pointing at B' (the CrossChainProxy)
        counterAndProxy = new CounterAndProxy(counterProxy);

        // C': proxy for counterL1 (C) on L2, so L2 contracts can call L1's Counter
        counterProxyL2 = managerL2.createCrossChainProxy(address(counterL1), MAINNET_ROLLUP_ID);

        // D: CounterAndProxy on L2, targeting C'
        counterAndProxyL2 = new CounterAndProxy(counterProxyL2);

        // A': proxy for counterAndProxy (A) on L2 (for Scenario 3)
        counterAndProxyProxyL2 = managerL2.createCrossChainProxy(address(counterAndProxy), MAINNET_ROLLUP_ID);

        // D': proxy for counterAndProxyL2 (D) on L1 (for Scenario 4)
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
        // The low-level .call() to executeOnBehalf returns ABI-encoded bytes memory,
        // which wraps the inner Counter.increment() return value.
        // Inner return: abi.encode(uint256(1))
        // executeOnBehalf returns bytes memory, so the .call() returnData is:
        //   abi.encode(abi.encode(uint256(1)))
        Action memory resultFromExecution = Action({
            actionType: ActionType.RESULT,
            rollupId: L2_ROLLUP_ID,
            destination: address(0),
            value: 0,
            data: abi.encode(abi.encode(uint256(1))),
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
    //  Test 2: Alice -> D (-> C') -> C (L2 calls L1, simple reverse)
    // ═══════════════════════════════════════════════

    /// @notice L2-originated call: D calls C' (proxy for L1 Counter), resolved on L1 via executeL2TX,
    ///         then on L2 via execution table consumption.
    function test_Scenario2_L2CallsL1_Simple() public {
        bytes memory incrementCallData = abi.encodeWithSelector(Counter.increment.selector);
        bytes memory rlpEncodedTx = hex"deadbeef"; // Dummy L2 tx data

        // ════════════════════════════════════════════
        //  Phase 1: L1 — Execute Counter via executeL2TX
        // ════════════════════════════════════════════

        // The L2TX action that executeL2TX will build
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

        // The CALL action that will be returned as nextAction from the L2TX lookup
        // This calls Counter on L1 (C), with source = counterAndProxyL2 (D) from L2
        Action memory callToC = Action({
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

        // After _processCallAtScope executes the CALL:
        // D' (proxy for counterAndProxyL2 on L1) calls executeOnBehalf(counterL1, increment)
        // Counter.increment() returns 1
        // returnData = abi.encode(abi.encode(uint256(1)))
        Action memory resultFromL1Execution = Action({
            actionType: ActionType.RESULT,
            rollupId: MAINNET_ROLLUP_ID,
            destination: address(0),
            value: 0,
            data: abi.encode(abi.encode(uint256(1))),
            failed: false,
            sourceAddress: address(0),
            sourceRollup: 0,
            scope: new uint256[](0)
        });

        // Terminal RESULT (returned after consuming the result hash)
        Action memory terminalResult = resultFromL1Execution;

        bytes32 currentState = keccak256("l2-initial-state");
        bytes32 newState = keccak256("l2-state-after-d-calls-c");

        StateDelta[] memory stateDeltas = new StateDelta[](1);
        stateDeltas[0] = StateDelta({
            rollupId: L2_ROLLUP_ID,
            currentState: currentState,
            newState: newState,
            etherDelta: 0
        });

        StateDelta[] memory emptyDeltas = new StateDelta[](0);

        // postBatch with 2 deferred entries:
        // Entry 1: hash(L2TX) -> CALL to C (with L2 state delta)
        // Entry 2: hash(RESULT) -> terminal RESULT (empty deltas)
        ExecutionEntry[] memory entries = new ExecutionEntry[](2);
        entries[0].stateDeltas = stateDeltas;
        entries[0].actionHash = keccak256(abi.encode(l2txAction));
        entries[0].nextAction = callToC;

        entries[1].stateDeltas = emptyDeltas;
        entries[1].actionHash = keccak256(abi.encode(resultFromL1Execution));
        entries[1].nextAction = terminalResult;

        rollups.postBatch(entries, 0, "", "proof");

        // Trigger via executeL2TX
        rollups.executeL2TX(L2_ROLLUP_ID, rlpEncodedTx);

        assertEq(counterL1.counter(), 1, "Counter on L1 should be 1 after executeL2TX");
        assertEq(_getRollupState(L2_ROLLUP_ID), newState, "L2 rollup state should be updated");

        // ════════════════════════════════════════════
        //  Phase 2: L2 — Alice calls D, resolves from execution table
        // ════════════════════════════════════════════

        // The CALL action that executeCrossChainCall will build when D calls C'
        Action memory l2CallAction = Action({
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

        // Load L2 execution table: hash(CALL) -> RESULT
        ExecutionEntry[] memory l2Entries = new ExecutionEntry[](1);
        l2Entries[0].stateDeltas = emptyDeltas;
        l2Entries[0].actionHash = keccak256(abi.encode(l2CallAction));
        l2Entries[0].nextAction = resultFromL1Execution;

        vm.prank(SYSTEM_ADDRESS);
        managerL2.loadExecutionTable(l2Entries);

        // Alice calls D.increment() -> D calls C' -> executeCrossChainCall -> consumes execution -> RESULT(1)
        vm.prank(alice);
        counterAndProxyL2.increment();

        // ── Final assertions ──
        assertEq(counterL1.counter(), 1, "Counter on L1 should be 1");
        assertEq(counterAndProxyL2.counter(), 1, "D.counter should be 1");
        assertEq(counterAndProxyL2.targetCounter(), 1, "D.targetCounter should be 1");
        assertEq(managerL2.pendingEntryCount(), 0, "All L2 execution entries consumed");
    }

    // ═══════════════════════════════════════════════
    //  Test 3: Alice -> A' (-> A -> B') -> B (nested, L2 side)
    // ═══════════════════════════════════════════════

    /// @notice Nested cross-chain call on L2. Alice calls A' (proxy for A on L2),
    ///         which triggers scope navigation: A' -> A -> B' -> B.
    ///         The scope tree has CALL#1 at scope [] and CALL#2 at scope [0].
    function test_Scenario3_NestedL2Call() public {
        bytes memory incrementCallData = abi.encodeWithSelector(Counter.increment.selector);

        // CALL#1: Alice -> A' (proxy for counterAndProxy on MAINNET)
        // executeCrossChainCall builds this when A' is called
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

        // CALL#2: A calls B' -> Counter on L2 at scope [0]
        // When _processCallAtScope executes CALL#1, A' calls executeOnBehalf(counterAndProxy, increment).
        // But wait — A (counterAndProxy) is on L1, and A' is its proxy on L2.
        // executeOnBehalf calls counterAndProxy.increment() locally.
        // counterAndProxy.increment() calls counterProxy (B') which calls executeCrossChainCall.
        // executeCrossChainCall builds a CALL for (counterL2, L2_ROLLUP_ID) with source=counterAndProxy.
        // But on L2, the executeCrossChainCall is on managerL2, and the proxy B' is on L2... wait.
        //
        // Actually: On L2, A' is a proxy for A (counterAndProxy on MAINNET).
        // When Alice calls A' on L2, the fallback calls managerL2.executeCrossChainCall(alice, increment()).
        // Manager builds CALL#1: {CALL, MAINNET_ROLLUP_ID, counterAndProxy, increment, source=alice, sourceRollup=L2}
        // _consumeExecution(hash(CALL#1)) returns CALL#2.
        // CALL#2 is at scope [0], so newScope navigates there.
        // At scope [0], _processCallAtScope is called:
        //   - sourceProxy = computeProxy(counterAndProxy, MAINNET_ROLLUP_ID, chainid)
        //   - This is A' itself (already created in setUp)
        //   - A'.executeOnBehalf(counterL2, increment) -> Counter.increment() returns 1
        //   - Builds RESULT -> _consumeExecution(resultHash) -> terminal RESULT

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

        // RESULT from executing Counter.increment() on L2 via A'.executeOnBehalf
        Action memory resultFromExecution = Action({
            actionType: ActionType.RESULT,
            rollupId: L2_ROLLUP_ID,
            destination: address(0),
            value: 0,
            data: abi.encode(abi.encode(uint256(1))),
            failed: false,
            sourceAddress: address(0),
            sourceRollup: 0,
            scope: new uint256[](0)
        });

        StateDelta[] memory emptyDeltas = new StateDelta[](0);

        // Load L2 execution table with 2 entries:
        // Entry 1: hash(CALL#1) -> CALL#2
        // Entry 2: hash(RESULT) -> terminal RESULT
        ExecutionEntry[] memory entries = new ExecutionEntry[](2);
        entries[0].stateDeltas = emptyDeltas;
        entries[0].actionHash = keccak256(abi.encode(call1));
        entries[0].nextAction = call2;

        entries[1].stateDeltas = emptyDeltas;
        entries[1].actionHash = keccak256(abi.encode(resultFromExecution));
        entries[1].nextAction = resultFromExecution;

        vm.prank(SYSTEM_ADDRESS);
        managerL2.loadExecutionTable(entries);

        // Alice calls A' on L2 (proxy for counterAndProxy on MAINNET)
        vm.prank(alice);
        (bool success,) = address(counterAndProxyProxyL2).call(incrementCallData);
        assertTrue(success, "Call to A' should succeed");

        // ── Final assertions ──
        assertEq(counterL2.counter(), 1, "Counter on L2 should be 1 (executed via scope navigation)");
        assertEq(managerL2.pendingEntryCount(), 0, "All L2 execution entries consumed");
    }

    // ═══════════════════════════════════════════════
    //  Test 4: Alice -> D' (-> D -> C') -> C (nested, L1 side)
    // ═══════════════════════════════════════════════

    /// @notice Nested cross-chain call on L1. Alice calls D' (proxy for D on L1),
    ///         which triggers scope navigation: D' -> D -> C' -> C.
    ///         The scope tree has CALL#1 at scope [] and CALL#2 at scope [0].
    function test_Scenario4_NestedL1Call() public {
        bytes memory incrementCallData = abi.encodeWithSelector(Counter.increment.selector);

        // CALL#1: Alice calls D' (proxy for counterAndProxyL2 on L2)
        // executeCrossChainCall builds this when D' is called
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

        // CALL#2: D calls C' -> Counter on L1 at scope [0]
        // After consuming CALL#1, nextAction is CALL#2 which navigates to scope [0].
        // At scope [0], _processCallAtScope:
        //   - sourceProxy = computeProxy(counterAndProxyL2, L2_ROLLUP_ID, chainid)
        //   - This is D' itself (already created in setUp)
        //   - D'.executeOnBehalf(counterL1, increment) -> Counter.increment() returns 1
        //   - Builds RESULT -> _findAndApplyExecution(resultHash) -> terminal RESULT

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

        // RESULT from executing Counter.increment() on L1 via D'.executeOnBehalf
        Action memory resultFromExecution = Action({
            actionType: ActionType.RESULT,
            rollupId: MAINNET_ROLLUP_ID,
            destination: address(0),
            value: 0,
            data: abi.encode(abi.encode(uint256(1))),
            failed: false,
            sourceAddress: address(0),
            sourceRollup: 0,
            scope: new uint256[](0)
        });

        bytes32 currentState = keccak256("l2-initial-state");
        bytes32 newState = keccak256("l2-state-after-nested-l1-call");

        StateDelta[] memory stateDeltas = new StateDelta[](1);
        stateDeltas[0] = StateDelta({
            rollupId: L2_ROLLUP_ID,
            currentState: currentState,
            newState: newState,
            etherDelta: 0
        });

        StateDelta[] memory emptyDeltas = new StateDelta[](0);

        // postBatch with 2 deferred entries:
        // Entry 1: hash(CALL#1) -> CALL#2 (with L2 state delta)
        // Entry 2: hash(RESULT) -> terminal RESULT (empty deltas)
        ExecutionEntry[] memory entries = new ExecutionEntry[](2);
        entries[0].stateDeltas = stateDeltas;
        entries[0].actionHash = keccak256(abi.encode(call1));
        entries[0].nextAction = call2;

        entries[1].stateDeltas = emptyDeltas;
        entries[1].actionHash = keccak256(abi.encode(resultFromExecution));
        entries[1].nextAction = resultFromExecution;

        rollups.postBatch(entries, 0, "", "proof");

        // Alice calls D' on L1 (proxy for counterAndProxyL2 on L2)
        vm.prank(alice);
        (bool success,) = address(counterAndProxyL2ProxyL1).call(incrementCallData);
        assertTrue(success, "Call to D' should succeed");

        // ── Final assertions ──
        assertEq(counterL1.counter(), 1, "Counter on L1 should be 1 (executed via scope navigation)");
        assertEq(_getRollupState(L2_ROLLUP_ID), newState, "L2 rollup state should be updated");
    }
}
