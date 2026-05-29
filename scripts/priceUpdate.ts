import { NetworkProvider } from '@ton/blueprint';
import { Address, toNano } from '@ton/core';
import {
    TonstableMinter,
    PriceUpdate,
} from '../build/TonstableMinter/TonstableMinter_TonstableMinter';

// New Minter — digit "0" (zero) at position 8 (yC0), confirmed 2026-05-27
const MINTER_ADDR  = 'EQA31yC0LEgeshdze-eFQntYknWsFkZfYKPpIAi0XbGIhPKi';
// $1.90 with 8 decimals — same value used in _realHop.ts for step 10
const PRICE        = 190_000_000n;

export async function run(provider: NetworkProvider) {
    const minterAddr = Address.parse(MINTER_ADDR);
    const minter = provider.open(TonstableMinter.fromAddress(minterAddr));

    const onChainOwner = await minter.getOwner();
    const senderAddr   = provider.sender().address;

    // Fresh timestamp — critical to avoid stale-price rejection
    const timestamp = BigInt(Math.floor(Date.now() / 1000));

    console.log('=== PriceUpdate: Pre-flight ===');
    console.log('Minter:          ', minterAddr.toString());
    console.log('On-chain owner:  ', onChainOwner.toString());
    console.log('Sender (wallet): ', senderAddr?.toString() ?? '(unknown)');
    console.log('Price (raw):     ', PRICE.toString(), '  ($1.90)');
    console.log('Timestamp:       ', timestamp.toString(), ' (now)');
    console.log('');

    if (!senderAddr || senderAddr.toString() !== onChainOwner.toString()) {
        throw new Error(
            `Sender ${senderAddr?.toString() ?? '(unknown)'} ≠ Minter owner ${onChainOwner.toString()}.\n` +
            'Switch to the owner wallet before running this script.',
        );
    }

    const msg: PriceUpdate = {
        $$type:    'PriceUpdate',
        price:     PRICE,
        timestamp,
    };

    console.log('Sending PriceUpdate...');
    await minter.send(
        provider.sender(),
        { value: toNano('0.05') },
        msg,
    );

    console.log('');
    console.log('Transaction sent. Verify on testnet:');
    console.log('  https://testnet.tonviewer.com/' + minterAddr.toString());
}
