// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
}

interface IUniswapV2Router {
    function swapExactTokensForTokens(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external returns (uint[] memory amounts);

    function getAmountsOut(uint amountIn, address[] calldata path)
        external view returns (uint[] memory amounts);
}

interface IFlashLender {
    function flashLoan(address token, uint256 amount, bytes calldata data) external;
}

interface ITokenBridge {
    function deposit(address token, address to, uint256 amount) external;
    function releaseTo(address token, address to, uint256 amount) external;
}

/**
 * @title AtomicArbL1
 * @notice L1 orchestrator for atomic cross-chain flash arbitrage.
 *
 * Full flash arb flow (single L1 transaction):
 *   1. Flash-borrow WETH from FlashLender
 *   2. Swap WETH -> COW on L1 Uniswap (COW is cheap on L1)
 *   3. Lock COW in L1 TokenBridge
 *   4. Call CrossChainProxy(TradeHelper) -> L2 state transition:
 *      - L2 bridge mints wCOW to TradeHelper
 *      - TradeHelper swaps wCOW -> wETH on L2 Uniswap
 *      - TradeHelper sends wETH to L2 bridge
 *   5. Call L1 TokenBridge.releaseTo() to get WETH back
 *   6. Repay flash loan, keep profit
 */
contract AtomicArbL1 {
    address public owner;

    event ArbExecuted(
        uint256 l1AmountIn,
        uint256 l1AmountOut,
        address l2Proxy,
        bool l2CallSuccess
    );

    event FlashArbExecuted(
        uint256 wethBorrowed,
        uint256 cowBought,
        uint256 wethFromL2,
        uint256 profit
    );

    constructor() {
        owner = msg.sender;
    }

    receive() external payable {}

    // ──────────────────────────────────────────────
    //  Flash Loan Cross-Chain Arb (full bridge flow)
    // ──────────────────────────────────────────────

    /**
     * @notice Execute full flash loan cross-chain arbitrage
     * @param flashLender FlashLender contract
     * @param l1Router L1 Uniswap V2 Router
     * @param cowToken COW token on L1
     * @param wethToken WETH token on L1
     * @param l1Bridge L1 TokenBridge (holds locked WETH, locks COW)
     * @param borrowAmount WETH to flash borrow
     * @param l2Proxy CrossChainProxy for L2 TradeHelper
     * @param l2CallData Calldata for TradeHelper.executeArb (pre-computed by builder)
     */
    function executeFlashArb(
        address flashLender,
        address l1Router,
        address cowToken,
        address wethToken,
        address l1Bridge,
        uint256 borrowAmount,
        address l2Proxy,
        bytes calldata l2CallData
    ) external {
        bytes memory data = abi.encode(
            l1Router, cowToken, wethToken, l1Bridge, l2Proxy, l2CallData
        );
        IFlashLender(flashLender).flashLoan(wethToken, borrowAmount, data);

        // Sweep any remaining tokens to caller
        _sweepToken(cowToken, msg.sender);
        _sweepToken(wethToken, msg.sender);
    }

    /**
     * @notice Flash loan callback for the full cross-chain arb
     */
    function onFlashLoan(
        address token,
        uint256 amount,
        uint256 /* fee */,
        bytes calldata data
    ) external {
        // Pass raw data to helpers to avoid stack-too-deep from decoding here
        (,,address wethToken,,,) = abi.decode(data, (address, address, address, address, address, bytes));

        if (token == wethToken) {
            _executeFlashArbCallback(data, amount);
            return;
        }

        _executeLegacyCallback(data, amount);
        IERC20(token).transfer(msg.sender, amount);
    }

    function _executeLegacyCallback(bytes calldata data, uint256 amount) internal {
        (
            address l1Router,
            address cowToken,
            address wethToken,,
            address l2Proxy,
            bytes memory l2CallData
        ) = abi.decode(data, (address, address, address, address, address, bytes));

        IERC20(cowToken).approve(l1Router, amount);
        address[] memory path = new address[](2);
        path[0] = cowToken;
        path[1] = wethToken;
        uint[] memory amounts = IUniswapV2Router(l1Router).swapExactTokensForTokens(
            amount, 0, path, address(this), block.timestamp + 3600
        );
        (bool l2Success, ) = l2Proxy.call(l2CallData);
        emit ArbExecuted(amount, amounts[1], l2Proxy, l2Success);

        IERC20(wethToken).approve(l1Router, amounts[1]);
        path[0] = wethToken;
        path[1] = cowToken;
        IUniswapV2Router(l1Router).swapExactTokensForTokens(
            amounts[1], amount, path, address(this), block.timestamp + 3600
        );
    }

    function _executeFlashArbCallback(bytes calldata data, uint256 wethBorrowed) internal {
        (
            address l1Router,
            address cowToken,
            address wethToken,
            address l1Bridge,,
        ) = abi.decode(data, (address, address, address, address, address, bytes));

        // Step 1: Swap WETH -> COW on L1
        uint256 cowAmount;
        {
            IERC20(wethToken).approve(l1Router, wethBorrowed);
            address[] memory path = new address[](2);
            path[0] = wethToken;
            path[1] = cowToken;
            uint[] memory amounts = IUniswapV2Router(l1Router).swapExactTokensForTokens(
                wethBorrowed, 0, path, address(this), block.timestamp + 3600
            );
            cowAmount = amounts[1];
        }

        // Step 2: Lock COW in L1 bridge
        IERC20(cowToken).approve(l1Bridge, cowAmount);
        ITokenBridge(l1Bridge).deposit(cowToken, address(this), cowAmount);

        // Step 3+4+5: L2 call, release, repay (in separate function to avoid stack depth)
        uint256 wethFromL2 = _executeL2AndRelease(data, wethBorrowed);

        emit FlashArbExecuted(wethBorrowed, cowAmount, wethFromL2, wethFromL2 > wethBorrowed ? wethFromL2 - wethBorrowed : 0);
    }

    function _executeL2AndRelease(bytes calldata data, uint256 wethBorrowed) internal returns (uint256 wethFromL2) {
        (,,address wethToken, address l1Bridge, address l2Proxy, bytes memory l2CallData)
            = abi.decode(data, (address, address, address, address, address, bytes));

        (bool l2Success, bytes memory l2Result) = l2Proxy.call(l2CallData);
        require(l2Success, "L2 call failed");

        bytes memory innerResult = abi.decode(l2Result, (bytes));
        wethFromL2 = abi.decode(innerResult, (uint256));

        ITokenBridge(l1Bridge).releaseTo(wethToken, address(this), wethFromL2);
        IERC20(wethToken).transfer(msg.sender, wethBorrowed);
    }

    // ──────────────────────────────────────────────
    //  Simple arb (no flash loan, no bridge)
    // ──────────────────────────────────────────────

    function executeArbDirect(
        address l1Router,
        address cowToken,
        address wethToken,
        uint256 amountIn,
        uint256 l1MinOut,
        address l2Proxy,
        bytes calldata l2CallData
    ) external {
        IERC20(cowToken).transferFrom(msg.sender, address(this), amountIn);

        IERC20(cowToken).approve(l1Router, amountIn);
        address[] memory path = new address[](2);
        path[0] = cowToken;
        path[1] = wethToken;
        uint[] memory amounts = IUniswapV2Router(l1Router).swapExactTokensForTokens(
            amountIn, l1MinOut, path, address(this), block.timestamp + 3600
        );

        (bool l2Success, bytes memory l2Result) = l2Proxy.call(l2CallData);
        require(l2Success, string(abi.encodePacked("L2 call failed: ", l2Result)));

        emit ArbExecuted(amountIn, amounts[1], l2Proxy, l2Success);

        _sweepToken(cowToken, msg.sender);
        _sweepToken(wethToken, msg.sender);
    }

    /// @notice Call a proxy contract so that msg.sender = address(this).
    /// Used to set up L1→L2 cross-chain calls from this contract's source proxy on L2.
    function callProxy(address proxy, bytes calldata data) external {
        (bool success, ) = proxy.call(data);
        require(success, "Proxy call failed");
    }

    function _sweepToken(address token, address to) internal {
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal > 0) {
            IERC20(token).transfer(to, bal);
        }
    }
}
