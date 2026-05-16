import { toNano, Address, beginCell, Cell, Dictionary } from '@ton/core';
import { createHash } from 'crypto';
import { TonstableMinter, Deploy } from '../build/TonstableMinter/TonstableMinter_TonstableMinter';
import { NetworkProvider } from '@ton/blueprint';

// W5 testnet admin address — used for all administrative roles until
// bridge adapter and oracle keeper are deployed separately.
const ADMIN_ADDRESS = Address.parse('0QAvWnxIIxiQ73MrKzI9_zQCxinF1yO5G7WZ1s7_Yo7lb8dv');

// Builds a TEP-64 on-chain metadata cell.
// Layout: 0x00 || HashmapE(256, ^SnakeCell)
// Key:   SHA256 of the field name (uint256)
// Value: ref cell with 0x00 snake-prefix + UTF-8 string
function buildOnChainMetadata(fields: Record<string, string>): Cell {
    const dict = Dictionary.empty(
        Dictionary.Keys.BigUint(256),
        Dictionary.Values.Cell(),
    );
    for (const [key, value] of Object.entries(fields)) {
        const keyHash = BigInt('0x' + createHash('sha256').update(key).digest('hex'));
        dict.set(
            keyHash,
            beginCell().storeUint(0x00, 8).storeStringTail(value).endCell(),
        );
    }
    return beginCell().storeUint(0x00, 8).storeDict(dict).endCell();
}

// TEP-64 on-chain metadata for TONSTBL.
// Replace `image` URL with the real logo link before mainnet.
const JETTON_CONTENT = buildOnChainMetadata({
    name:        'TONSTABLE',
    symbol:      'TONSTBL',
    decimals:    '9',
    description: 'Cross-chain backed stablecoin pegged to USD and secured by Arbitrum vaults',
    image:       'https://tonstable.io/logo.png',
});

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
