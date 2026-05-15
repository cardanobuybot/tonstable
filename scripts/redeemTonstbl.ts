// ============================================================================
//  redeemTonstbl.ts  —  testnet burn + redeem flow via MockBridgeAdapter
//
//  Requires a prior successful mintTonstbl.ts run so the user has TONSTBL.
//
//  Flow:
//    1. Query the user's JettonWallet to confirm a non-zero balance
//    2. JettonBurn → JettonBurnNotification → Minter
//       → BridgeRedeemRequest → MockBridgeAdapter
//       → RedeemPayout → Minter → user (gas remainder returned)
// ============================================================================

import { toNano, Address } from '@ton/core';
import {
    TonstableMinter,
} from '../build/TonstableMinter/TonstableMinter_TonstableMinter';
import {
    TonstableJettonWallet,
    JettonBurn,
} from '../build/TonstableJettonWallet/TonstableJettonWallet_TonstableJettonWallet';
import { NetworkProvider } from '@ton/blueprint';

// ── update this to the current Minter address after each redeploy ──────────
const MINTER_ADDRESS = Address.parse('EQBxamaMURMxsklbBNinjiMqtaj7nt-iSw6z3bXfrfCC3LaS');

export async function run(provider: NetworkProvider) {
    const sender     = provider.sender();
    const senderAddr = sender.address!;

    const minter     = provider.open(TonstableMinter.fromAddress(MINTER_ADDRESS));
    const walletAddr = await minter.getGetWalletAddress(senderAddr);
    const wallet     = provider.open(TonstableJettonWallet.fromAddress(walletAddr));

    // ── 1. Check balance ──────────────────────────────────────────────────────
    const balance = await wallet.getBalance();
    console.log('JettonWallet address :', walletAddr.toString());
    console.log('TONSTBL balance      :', balance.toString(), 'raw units');

    if (balance === 0n) {
        console.log('\nNothing to redeem — run mintTonstbl first.');
        return;
    }

    // ── 2. Burn all tokens → triggers MockBridgeAdapter auto-confirm ─────────
    // 0.3 TON covers the 4-hop gas chain:
    //   wallet → minter → adapter → minter → user
    console.log(`\nBurning ${balance} TONSTBL...`);
    await wallet.send(
        sender,
        { value: toNano('0.3') },
        {
            $$type:              'JettonBurn',
            queryId:             BigInt(Math.floor(Date.now() / 1000)),
            amount:              balance,
            responseDestination: senderAddr,
            customPayload:       null,
        } satisfies JettonBurn,
    );

    console.log('\n✓  JettonBurn sent!');
    console.log('   The chain will settle in ~30 s:');
    console.log('   JettonBurn → JettonBurnNotification → BridgeRedeemRequest');
    console.log('   → RedeemPayout → TON returned to your wallet');
    console.log('\n   Run _verifyRedeem.ts to confirm, or check:');
    console.log('   https://testnet.tonscan.org/address/' + walletAddr.toString());
}
