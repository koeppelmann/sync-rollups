// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./SimpleToken.sol";

/**
 * @title TokenBridge
 * @notice Simple token bridge between L1 and L2.
 *
 * On L1: Users deposit tokens → bridge locks them and emits a Deposit event.
 *         The cross-chain system calls `releaseTo` to unlock tokens for withdrawals.
 *
 * On L2: A mirrored bridge mints/burns wrapped tokens.
 *         `mintTo` is called by the cross-chain system when tokens are bridged in.
 *         Users call `burnAndBridge` to bridge tokens back to L1.
 *
 * This is a simplified bridge for demo purposes — in production you'd use
 * lock/mint on L1 and mint/burn on L2 with proper cross-chain message verification.
 */
contract TokenBridge {
    // L1 token address → L2 wrapped token address (or vice versa)
    mapping(address => address) public wrappedTokens;
    mapping(address => address) public originalTokens;

    // Total locked per token (L1 side)
    mapping(address => uint256) public lockedBalance;

    event TokenRegistered(address indexed originalToken, address indexed wrappedToken);
    event Deposited(address indexed token, address indexed from, address indexed to, uint256 amount);
    event Released(address indexed token, address indexed to, uint256 amount);
    event Minted(address indexed wrappedToken, address indexed to, uint256 amount);
    event Burned(address indexed wrappedToken, address indexed from, uint256 amount);

    /**
     * @notice Register a wrapped token for an original token
     */
    function registerToken(address originalToken, address wrappedToken) external {
        wrappedTokens[originalToken] = wrappedToken;
        originalTokens[wrappedToken] = originalToken;
        emit TokenRegistered(originalToken, wrappedToken);
    }

    /**
     * @notice L1: Deposit tokens to bridge to L2
     * @param token The L1 token to deposit
     * @param to The L2 recipient address
     * @param amount Amount to bridge
     */
    function deposit(address token, address to, uint256 amount) external {
        SimpleToken(token).transferFrom(msg.sender, address(this), amount);
        lockedBalance[token] += amount;
        emit Deposited(token, msg.sender, to, amount);
    }

    /**
     * @notice L1: Release locked tokens (called by cross-chain system for L2→L1 withdrawals)
     */
    function releaseTo(address token, address to, uint256 amount) external {
        require(lockedBalance[token] >= amount, "Bridge: insufficient locked balance");
        lockedBalance[token] -= amount;
        SimpleToken(token).transfer(to, amount);
        emit Released(token, to, amount);
    }

    /**
     * @notice L2: Mint wrapped tokens (called by cross-chain system for L1→L2 deposits)
     */
    function mintTo(address wrappedToken, address to, uint256 amount) external {
        // On L2, the bridge holds a supply of wrapped tokens and transfers them out
        // In a real system this would be a mint, but for simplicity we use pre-minted supply
        SimpleToken(wrappedToken).transfer(to, amount);
        emit Minted(wrappedToken, to, amount);
    }

    /**
     * @notice L2: Burn wrapped tokens to bridge back to L1
     */
    function burnAndBridge(address wrappedToken, address l1Recipient, uint256 amount) external {
        SimpleToken(wrappedToken).transferFrom(msg.sender, address(this), amount);
        emit Burned(wrappedToken, msg.sender, amount);
        // The cross-chain system picks up this event and calls releaseTo on L1
    }
}
