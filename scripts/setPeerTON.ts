import { NetworkProvider } from '@ton/blueprint';
import { Address, toNano } from '@ton/core';
import { TonstableOApp } from '../wrappers/TonstableOApp';

// Verified encoding (BytesEncoder.fc + UnitTest.ts):
//   EVM address arrives as uint256 = bytes32(uint256(uint160(addr))), right-aligned
const ARB_VAULT_ADDR = '0xAc997b1723b497Aa7694D4a402Dd34943df81B20';
const ARB_SEPOLIA_EID = 40231;
const OAPP_ADDR = 'EQCauDCj8lkhYYs9LQqWJ6snD0Wguk-cwB3mmaQxlcxbbO5r';

export async function run(provider: NetworkProvider) {
    const oapp = provider.open(TonstableOApp.createFromAddress(Address.parse(OAPP_ADDR)));

    const peer = BigInt(ARB_VAULT_ADDR);
    const peerHex = '0x' + peer.toString(16).padStart(64, '0');

    console.log('=== SetPeer: TON OApp -> Arbitrum Vault ===');
    console.log('OApp:  ', OAPP_ADDR);
    console.log('dstEid:', ARB_SEPOLIA_EID, '(Arbitrum Sepolia)');
    console.log('peer:  ', peerHex);
    console.log('  (Arb Vault right-aligned in uint256, top 12 bytes = 0)');

    await oapp.sendSetPeer(provider.sender(), {
        value: toNano('0.1'),
        dstEid: ARB_SEPOLIA_EID,
        peer,
    });

    console.log('SetPeer transaction sent. Monitor via tonviewer.');
}
