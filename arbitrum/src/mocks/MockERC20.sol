// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockERC20
 * @notice Mock ERC20 token for testnet deployment of TONSTABLE
 * @dev Anyone can mint to themselves (testnet only — DO NOT use on mainnet)
 *
 * Use case: simulates USDC and LUSD on Arbitrum Sepolia where these
 * tokens have no real liquidity. Allows testing mint/redeem flow.
 */
contract MockERC20 is ERC20 {
    uint8 private _customDecimals;

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_
    ) ERC20(name_, symbol_) {
        _customDecimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _customDecimals;
    }

    /**
     * @notice Mint tokens to any address. PUBLIC — testnet only.
     */
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /**
     * @notice Burn tokens from caller. Convenience function for testing.
     */
    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }
}
