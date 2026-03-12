// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
}

interface ITokenBridge {
    function mintTo(address wrappedToken, address to, uint256 amount) external;
}

interface IUniswapV2Router {
    function swapExactTokensForTokens(
        uint amountIn, uint amountOutMin, address[] calldata path,
        address to, uint deadline
    ) external returns (uint[] memory amounts);
}

/**
 * @title TradeHelper
 * @notice L2 contract for cross-chain arbitrage. Called via L1→L2 cross-chain proxy.
 *
 * When triggered from L1:
 *   1. Mints wCOW from L2 bridge (COW was locked on L1)
 *   2. Checks wCOW balance
 *   3. Swaps wCOW → wETH on L2 Uniswap
 *   4. Reverts if wETH output < minWethOut
 *   5. Transfers wETH to L2 bridge (for bridge-back to L1)
 */
contract TradeHelper {
    event ArbExecuted(uint256 cowIn, uint256 wethOut);

    /**
     * @notice Execute the L2 side of the cross-chain arb
     * @param bridge L2 TokenBridge address
     * @param wCowToken wCOW token on L2
     * @param wEthToken wETH token on L2
     * @param router L2 Uniswap V2 Router
     * @param cowAmount Amount of wCOW to mint from bridge
     * @param minWethOut Minimum wETH output (reverts if not met)
     * @param bridgeBack Address to send wETH for bridge-back (L2 bridge)
     * @return wethOut Amount of wETH received from swap
     */
    function executeArb(
        address bridge,
        address wCowToken,
        address wEthToken,
        address router,
        uint256 cowAmount,
        uint256 minWethOut,
        address bridgeBack
    ) external returns (uint256 wethOut) {
        // 1. Mint wCOW from L2 bridge
        ITokenBridge(bridge).mintTo(wCowToken, address(this), cowAmount);

        // 2. Check balance
        uint256 balance = IERC20(wCowToken).balanceOf(address(this));
        require(balance >= cowAmount, "TradeHelper: no wCOW received");

        // 3. Swap wCOW -> wETH
        IERC20(wCowToken).approve(router, balance);
        address[] memory path = new address[](2);
        path[0] = wCowToken;
        path[1] = wEthToken;
        uint[] memory amounts = IUniswapV2Router(router).swapExactTokensForTokens(
            balance, minWethOut, path, address(this), block.timestamp + 3600
        );
        wethOut = amounts[amounts.length - 1];

        // 4. Transfer wETH to bridge for bridge-back to L1
        if (bridgeBack != address(0)) {
            IERC20(wEthToken).transfer(bridgeBack, wethOut);
        }

        emit ArbExecuted(balance, wethOut);
        return wethOut;
    }
}
