// Standalone testnet mint runner — no blueprint interactive prompt needed.
// Reads WALLET_MNEMONIC / WALLET_VERSION / TONCENTER_API_KEY from .env.
//
// 4-step flow:
//   1. Deploy MockBridgeAdapter (idempotent)
//   2. SetBridgeAdapter on Minter
//   3. PriceUpdate (fresh oracle timestamp)
//   4. DepositTon → auto-confirmed mint
//
// Usage:  npx ts-node scripts/_runMint.ts

import * as fs from 'fs';
import * as path from 'path';
import { Address, beginCell, SendMode, internal, toNano, contractAddress, Cell, storeStateInit } from '@ton/core';
import {
    TonClient,
    WalletContractV5R1,
    WalletContractV4,
    WalletContractV3R2,
} from '@ton/ton';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { MockBridgeAdapter } from '../build/MockBridgeAdapter/MockBridgeAdapter_MockBridgeAdapter';
import { TonstableJettonWallet } from '../build/TonstableJettonWallet/TonstableJettonWallet_TonstableJettonWallet';

// ── config ────────────────────────────────────────────────────────────────────

const MINTER_ADDR  = Address.parse('EQAYNaqE6fdlxo2giEWWQU3QDHyxdN4atT9ixf8fAAy4XWth');
const ORACLE_PRICE = 100_000n * 100_000_000n; // $100,000/TON × 1e8 decimals

// ── helpers ───────────────────────────────────────────────────────────────────

function loadEnv(): Record<string, string> {
    const envPath = path.resolve(__dirname, '..', '.env');
    if (!fs.existsSync(envPath)) return {};
    const env: Record<string, string> = {};
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
        const m = line.match(/^\s*([A-Z_][A-Z_0-9]*)="?([^"]*)"?\s*$/);
        if (m) env[m[1]] = m[2];
    }
    return env;
}

