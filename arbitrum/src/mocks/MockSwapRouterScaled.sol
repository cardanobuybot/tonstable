// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/// @notice Test-only swap router for fork tests that respects token
/// decimals. Designed to be etched via `vm.etch` onto the deployed
/// MockSwapRouter address; replaces the 1:1-raw behavior with a
/// scale-aware 1:1-value model that mirrors how a real Uniswap v3
/// pool moves USDC (6 dec) <-> LUSD (18 dec).
///
/// Storage layout matches MockSwapRouter for `outputBps` (slot 0)
/// so existing setOutputBps calls continue to work after etch.
interface IMintableERC20Scaled {
    function mint(address to, uint256 amount) external;
}

contract MockSwapRouterScaled {
    // Must occupy slot 0 to be compatible with vm.etch storage
    // semantics if any prior code wrote to it. In practice fork
    // tests call setOutputBps AFTER etching, so storage starts
    // fresh — but keeping layout aligned is defensive.
    uint16 public outputBps = 10000;

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

    function setOutputBps(uint16 bps) external {
        outputBps = bps;
    }

    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut)
    {
        uint8 decIn = IERC20Metadata(params.tokenIn).decimals();
        uint8 decOut = IERC20Metadata(params.tokenOut).decimals();

        // 1:1-value scale conversion
        uint256 scaled;
        if (decOut > decIn) {
            scaled = params.amountIn * (10 ** (uint256(decOut) - uint256(decIn)));
        } else if (decIn > decOut) {
            scaled = params.amountIn / (10 ** (uint256(decIn) - uint256(decOut)));
        } else {
            scaled = params.amountIn;
        }

        // Apply outputBps slippage simulation (default 10000 = 100%)
        amountOut = (scaled * uint256(outputBps)) / 10000;

        // Same slippage check as MockSwapRouter — mirrors real router
        require(amountOut >= params.amountOutMinimum, "Mock: insufficient output");

        // Mint the output token to recipient (no pre-funded balance needed)
        IMintableERC20Scaled(params.tokenOut).mint(params.recipient, amountOut);
    }
}
