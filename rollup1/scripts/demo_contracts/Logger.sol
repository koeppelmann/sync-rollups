// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

contract Logger {
    event CallResult(address indexed target, bool success, bytes returnData);

    function callAndLog(address target, bytes calldata data) external payable returns (bool success, bytes memory returnData) {
        (success, returnData) = target.call{value: msg.value}(data);
        emit CallResult(target, success, returnData);
    }
}
