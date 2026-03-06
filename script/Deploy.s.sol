// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {Rollups} from "../src/Rollups.sol";
import {IZKVerifier} from "../src/IZKVerifier.sol";

/// @notice Mock ZK verifier that always returns true (for testnet deployments)
contract MockZKVerifier is IZKVerifier {
    bool public shouldVerify = true;
    address public owner;

    constructor() {
        owner = msg.sender;
    }

    function setVerifyResult(bool _shouldVerify) external {
        require(msg.sender == owner, "not owner");
        shouldVerify = _shouldVerify;
    }

    function verify(bytes calldata, bytes32) external view override returns (bool) {
        return shouldVerify;
    }
}

contract Deploy is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        uint256 startingRollupId = vm.envOr("STARTING_ROLLUP_ID", uint256(1));
        address zkVerifier = vm.envOr("ZK_VERIFIER", address(0));

        vm.startBroadcast(deployerPrivateKey);

        // Deploy MockZKVerifier if no verifier address provided
        if (zkVerifier == address(0)) {
            MockZKVerifier mock = new MockZKVerifier();
            zkVerifier = address(mock);
            console.log("MockZKVerifier deployed at:", zkVerifier);
        }

        // Deploy Rollups (also deploys L2Proxy implementation internally)
        Rollups rollups = new Rollups(zkVerifier, startingRollupId);
        console.log("Rollups deployed at:", address(rollups));
        console.log("L2Proxy implementation:", rollups.l2ProxyImplementation());

        vm.stopBroadcast();
    }
}
