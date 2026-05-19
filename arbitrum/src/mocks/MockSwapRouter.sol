// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IMintableERC20 {
    function mint(address to, uint256 amount) external;
}

/**
 * @title MockSwapRouter
 * @notice Minimal Uniswap V3 router replacement for testnet
 * @dev Performs 1:1 swap between two mock tokens. Testnet only.
 *
 * Real Uniswap V3 router signature:
 *   exactInputSingle(ExactInputSingleParams calldata params) returns (uint256 amountOut)
 *
 * This mock implements the same signature, but instead of routing through
 * a pool, it burns the input and mints the output 1:1.
 */
contract MockSwapRouter {
    using SafeERC20 for IERC20;

    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    /**
     * @notice Mock 1:1 swap. Pulls tokenIn from msg.sender, mints tokenOut
     *         to recipient.
     * @dev tokenIn and tokenOut must be MockERC20 (have public mint).
     */
    function exactInputSingle(
        ExactInputSingleParams calldata params
    ) external returns (uint256 amountOut) {
        require(block.timestamp <= params.deadline, "Mock: deadline expired");

        // Pull tokenIn from caller
        IERC20(params.tokenIn).safeTransferFrom(
            msg.sender,
            address(this),
            params.amountIn
        );

        // For decimals adjustment: USDC=6, LUSD=18, etc.
        // We assume both tokens have same decimals for simplicity.
        // If different, caller adjusts amountOutMinimum accordingly.
        amountOut = params.amountIn;

        require(
            amountOut >= params.amountOutMinimum,
            "Mock: insufficient output"
        );

        // Mint tokenOut to recipient
        IMintableERC20(params.tokenOut).mint(params.recipient, amountOut);

        return amountOut;
    }
}
