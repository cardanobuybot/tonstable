// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {TonstableVault} from "../src/TonstableVault.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockSwapRouter} from "../src/mocks/MockSwapRouter.sol";

/**
 * @title DeployTestnet
 * @notice Deploys full TONSTABLE stack to Arbitrum Sepolia testnet
 * @dev Uses mock USDC, LUSD, and Uniswap router because Arbitrum Sepolia
 *      lacks real liquidity for these assets.
 *
 * Run:
 *   forge script script/DeployTestnet.s.sol:DeployTestnet \
 *     --rpc-url $ARB_SEPOLIA_RPC \
 *     --private-key $DEPLOYER_PRIVATE_KEY \
 *     --broadcast \
 *     -vvv
 */
contract DeployTestnet is Script {
    // Arbitrum Sepolia LayerZero V2 Endpoint
    address constant LZ_ENDPOINT_ARB_SEPOLIA =
        0x6EDCE65403992e310A62460808c4b910D972f10f;

    // TON testnet endpoint ID (LayerZero)
    uint32 constant TON_TESTNET_EID = 40343;

    // Pool fee tier passed to TonstableVault constructor (must be 100/500/3000/10000).
    // MockSwapRouter ignores this value, but the vault constructor validates it.
    uint24 constant MOCK_POOL_FEE = 500;

    function run() external {
        // msg.sender == --sender (dry-run) or the key passed via --private-key (broadcast).
        // Avoids parsing DEPLOYER_PRIVATE_KEY as uint256 (Foundry requires 0x prefix).
        address deployer = msg.sender;

        console.log("=== TONSTABLE Testnet Deployment ===");
        console.log("Deployer:", deployer);
        console.log("Balance:", deployer.balance);

        vm.startBroadcast();

        // ──────────────────────────────────────────────────
        // 1. Deploy Mock USDC (6 decimals like real USDC)
        // ──────────────────────────────────────────────────
        MockERC20 mockUSDC = new MockERC20("Mock USD Coin", "mUSDC", 6);
        console.log("MockUSDC deployed:", address(mockUSDC));

        // ──────────────────────────────────────────────────
        // 2. Deploy Mock LUSD (18 decimals like real LUSD)
        // ──────────────────────────────────────────────────
        MockERC20 mockLUSD = new MockERC20("Mock Liquity USD", "mLUSD", 18);
        console.log("MockLUSD deployed:", address(mockLUSD));

        // ──────────────────────────────────────────────────
        // 3. Deploy Mock Swap Router
        // ──────────────────────────────────────────────────
        MockSwapRouter mockRouter = new MockSwapRouter();
        console.log("MockSwapRouter deployed:", address(mockRouter));

        // ──────────────────────────────────────────────────
        // 4. Deploy TonstableVault
        //    Constructor: (endpoint, owner, usdc, collateral, router, poolFee, tonEid)
        //    poolFee is validated against {100, 500, 3000, 10000} — use 500.
        // ──────────────────────────────────────────────────
        TonstableVault vault = new TonstableVault(
            LZ_ENDPOINT_ARB_SEPOLIA,
            deployer,             // owner
            address(mockUSDC),    // USDC
            address(mockLUSD),    // collateral (LUSD)
            address(mockRouter),  // swap router
            MOCK_POOL_FEE,        // 0.05% tier — ignored by mock, required by vault
            TON_TESTNET_EID       // TON testnet eid
        );
        console.log("TonstableVault deployed:", address(vault));

        // ──────────────────────────────────────────────────
        // 5. Mint test tokens to deployer for initial testing
        // ──────────────────────────────────────────────────
        mockUSDC.mint(deployer, 10_000 * 1e6);   // 10,000 mUSDC
        mockLUSD.mint(deployer, 10_000 * 1e18);  // 10,000 mLUSD
        console.log("Minted 10,000 mUSDC and 10,000 mLUSD to deployer");

        vm.stopBroadcast();

        // ──────────────────────────────────────────────────
        // Summary
        // ──────────────────────────────────────────────────
        console.log("");
        console.log("=== Deployment Summary ===");
        console.log("Network: Arbitrum Sepolia");
        console.log("LZ Endpoint:", LZ_ENDPOINT_ARB_SEPOLIA);
        console.log("MockUSDC:", address(mockUSDC));
        console.log("MockLUSD:", address(mockLUSD));
        console.log("MockSwapRouter:", address(mockRouter));
        console.log("TonstableVault:", address(vault));
        console.log("Owner:", deployer);
        console.log("TON EID:", TON_TESTNET_EID);
    }
}