function makeWallet(version: string, publicKey: Buffer) {
    switch (version.toLowerCase()) {
        case 'v5r1':
        case 'w5':
            // Blueprint uses networkGlobalId=-3 for testnet — must match or the address differs.
            return WalletContractV5R1.create({
                publicKey,
                walletId: {
                    networkGlobalId: -3, // testnet
                    context: { workchain: 0, subwalletNumber: 0, walletVersion: 'v5r1' },
                },
            });
        case 'v4':
        case 'v4r2': return WalletContractV4.create({ publicKey, workchain: 0 });
        case 'v3r2': return WalletContractV3R2.create({ publicKey, workchain: 0 });
        default: throw new Error(`Unsupported wallet version: ${version}`);
    }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// Retry any async fn on 429 with exponential backoff.
async function withRetry<T>(fn: () => Promise<T>, label = ''): Promise<T> {
    for (let attempt = 0; attempt < 8; attempt++) {
        try {
            return await fn();
        } catch (e: any) {
            const is429 = e?.response?.status === 429 || e?.message?.includes('429') || e?.code === 'ERR_BAD_REQUEST';
            if (!is429 || attempt === 7) throw e;
            const delay = Math.min(2000 * 2 ** attempt, 30_000);
            console.log(`  [rate-limit] ${label} — retry in ${delay / 1000}s (attempt ${attempt + 1}/8)`);
            await sleep(delay);
        }
    }
    throw new Error('unreachable');
}

async function getSeqnoWithRetry(walletProvider: any): Promise<number> {
    return withRetry(() => walletProvider.getSeqno(), 'getSeqno');
}

// Send a message and wait for seqno to advance. Retries on rate-limit.
async function sendAndWait(
    client: TonClient,
    walletProvider: any,
    keyPair: { secretKey: Buffer },
    to: Address,
    value: bigint,
    body: Cell,
    label: string,
    init?: { code: Cell; data: Cell },
) {
    const seqno = await getSeqnoWithRetry(walletProvider);
    console.log(`  seqno=${seqno}  →  ${label}`);

    await withRetry(() => walletProvider.sendTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        sendMode: SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS,
        messages: [internal({ to, value, body, init })],
    }), `send:${label}`);

    // Poll for seqno advance
    for (let i = 0; i < 40; i++) {
        await sleep(3000);
        try {
            const cur = await getSeqnoWithRetry(walletProvider);
            if (cur > seqno) { console.log(`  confirmed (seqno ${seqno} → ${cur})`); return; }
        } catch { /* rate-limit during poll — keep waiting */ }
    }
    console.warn('  WARNING: seqno did not advance after 120 s');
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
    const env = { ...loadEnv(), ...process.env };

    const mnemonic  = env['WALLET_MNEMONIC'];
    const walletVer = env['WALLET_VERSION'] ?? 'v5r1';
    const apiKey    = env['TONCENTER_API_KEY'];
    if (!mnemonic) throw new Error('WALLET_MNEMONIC not set in .env');

    if (!apiKey) {
        console.warn('WARNING: no TONCENTER_API_KEY — rate limits will slow things down.');
        console.warn('  Get a free testnet key: Telegram @tonapibot → /testnet → /get_api_key');
        console.warn('  Then add TONCENTER_API_KEY=<key> to .env\n');
    }

    const keyPair = await mnemonicToPrivateKey(mnemonic.split(' '));
    const wallet  = makeWallet(walletVer, keyPair.publicKey);

    const clientOpts: any = { endpoint: 'https://testnet.toncenter.com/api/v2/jsonRPC' };
    if (apiKey) clientOpts.apiKey = apiKey;
    const client = new TonClient(clientOpts);

    const walletProvider = client.open(wallet) as any;
    const senderAddr     = wallet.address;

    console.log('Wallet  :', senderAddr.toString());
    console.log('Minter  :', MINTER_ADDR.toString());

    // ── 1. MockBridgeAdapter: deploy if needed ────────────────────────────────
    const adapterInit = await MockBridgeAdapter.init(MINTER_ADDR);
    const adapterAddr = contractAddress(0, adapterInit);
    console.log('\n[1/4] MockBridgeAdapter:', adapterAddr.toString());

    const adapterState = await withRetry(() => client.getContractState(adapterAddr), 'getAdapterState');
    if (adapterState.state === 'active') {
        console.log('  already deployed — skip');
    } else {
        console.log('  deploying...');
        await sendAndWait(
            client,
            walletProvider,
            keyPair,
            adapterAddr,
            toNano('0.05'),
            beginCell().storeUint(0x946a98b6, 32).storeUint(0, 64).endCell(), // Deploy op + queryId
            'deploy MockBridgeAdapter',
            adapterInit,
        );
        // Verify it landed
        for (let i = 0; i < 20; i++) {
            await sleep(3000);
            const s = await withRetry(() => client.getContractState(adapterAddr), 'checkAdapter');
            if (s.state === 'active') { console.log('  active on-chain'); break; }
            if (i === 19) console.warn('  WARNING: adapter still not active');
        }
    }

    // ── 2. SetBridgeAdapter ───────────────────────────────────────────────────
    console.log('\n[2/4] SetBridgeAdapter →', adapterAddr.toString());
    await sendAndWait(
        client,
        walletProvider,
        keyPair,
        MINTER_ADDR,
        toNano('0.05'),
        // op=0xb83cc066 (ABI header=3090989158) + Address
        beginCell().storeUint(0xb83cc066, 32).storeAddress(adapterAddr).endCell(),
        'SetBridgeAdapter',
    );

    // ── 3. PriceUpdate ────────────────────────────────────────────────────────
    console.log('\n[3/4] PriceUpdate  price=$100,000/TON');
    const timestamp = BigInt(Math.floor(Date.now() / 1000));
    await sendAndWait(
        client,
        walletProvider,
        keyPair,
        MINTER_ADDR,
        toNano('0.02'),
        beginCell()
            .storeUint(0x544E5320, 32)   // PriceUpdate op
            .storeUint(ORACLE_PRICE, 128)
            .storeUint(timestamp, 64)
            .endCell(),
        'PriceUpdate',
    );

    console.log('  waiting 10 s for oracle price to land on-chain...');
    await sleep(10_000);

    // ── 4. DepositTon ─────────────────────────────────────────────────────────
    console.log('\n[4/4] DepositTon 2.0 TON → mint ~1,000,000 TONSTBL units');
    const deadline = BigInt(Math.floor(Date.now() / 1000)) + 3600n;
    await sendAndWait(
        client,
        walletProvider,
        keyPair,
        MINTER_ADDR,
        toNano('2.0'),
        beginCell()
            .storeUint(0x544E5301, 32)   // DepositTon op
            .storeUint(1_000_000n, 128)  // minTonstblOut
            .storeUint(deadline, 64)     // deadline
            .endCell(),
        'DepositTon',
    );

    const walletInit = await TonstableJettonWallet.init(senderAddr, MINTER_ADDR);
    const walletAddr = contractAddress(0, walletInit);

    console.log('\nMint triggered!');
    console.log('  JettonWallet  :', walletAddr.toString());
    console.log('  Allow ~30 s for inner messages to settle, then verify:');
    console.log('  npx ts-node scripts/_diagnose.ts');
}

main().catch(console.error);
