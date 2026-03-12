// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

contract Counter {
    uint256 public count;
    address public lastCaller;

    function increment() public {
        count++;
        lastCaller = msg.sender;
    }

    function getCount() public view returns (uint256) {
        return count;
    }
}
