// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Script, console} from "forge-std/Script.sol";
import {TonstableVault} from "../src/TonstableVault.sol";

/**
 * @title SetPeerScript
 * @notice Wires the deployed TonstableVault to the TON-side OApp via LayerZero setPeer.
 *
 * Run (dry-run, no broadcast):
 *   forge script script/SetPeer.s.sol:SetPeerScript \
 *     --rpc-url $ARB_SEPOLIA_RPC
 *
 * Run (broadcast — only when ready):
 *   forge script script/SetPeer.s.sol:SetPeerScript \
 *     --rpc-url $ARB_SEPOLIA_RPC \
 *     --broadcast \
 *     -vvv
 *
 * Required env:
 *   DEPLOYER_PRIVATE_KEY  — hex key WITH 0x prefix, must be owner of TonstableVault
 */
contract SetPeerScript is Script {
    // LayerZero EID for TON testnet
    uint32 constant TON_EID = 40343;

    // TON OApp bytes32 peer: Address.parse("EQCauDCj...").hash (256-bit hash, workchain dropped).
    // Verified: BytesEncoder.fc store_uint256(srcOApp) puts this exact value in the LZ packet.
    bytes32 constant TON_OAPP_PEER =
        0x9ab830a3f25921618b3d2d0a9627ab270f45a0ba4f9cc01de699a43195cc5b6c;

    // Deployed TonstableVault on Arbitrum Sepolia
    address constant VAULT = 0xAc997b1723b497Aa7694D4a402Dd34943df81B20;

    function run() external {
        // DEPLOYER_PRIVATE_KEY must have 0x prefix (Foundry vm.envUint requirement).
        // The derived address must be the Vault owner (set to deployer in DeployTestnet.s.sol).
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        vm.startBroadcast(pk);

        TonstableVault vault = TonstableVault(VAULT);
        vault.setPeer(TON_EID, TON_OAPP_PEER);

        vm.stopBroadcast();

        console.log("Vault.setPeer complete:");
        console.log("  Vault:       ", VAULT);
        console.log("  TON_EID:     ", TON_EID);
        console.log("  peer (TON OApp hash):");
        console.logBytes32(TON_OAPP_PEER);
    }
}
