import { toNano, Address, beginCell } from '@ton/core';
import { TonstableMinter, Deploy } from '../build/TonstableMinter/TonstableMinter_TonstableMinter';
import { NetworkProvider } from '@ton/blueprint';

// W5 testnet admin address — used for all administrative roles until
// bridge adapter and oracle keeper are deployed separately.
const ADMIN_ADDRESS = Address.parse('0QAvWnxIIxiQ73MrKzI9_zQCxinF1yO5G7WZ1s7_Yo7lb8dv');

// Minimal on-chain jetton content cell (snake-encoded off-chain metadata pointer).
// Replace the URI with a real metadata JSON URL before mainnet.
const JETTON_CONTENT = beginCell()
    .storeUint(0x01, 8)  // off-chain snake layout
    .storeStringTail('https://tonstable.io/jetton-metadata.json')
    .endCell();

export async function run(provider: NetworkProvider) {
    const tonstableMinter = provider.open(
        await TonstableMinter.fromInit(
            ADMIN_ADDRESS,   // owner
            ADMIN_ADDRESS,   // guardian
            ADMIN_ADDRESS,   // bridgeAdapter (placeholder — update before production)
            ADMIN_ADDRESS,   // oracleKeeper  (placeholder — update before production)
            JETTON_CONTENT,
        )
    );

    const deployMsg: Deploy = { $$type: 'Deploy', queryId: 0n };

    await tonstableMinter.send(
        provider.sender(),
        {
            value: toNano('0.05'),
        },
        deployMsg,
    );

    await provider.waitForDeploy(tonstableMinter.address);

    console.log('TonstableMinter deployed at', tonstableMinter.address.toString());
}
