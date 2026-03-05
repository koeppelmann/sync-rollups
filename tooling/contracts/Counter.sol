// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract Counter {
    uint256 public count;
    address public lastCaller;

    event Incremented(address indexed caller, uint256 previousValue, uint256 newValue);

    function increment() external returns (uint256 previousValue) {
        previousValue = count;
        count = previousValue + 1;
        lastCaller = msg.sender;
        emit Incremented(msg.sender, previousValue, count);
    }

    function getCount() external view returns (uint256) {
        return count;
    }
}
