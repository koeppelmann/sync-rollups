// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title Arbitrageur
 * @notice Executes swaps on a Uniswap V2 router and records profit.
 *         Used to demonstrate atomic cross-chain arbitrage.
 */
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

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
}

contract Arbitrageur {
    address public owner;
    uint256 public totalProfit;
    uint256 public tradeCount;

    event ArbitrageExecuted(
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        int256 profit
    );

    constructor() {
        owner = msg.sender;
    }

    /**
     * @notice Execute a swap on a given router
     * @param router Uniswap V2 router address
     * @param tokenIn Input token
     * @param tokenOut Output token
     * @param amountIn Amount of tokenIn to swap
     * @param amountOutMin Minimum output (slippage protection)
     */
    function executeSwap(
        address router,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin
    ) external returns (uint256 amountOut) {
        // Transfer tokens in
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);

        // Approve router
        IERC20(tokenIn).approve(router, amountIn);

        // Build path
        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;

        // Execute swap
        uint[] memory amounts = IUniswapV2Router(router).swapExactTokensForTokens(
            amountIn,
            amountOutMin,
            path,
            address(this),
            block.timestamp + 3600
        );

        amountOut = amounts[amounts.length - 1];

        // Transfer output to sender
        IERC20(tokenOut).transfer(msg.sender, amountOut);

        tradeCount++;
        emit ArbitrageExecuted(tokenIn, tokenOut, amountIn, amountOut, int256(amountOut) - int256(amountIn));
    }

    /**
     * @notice Preview swap output amount
     */
    function previewSwap(
        address router,
        address tokenIn,
        address tokenOut,
        uint256 amountIn
    ) external view returns (uint256 amountOut) {
        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;
        uint[] memory amounts = IUniswapV2Router(router).getAmountsOut(amountIn, path);
        return amounts[amounts.length - 1];
    }

    /**
     * @notice Record profit from an arbitrage round (called by owner)
     */
    function recordProfit(uint256 profit) external {
        totalProfit += profit;
    }
}
