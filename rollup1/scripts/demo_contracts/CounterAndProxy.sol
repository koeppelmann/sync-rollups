// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title CounterReturn - Counter that returns the new value
/// @dev Used for integration test scenarios requiring return values
contract CounterReturn {
    uint256 public counter;
    address public lastCaller;

    function increment() external returns (uint256) {
        counter++;
        lastCaller = msg.sender;
        return counter;
    }
}

/// @title CounterAndProxy - Counter that calls another contract via proxy
/// @dev Used in integration tests for cross-chain call scenarios.
///      The target is a CrossChainProxy whose fallback triggers
///      executeCrossChainCall on the manager contract.
contract CounterAndProxy {
    address public target;
    uint256 public targetCounter;
    uint256 public counter;

    constructor(address _target) {
        target = _target;
    }

    function increment() external {
        // Call target.increment() — if target is a CrossChainProxy,
        // this triggers cross-chain execution via the manager
        (bool success, bytes memory data) = target.call(
            abi.encodeWithSignature("increment()")
        );
        require(success, "CounterAndProxy: target call failed");

        // Decode the return value (uint256)
        if (data.length >= 32) {
            targetCounter = abi.decode(data, (uint256));
        }
        counter++;
    }
}
