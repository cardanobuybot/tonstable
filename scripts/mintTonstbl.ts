// ============================================================================
//  mintTonstbl.ts  —  testnet dev mint via MockBridgeAdapter
//
//  Why this approach:
//    The Minter forwards BridgeMintRequest to bridgeAdapter with bounce=true.
//    A W5 wallet throws on unrecognized op codes, triggering the bounced<>
//    handler that deletes the pending mint before MintConfirmation can arrive.
//
//    The fix: point bridgeAdapter at MockBridgeAdapter, a contract that
//    explicitly handles BridgeMintRequest and auto-replies with MintConfirmation.
//
//  Flow (all in one run):
//    1. Deploy MockBridgeAdapter (idempotent — skipped if already deployed)
//    2. SetBridgeAdapter → Minter now forwards requests to MockBridgeAdapter
//    3. PriceUpdate       → fresh oracle timestamp (same $100k/TON price)
//    4. DepositTon        → Minter creates pending mint, sends BridgeMintRequest
//                           → MockBridgeAdapter auto-confirms → 1,000,000 units minted
// ============================================================================

import { toNano, Address } from '@ton/core';
import {
    TonstableMinter,
    SetBridgeAdapter,
    PriceUpdate,
    DepositTon,
} from '../build/TonstableMinter/TonstableMinter_TonstableMinter';
import { MockBridgeAdapter, Deploy as AdapterDeploy } from '../build/MockBridgeAdapter/MockBridgeAdapter_MockBridgeAdapter';
import { NetworkProvider } from '@ton/blueprint';

// ─── known addresses ──────────────────────────────────────────────────────────
const MINTER_ADDRESS = Address.parse('EQDDp5bjnJuNP1Au2G5tRfvoBXxM7JP6VzLI6mXN_PTsODpC');

// ─── oracle price ─────────────────────────────────────────────────────────────
// $100,000 per TON — same as the initial PriceUpdate from the previous attempt.
// Re-using the same value means the 50 % deviation check always passes
// regardless of whether that first update was applied or not.
// PRICE_DECIMALS = 100_000_000 (i.e. $1 = 100_000_000 price units).
const ORACLE_PRICE = 100_000n * 100_000_000n; // = 10_000_000_000_000

// ─── ceiling-check verification (actualLusd = 1_000_000, deposit = 2.5 TON) ─
//   fee      = max(30 bps of 2.5 TON, feeFloor 0.5 TON) = 0.5 TON
//   net      = 2.0 TON = 2_000_000_000 nanoTON
//   usdValue = (2e9 × 10_000_000_000_000) / 1e9 = 20_000_000_000_000
//   check    : 1_000_000 × 100 = 1e8  ≤  20e12 × 1.1 = 22e12  ✓  (trivial)
//   Wallet balance ~3.5 TON: 2.5 deposit + 0.15 gas headroom fits fine.

export async function run(provider: NetworkProvider) {
    const minter  = provider.open(TonstableMinter.fromAddress(MINTER_ADDRESS));
    const sender  = provider.sender();
    const nowSec  = BigInt(Math.floor(Date.now() / 1000));

    // ── 1. Deploy MockBridgeAdapter ───────────────────────────────────────────
    const adapter = provider.open(await MockBridgeAdapter.fromInit(MINTER_ADDRESS));
    const adapterAddr = adapter.address;

    if (await provider.isContractDeployed(adapterAddr)) {
        console.log('MockBridgeAdapter already deployed at', adapterAddr.toString());
    } else {
        console.log('1/4  Deploying MockBridgeAdapter...');
        await adapter.send(
            sender,
            { value: toNano('0.05') },
            { $$type: 'Deploy', queryId: 0n } satisfies AdapterDeploy,
        );
        await provider.waitForDeploy(adapterAddr);
        console.log('     Deployed at', adapterAddr.toString());
    }

    // ── 2. Point Minter's bridgeAdapter at MockBridgeAdapter ─────────────────
    console.log('2/4  Updating bridgeAdapter →', adapterAddr.toString());
    await minter.send(
        sender,
        { value: toNano('0.05') },
        { $$type: 'SetBridgeAdapter', newAdapter: adapterAddr } satisfies SetBridgeAdapter,
    );

    // ── 3. Refresh the oracle price (required: age ≤ oracleMaxStaleness 300 s) ─
    console.log('3/4  Refreshing oracle price at $100,000 / TON...');
    await minter.send(
        sender,
        { value: toNano('0.05') },
        {
            $$type:    'PriceUpdate',
            price:     ORACLE_PRICE,
            timestamp: BigInt(Math.floor(Date.now() / 1000)), // fresh timestamp
        } satisfies PriceUpdate,
    );

    // ── 4. Deposit TON — triggers the auto-confirmed mint ─────────────────────
    // MockBridgeAdapter receives BridgeMintRequest and replies with
    // MintConfirmation(actualLusd = 1_000_000) in the same block.
    // No manual confirmation step needed.
    console.log('4/4  Depositing 2.5 TON to trigger mint...');
    await minter.send(
        sender,
        { value: toNano('2.5') },
        {
            $$type:        'DepositTon',
            minTonstblOut: 1_000_000n,
            deadline:      BigInt(Math.floor(Date.now() / 1000)) + 3600n,
        } satisfies DepositTon,
    );

    // The mint is complete once the Minter processes the MintConfirmation
    // that MockBridgeAdapter sent back in the same message chain.
    console.log('\n✓  Mint triggered successfully!');
    console.log('   actualLusd credited : 1,000,000 raw units');
    console.log('   MockBridgeAdapter   :', adapterAddr.toString());
    console.log('   JettonWallet        : EQA9EcFP5ZaQGSjPna0Uujf_Yqi1qiVZszfeDTMOkaJQuH_b');
    console.log('   Minter              :', MINTER_ADDRESS.toString());
    console.log('\n   Allow ~30 s for inner messages to settle, then check:');
    console.log('   https://testnet.tonscan.org/address/kQA9EcFP5ZaQGSjPna0Uujf_Yqi1qiVZszfeDTMOkaJQuMRR');
}
