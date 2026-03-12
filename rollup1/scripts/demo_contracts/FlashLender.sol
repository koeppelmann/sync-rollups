// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
}

interface IFlashBorrower {
    function onFlashLoan(address token, uint256 amount, uint256 fee, bytes calldata data) external;
}

/**
 * @title FlashLender
 * @notice Simple flash loan provider for demo purposes.
 *         Anyone can deposit tokens. Flash loans have zero fees.
 */
contract FlashLender {
    /// @notice Anyone can deposit tokens for lending
    function deposit(address token, uint256 amount) external {
        IERC20(token).transferFrom(msg.sender, address(this), amount);
    }

    /// @notice Execute a flash loan
    function flashLoan(address token, uint256 amount, bytes calldata data) external {
        uint256 balBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).transfer(msg.sender, amount);
        IFlashBorrower(msg.sender).onFlashLoan(token, amount, 0, data);
        require(IERC20(token).balanceOf(address(this)) >= balBefore, "FlashLender: not repaid");
    }
}
