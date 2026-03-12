// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./SimpleToken.sol";

/**
 * @title TokenBridge
 * @notice Cross-chain token bridge for sync-rollups.
 *
 * The same contract is deployed on both L1 and L2. Each side has a
 * `counterpartProxy` — the cross-chain proxy representing the bridge
 * on the other chain. Only the counterpart proxy can call `mint` and
 * `release`, enforcing that these are triggered by legitimate
 * cross-chain executions.
 *
 * L1→L2 flow:
 *   1. User calls bridge.depositAndBridge(token, to, amount) on L1
 *   2. Bridge locks tokens (transferFrom user → bridge)
 *   3. Bridge calls counterpartProxy.mint(wrappedToken, to, amount)
 *      → this triggers a cross-chain execution on L2
 *   4. On L2, the bridge's mint() is called by the proxy representing
 *      the L1 bridge, minting wrapped tokens to `to`
 *
 * L2→L1 flow:
 *   1. User calls bridge.burnAndBridge(wrappedToken, to, amount) on L2
 *   2. Bridge burns wrapped tokens
 *   3. Bridge calls counterpartProxy.release(originalToken, to, amount)
 *      → this triggers a cross-chain execution on L1
 *   4. On L1, the bridge's release() is called by the proxy representing
 *      the L2 bridge, transferring locked tokens to `to`
 */
contract TokenBridge {
    /// @notice Authorized caller for cross-chain operations.
    /// On L1: the proxy representing the L2 bridge.
    /// On L2: the system/operator address (since L1→L2 calls execute as system txs).
    address public counterpartProxy;
    address public admin;

    // Token mappings (local token → remote token)
    mapping(address => address) public remoteToken;

    // Total locked per token (L1 side tracking)
    mapping(address => uint256) public lockedBalance;

    event CounterpartSet(address indexed proxy);
    event TokenPairRegistered(address indexed localToken, address indexed remoteToken);
    event Deposited(address indexed token, address indexed from, address indexed to, uint256 amount);
    event Released(address indexed token, address indexed to, uint256 amount);
    event Minted(address indexed token, address indexed to, uint256 amount);
    event Burned(address indexed token, address indexed from, uint256 amount);

    constructor() {
        admin = msg.sender;
    }

    modifier onlyAdmin() {
        require(msg.sender == admin, "Bridge: not admin");
        _;
    }

    modifier onlyCounterpart() {
        require(msg.sender == counterpartProxy, "Bridge: not counterpart proxy");
        _;
    }

    /// @notice Set the cross-chain proxy representing the counterpart bridge
    function setCounterpartProxy(address _proxy) external onlyAdmin {
        counterpartProxy = _proxy;
        emit CounterpartSet(_proxy);
    }

    /// @notice Register a local↔remote token pair
    function registerTokenPair(address localToken, address _remoteToken) external onlyAdmin {
        remoteToken[localToken] = _remoteToken;
        emit TokenPairRegistered(localToken, _remoteToken);
    }

    // ─── L1 side: lock tokens and trigger L2 mint ───

    /// @notice Deposit tokens on L1 and mint wrapped tokens on L2
    /// @param token The L1 token to deposit
    /// @param to The L2 recipient
    /// @param amount Amount to bridge
    function depositAndBridge(address token, address to, uint256 amount) external {
        require(counterpartProxy != address(0), "Bridge: counterpart not set");
        address wrapped = remoteToken[token];
        require(wrapped != address(0), "Bridge: token not registered");

        // Lock tokens on L1
        SimpleToken(token).transferFrom(msg.sender, address(this), amount);
        lockedBalance[token] += amount;
        emit Deposited(token, msg.sender, to, amount);

        // Call counterpart bridge on L2 to mint wrapped tokens.
        // This call goes to the cross-chain proxy, which triggers an
        // L2 execution entry via the Rollups contract.
        TokenBridge(counterpartProxy).mint(wrapped, to, amount);
    }

    /// @notice Release locked tokens on L1 (called by counterpart proxy for L2→L1 withdrawals)
    function release(address token, address to, uint256 amount) external onlyCounterpart {
        require(lockedBalance[token] >= amount, "Bridge: insufficient locked balance");
        lockedBalance[token] -= amount;
        SimpleToken(token).transfer(to, amount);
        emit Released(token, to, amount);
    }

    // ─── L2 side: mint/burn wrapped tokens ───

    /// @notice Mint wrapped tokens on L2 (called by counterpart proxy for L1→L2 deposits)
    function mint(address token, address to, uint256 amount) external onlyCounterpart {
        SimpleToken(token).mint(to, amount);
        emit Minted(token, to, amount);
    }

    /// @notice Burn wrapped tokens on L2 and release original tokens on L1
    /// @param wrappedToken The L2 wrapped token to burn
    /// @param l1Recipient The L1 recipient for the released tokens
    /// @param amount Amount to bridge back
    function burnAndBridge(address wrappedToken, address l1Recipient, uint256 amount) external {
        require(counterpartProxy != address(0), "Bridge: counterpart not set");
        address original = remoteToken[wrappedToken];
        require(original != address(0), "Bridge: token not registered");

        // Burn wrapped tokens on L2
        SimpleToken(wrappedToken).burn(msg.sender, amount);
        emit Burned(wrappedToken, msg.sender, amount);

        // Call counterpart bridge on L1 to release original tokens.
        // This call goes to the cross-chain proxy, which triggers an
        // L1 execution entry via the Rollups contract.
        TokenBridge(counterpartProxy).release(original, l1Recipient, amount);
    }

    // ─── Legacy compatibility (for existing demo scripts) ───

    /// @notice Legacy: deposit tokens without cross-chain call
    function deposit(address token, address to, uint256 amount) external {
        SimpleToken(token).transferFrom(msg.sender, address(this), amount);
        lockedBalance[token] += amount;
        emit Deposited(token, msg.sender, to, amount);
    }

    /// @notice Legacy: mint wrapped tokens (permissionless for backward compat)
    /// @dev Only works if bridge owns the token supply (pre-minted model)
    function mintTo(address token, address to, uint256 amount) external {
        SimpleToken(token).transfer(to, amount);
        emit Minted(token, to, amount);
    }

    /// @notice Legacy: release tokens (permissionless for backward compat)
    function releaseTo(address token, address to, uint256 amount) external {
        require(lockedBalance[token] >= amount, "Bridge: insufficient locked balance");
        lockedBalance[token] -= amount;
        SimpleToken(token).transfer(to, amount);
        emit Released(token, to, amount);
    }
}
