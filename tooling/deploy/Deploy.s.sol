// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";

// Import from sync-rollups
interface IRollups {
    function createRollup(bytes32 initialState, bytes32 verificationKey, address owner) external returns (uint256);
    function rollups(uint256) external view returns (address owner, bytes32 verificationKey, bytes32 stateRoot, uint256 etherBalance);
}

// Inline IZKVerifier interface
interface IZKVerifier {
    function verify(bytes calldata proof, bytes32 publicInputsHash) external view returns (bool valid);
}

// AdminZKVerifier contract
contract AdminZKVerifier is IZKVerifier {
    address public immutable admin;

    constructor(address _admin) {
        require(_admin != address(0), "Admin cannot be zero address");
        admin = _admin;
    }

    function verify(bytes calldata proof, bytes32 publicInputsHash) external view returns (bool valid) {
        if (proof.length != 65) {
            return false;
        }

        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(proof.offset)
            s := calldataload(add(proof.offset, 32))
            v := byte(0, calldataload(add(proof.offset, 64)))
        }

        if (v < 27) {
            v += 27;
        }

        bytes32 ethSignedHash = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", publicInputsHash)
        );

        address signer = ecrecover(ethSignedHash, v, r, s);
        valid = (signer == admin);
    }
}

contract DeployScript is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envOr("PRIVATE_KEY", uint256(0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80));
        address deployer = vm.addr(deployerPrivateKey);

        console.log("Deployer:", deployer);

        vm.startBroadcast(deployerPrivateKey);

        // Deploy AdminZKVerifier
        AdminZKVerifier verifier = new AdminZKVerifier(deployer);
        console.log("AdminZKVerifier:", address(verifier));

        // Deploy Rollups - we need to deploy from sync-rollups
        // For now, we'll just deploy the verifier

        vm.stopBroadcast();

        console.log("\nDeployment complete!");
    }
}
