import { NetworkProvider } from '@ton/blueprint';
import { Address, toNano } from '@ton/core';
import {
    TonstableMinter,
    SetBridgeAdapter,
} from '../build/TonstableMinter/TonstableMinter_TonstableMinter';

// ─── ADDRESSES ───────────────────────────────────────────────────────────────
//
// MINTER: consistent across 8 scripts — "EWW" (double capital W at pos 20).
//   User provided "EWw" (capital W + lowercase w) — verify before running.
//
// NEW_OAPP: from setPeerTON.ts + memory — uses digit "0" (zero).
//   User provided "O" (letter O) at positions 5 and 22 — verify before running.
//
const MINTER_ADDR = 'EQA31yC0LEgeshdze-eFQntYknWsFkZfYKPpIAi0XbGIhPKi';
const NEW_OAPP    = 'EQA2SPLtbQGkijeadXNHdhO3swGIJCBK_4LhFcJBHKV6_9BK';


export async function run(provider: NetworkProvider) {
    const minterAddr = Address.parse(MINTER_ADDR);
    const newAdapter = Address.parse(NEW_OAPP);

    // ── Step 1: pre-flight — verify sender is the on-chain owner ────────────
    const minter = provider.open(TonstableMinter.fromAddress(minterAddr));

    const onChainOwner = await minter.getOwner();
    const senderAddr   = provider.sender().address;

    console.log('=== SetBridgeAdapter: Pre-flight ===');
    console.log('Minter:            ', minterAddr.toString());
    console.log('On-chain owner:    ', onChainOwner.toString());
    console.log('Sender (wallet):   ', senderAddr?.toString() ?? '(unknown)');
    console.log('New adapter (OApp):', newAdapter.toString());
    console.log('');

    if (!senderAddr || senderAddr.toString() !== onChainOwner.toString()) {
        throw new Error(
            `Sender ${senderAddr?.toString() ?? '(unknown)'} ≠ Minter owner ${onChainOwner.toString()}.\n` +
            'Switch to the owner wallet before running this script.',
        );
    }

    // ── Step 2: send SetBridgeAdapter ─────────────────────────────────────────
    //
    // Message format (from ABI, opcode 0xB87A0CA6 = 3090989158):
    //   SetBridgeAdapter { newAdapter: Address }
    // Auth: receive(msg: SetBridgeAdapter) { self.requireOwner(); ... }
    //
    const msg: SetBridgeAdapter = {
        $$type:     'SetBridgeAdapter',
        newAdapter,
    };

    console.log('Sending SetBridgeAdapter...');
    await minter.send(
        provider.sender(),
        { value: toNano('0.05') },
        msg,
    );

    console.log('');
    console.log('Transaction sent. Verify on testnet:');
    console.log('  https://testnet.tonviewer.com/' + minterAddr.toString());
    console.log('');
    console.log('After confirmation, verify new bridgeAdapter on-chain:');
    console.log('  expected:', newAdapter.toString());
}
