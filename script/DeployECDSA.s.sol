// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {Rollups} from "../src/Rollups.sol";
import {tmpECDSAVerifier} from "../src/verifier/tmpECDSAVerifier.sol";

contract DeployECDSA is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        uint256 startingRollupId = vm.envOr("STARTING_ROLLUP_ID", uint256(1));
        address verifierOwner = vm.envAddress("VERIFIER_OWNER");
        address proofSigner = vm.envAddress("PROOF_SIGNER");

        vm.startBroadcast(deployerPrivateKey);

        // Deploy tmpECDSAVerifier with role separation
        tmpECDSAVerifier verifier = new tmpECDSAVerifier(verifierOwner, proofSigner);
        console.log("tmpECDSAVerifier deployed at:", address(verifier));
        console.log("  owner:", verifierOwner);
        console.log("  signer:", proofSigner);

        // Deploy Rollups with the ECDSA verifier
        Rollups rollups = new Rollups(address(verifier), startingRollupId);
        console.log("Rollups deployed at:", address(rollups));

        vm.stopBroadcast();
    }
}
