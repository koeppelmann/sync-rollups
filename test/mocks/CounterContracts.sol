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

        // When calling through a CrossChainProxy, the return is ABI-encoded bytes memory
        // (from executeCrossChainCall's return type), so we decode the outer bytes first.
        bytes memory innerResult = abi.decode(result, (bytes));
        targetCounter = abi.decode(innerResult, (uint256));
        counter++;
    }
}
