// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IZKVerifier
/// @notice Interface for external ZK proof verification
interface IZKVerifier {
    function verify(bytes calldata proof, bytes32 publicInputsHash) external view returns (bool valid);
}

/// @title AdminZKVerifier
/// @notice POC verifier using admin signature instead of ZK proofs
/// @dev For development/testing only - replace with real ZK verifier for production
contract AdminZKVerifier is IZKVerifier {
    /// @notice The admin address that can sign proofs
    address public immutable admin;

    /// @notice Emitted when a proof is verified
    event ProofVerified(bytes32 indexed publicInputsHash, bool valid);

    /// @param _admin The address authorized to sign proofs
    constructor(address _admin) {
        require(_admin != address(0), "Admin cannot be zero address");
        admin = _admin;
    }

    /// @notice Verifies that the proof is a valid admin signature of the publicInputsHash
    /// @param proof The admin's ECDSA signature (65 bytes: r, s, v)
    /// @param publicInputsHash Hash of all public inputs
    /// @return valid True if the signature is from the admin
    function verify(bytes calldata proof, bytes32 publicInputsHash) external view returns (bool valid) {
        // Proof must be 65 bytes (r: 32, s: 32, v: 1)
        if (proof.length != 65) {
            return false;
        }

        // Split signature into components
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(proof.offset)
            s := calldataload(add(proof.offset, 32))
            v := byte(0, calldataload(add(proof.offset, 64)))
        }

        // Normalize v to 27 or 28
        if (v < 27) {
            v += 27;
        }

        // Build the Ethereum signed message hash
        bytes32 ethSignedHash = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", publicInputsHash)
        );

        // Recover the signer
        address signer = ecrecover(ethSignedHash, v, r, s);

        // Verify it matches the admin
        valid = (signer == admin);
    }
}
