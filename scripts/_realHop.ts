// _realHop.ts — real LZ hop: PriceUpdate + DepositTon only.
// bridgeAdapter is already wired to OAPP_NEW (EQA2SPLt...9BK).
// SetBridgeAdapter is ABSENT — running it would overwrite the wiring back to mock.
//
// Usage:
//   npx blueprint run _realHop --testnet --mnemonic "word1 word2 ..."

import { toNano, Address } from '@ton/core';
import {
    TonstableMinter,
    PriceUpdate,
    DepositTon,
} from '../build/TonstableMinter/TonstableMinter_TonstableMinter';
import { NetworkProvider } from '@ton/blueprint';

// ─── addresses ─────────────────────────────────────────────────────────────────
const MINTER_ADDRESS = Address.parse('EQA31yC0LEgeshdze-eFQntYknWsFkZfYKPpIAi0XbGIhPKi');

// ─── oracle price: $1.90/TON — current on-chain cached value (PRICE_DECIMALS = 1e8)
// Sending the same price keeps deviation = 0%, fresh timestamp clears staleness.
const ORACLE_PRICE = 190_000_000n;

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

export async function run(provider: NetworkProvider) {
    const minter = provider.open(TonstableMinter.fromAddress(MINTER_ADDRESS));
    const sender = provider.sender();

    console.log('=== _realHop: PriceUpdate + DepositTon  [NO SetBridgeAdapter] ===');
    console.log('Minter :', MINTER_ADDRESS.toString());
    console.log('Sender :', sender.address?.toString() ?? '(unknown)');
    console.log('');

    // ── Step 1: PriceUpdate ───────────────────────────────────────────────────
    // Minter rejects if price age > oracleMaxStaleness (300 s) — must be fresh.
    // Sender must be oracle / oracleKeeper (= deployer wallet).
    const priceTimestamp = BigInt(Math.floor(Date.now() / 1000));
    console.log('[1/2] PriceUpdate  price=$100,000/TON  timestamp=' + priceTimestamp);
    await minter.send(
        sender,
        { value: toNano('0.05') },
        {
            $$type:    'PriceUpdate',
            price:     ORACLE_PRICE,
            timestamp: priceTimestamp,
        } satisfies PriceUpdate,
    );
    console.log('  sent. Waiting 20 s for oracle state to land on-chain...');
    await sleep(20_000);

    // ── Step 2: DepositTon ────────────────────────────────────────────────────
    // value = 3 TON:
    //   • DEFAULT_MIN_DEPOSIT = 2 TON (contract check)
    //   • feeFloor = 0.5 TON (taken by Minter)
    //   • remaining ≥ 0.5 TON covers bridgeForwardGas to LZ
    // minTonstblOut = 1  → accept any non-zero amount on first real hop.
    const depositDeadline = BigInt(Math.floor(Date.now() / 1000)) + 3600n;
    console.log('[2/2] DepositTon  value=3 TON  minTonstblOut=1  deadline+3600s');
    await minter.send(
        sender,
        { value: toNano('3') },
        {
            $$type:        'DepositTon',
            minTonstblOut: 1n,
            deadline:      depositDeadline,
        } satisfies DepositTon,
    );

    console.log('\n✓  DepositTon sent. Cross-chain delivery takes 2-5 min.');
    console.log('');
    console.log('Monitor Minter:');
    console.log('  https://testnet.tonviewer.com/' + MINTER_ADDRESS.toString());
    console.log('Monitor OApp:');
    console.log('  https://testnet.tonviewer.com/EQA2SPLtbQGkijeadXNHdhO3swGIJCBK_4LhFcJBHKV6_9BK');
    console.log('Monitor Vault (Arb Sepolia):');
    console.log('  https://sepolia.arbiscan.io/address/0xAc997b1723b497Aa7694D4a402Dd34943df81B20');
    console.log('');
    console.log('After delivery, verify LUSD minted on Arb:');
    console.log('  cast call 0x6e413f5eef1889b765f60f196c98896f89cc1422 "balanceOf(address)(uint256)" 0xAc997b1723b497Aa7694D4a402Dd34943df81B20 --rpc-url $ARB_SEPOLIA_RPC');
}
