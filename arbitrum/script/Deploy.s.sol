// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Script, console} from "forge-std/Script.sol";
import {TonstableVault} from "../src/TonstableVault.sol";

/**
 * @title Deployment Script for TonstableVault
 * @notice Run on Arbitrum Sepolia testnet first, then mainnet after audit.
 *
 * Usage:
 *   Testnet: forge script script/Deploy.s.sol --rpc-url $ARB_SEPOLIA_RPC \
 *            --broadcast --verify
 *   Mainnet: forge script script/Deploy.s.sol --rpc-url $ARB_MAINNET_RPC \
 *            --broadcast --verify
 *
 * Required env vars:
 *   PRIVATE_KEY        - deployer key (USE A FRESH KEY, NEVER MAINNET MAIN)
 *   ARB_LZ_ENDPOINT    - LayerZero v2 endpoint on Arbitrum
 *   USDC_ADDRESS       - USDC token on target Arbitrum network
 *   LUSD_ADDRESS       - LUSD token on target Arbitrum network
 *   UNISWAP_V3_ROUTER  - Uniswap V3 SwapRouter address
 *   POOL_FEE           - Pool fee tier (500 for 0.05% typical)
 *   TON_EID            - LayerZero endpoint ID for TON
 *   INITIAL_OWNER      - Address that will own the vault (recommend multisig)
 */
contract DeployTonstableVault is Script {
    // ─────────────────────────────────────────────────────────────────────────
    //  KNOWN ADDRESSES — Update before deployment
    // ─────────────────────────────────────────────────────────────────────────

    // Arbitrum One (mainnet)
    address constant ARB_MAINNET_LZ_ENDPOINT = 0x1a44076050125825900e736c501f859c50fE728c;
    address constant ARB_MAINNET_USDC = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831;
    address constant ARB_MAINNET_LUSD = 0x93b346b6BC2548dA6A1E7d98E9a421B42541425b;
    address constant ARB_MAINNET_UNISWAP_V3_ROUTER = 0xE592427A0AEce92De3Edee1F18E0157C05861564;

    // Arbitrum Sepolia (testnet)
    address constant ARB_SEPOLIA_LZ_ENDPOINT = 0x6EDCE65403992e310A62460808c4b910D972f10f;
    // NOTE: USDC and LUSD on Sepolia require test deployments — use MockERC20

    // LayerZero v2 endpoint IDs
    uint32 constant TON_MAINNET_EID = 30343;
    uint32 constant TON_TESTNET_EID = 40343;

    function run() external returns (TonstableVault vault) {
        // Load configuration from environment
        uint256 deployerPK = vm.envUint("PRIVATE_KEY");
        address lzEndpoint = vm.envAddress("ARB_LZ_ENDPOINT");
        address usdc = vm.envAddress("USDC_ADDRESS");
        address lusd = vm.envAddress("LUSD_ADDRESS");
        address router = vm.envAddress("UNISWAP_V3_ROUTER");
        uint24 poolFee = uint24(vm.envUint("POOL_FEE"));
        uint32 tonEid = uint32(vm.envUint("TON_EID"));
        address initialOwner = vm.envAddress("INITIAL_OWNER");

        console.log("=== TonstableVault Deployment ===");
        console.log("Deployer:", vm.addr(deployerPK));
        console.log("LZ Endpoint:", lzEndpoint);
        console.log("USDC:", usdc);
        console.log("LUSD:", lusd);
        console.log("Uniswap Router:", router);
        console.log("Pool Fee:", poolFee);
        console.log("TON EID:", tonEid);
        console.log("Initial Owner:", initialOwner);
        console.log("");

        vm.startBroadcast(deployerPK);

        vault = new TonstableVault(
            lzEndpoint,
            initialOwner,
            usdc,
            lusd,
            router,
            poolFee,
            tonEid
        );

        vm.stopBroadcast();

        console.log("=== Deployment Complete ===");
        console.log("TonstableVault deployed at:", address(vault));
        console.log("");
        console.log("NEXT STEPS:");
        console.log("1. Verify contract on Arbiscan");
        console.log("2. Set LayerZero peer (TON-side Minter address)");
        console.log("3. Configure LayerZero DVNs and executor");
        console.log("4. Transfer ownership to multisig if not already set");
        console.log("5. Test with small amounts before any production use");

        return vault;
    }
}
