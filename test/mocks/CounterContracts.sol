// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract Counter {
    uint256 public counter;

    function increment() external returns (uint256) {
        counter++;
        return counter;
    }
}

contract CounterAndProxy {
    address public target;
    uint256 public targetCounter;
    uint256 public counter;

    constructor(address _target) {
        target = _target;
    }

    function increment() external {
        (bool success, bytes memory result) = target.call(
            abi.encodeWithSelector(Counter.increment.selector)
        );
        require(success, "counter call failed");

        // When calling through a CrossChainProxy, the return goes through two layers:
        // 1. executeCrossChainCall returns bytes memory (nextAction.data)
        // 2. nextAction.data itself contains the raw return from executeOnBehalf,
        //    which is ABI-encoded bytes memory wrapping the actual return value.
        // So we decode: outer bytes (from executeCrossChainCall) -> inner bytes (from executeOnBehalf) -> uint256
        bytes memory outerResult = abi.decode(result, (bytes));
        bytes memory innerResult = abi.decode(outerResult, (bytes));
        targetCounter = abi.decode(innerResult, (uint256));
        counter++;
    }
}
