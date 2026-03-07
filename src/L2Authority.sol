// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Proxy} from "./Proxy.sol";

/// @title L2Authority
/// @notice System contract deployed on the fullnode's L2 at the L1 Rollups contract address.
/// @dev Serves two purposes:
///   1. Responds to `authorizedProxies(address)` calls from L2Proxy's `executeOnBehalf` —
///      always returns true since all system calls are trusted on the fullnode's local L2.
///   2. Deploys L2Proxy contracts via CREATE2 with the same salt and initcode as the
///      L1 Rollups contract, ensuring proxy addresses match across L1 and L2.
/// @dev Storage layout:
///   slot 0: l2ProxyImplementation (address) — L2Proxy implementation contract address
contract L2Authority {
    /// @notice The L2Proxy implementation contract address
    address public l2ProxyImplementation;

    /// @notice Always returns true — on the fullnode's L2, all callers are trusted
    /// @dev Called by L2Proxy.executeOnBehalf to check if msg.sender is authorized.
    ///      Since only the protocol (SYSTEM_ADDRESS) triggers calls, no auth needed.
    function authorizedProxies(address) external pure returns (bool) {
        return true;
    }

    /// @notice Deploy an L2Proxy at the same CREATE2 address as on L1
    /// @dev Uses the same salt computation and constructor args as L1's
    ///      Rollups._createL2ProxyContractInternal(), ensuring address parity.
    /// @param originalAddress The original address this proxy represents
    /// @param originalRollupId The original rollup ID
    /// @param domain The chain ID domain (L1 chain ID for L1-originated proxies)
    /// @return proxy The deployed proxy address
    function deployProxy(
        address originalAddress,
        uint256 originalRollupId,
        uint256 domain
    ) external returns (address proxy) {
        // Same salt as L1: keccak256(abi.encodePacked(block.chainid, originalRollupId, originalAddress))
        // Here 'domain' replaces block.chainid to allow cross-chain address computation
        bytes32 salt = keccak256(abi.encodePacked(domain, originalRollupId, originalAddress));

        // Deploy Proxy with same constructor args as L1
        // (implementation, rollupsAddr=address(this), originalAddress, originalRollupId)
        proxy = address(new Proxy{salt: salt}(
            l2ProxyImplementation,
            address(this),
            originalAddress,
            originalRollupId
        ));
    }

    /// @notice Compute the CREATE2 address for a proxy without deploying
    /// @param originalAddress The original address
    /// @param originalRollupId The original rollup ID
    /// @param domain The chain ID domain
    /// @return The computed proxy address
    function computeProxyAddress(
        address originalAddress,
        uint256 originalRollupId,
        uint256 domain
    ) external view returns (address) {
        bytes32 salt = keccak256(abi.encodePacked(domain, originalRollupId, originalAddress));
        bytes32 bytecodeHash = keccak256(
            abi.encodePacked(
                type(Proxy).creationCode,
                abi.encode(l2ProxyImplementation, address(this), originalAddress, originalRollupId)
            )
        );
        return address(uint160(uint256(keccak256(abi.encodePacked(
            bytes1(0xff),
            address(this),
            salt,
            bytecodeHash
        )))));
    }
}
