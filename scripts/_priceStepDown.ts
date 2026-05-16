// One-shot: steps the on-chain oracle price down from an unrealistic test value
// to the current market price, 49% reduction per step (stays within contract's 50% guard).
// Run once, then restart oracleKeeper.ts.
//
// Usage: npx ts-node scripts/_priceStepDown.ts

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { Address, beginCell, SendMode, internal, toNano } from '@ton/core';
import { TonClient, WalletContractV5R1 } from '@ton/ton';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { TonstableMinter } from '../build/TonstableMinter/TonstableMinter_TonstableMinter';

const MINTER_ADDR  = Address.parse('EQAYNaqE6fdlxo2giEWWQU3QDHyxdN4atT9ixf8fAAy4XWth');
const PRICE_DECIMALS = 100_000_000n;
const STEP_FACTOR    = 0.51; // 49% reduction — just inside the 50% on-chain guard

function loadEnv(): Record<string, string> {
    const envPath = path.resolve(__dirname, '..', '.env');
    if (!fs.existsSync(envPath)) return {};
    const env: Record<string, string> = {};
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
        const m = line.match(/^\s*([A-Z_][A-Z_0-9]*)="?([^"#]*)"?\s*$/);
        if (m) env[m[1]] = m[2].trim();
    }
    return env;
}

function httpsGet(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'tonstable/1.0' } }, res => {
            let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
        }).on('error', reject);
    });
}

async function fetchRealPrice(): Promise<number> {
    const raw = await httpsGet('https://api.binance.com/api/v3/ticker/price?symbol=TONUSDT');
    const usd = parseFloat((JSON.parse(raw) as { price: string }).price);
    if (!isFinite(usd) || usd <= 0) throw new Error('bad price from Binance');
    return usd;
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
    const env = { ...loadEnv(), ...process.env };
    const mnemonic = env['WALLET_MNEMONIC'];
    const apiKey   = env['TONCENTER_API_KEY'];
    if (!mnemonic) throw new Error('WALLET_MNEMONIC not set');

    const keyPair = await mnemonicToPrivateKey(mnemonic.split(' '));
    const wallet  = WalletContractV5R1.create({
        publicKey: keyPair.publicKey,
        walletId: {
            networkGlobalId: -3,
            context: { workchain: 0, subwalletNumber: 0, walletVersion: 'v5r1' },
        },
    });

    const clientOpts: any = { endpoint: 'https://testnet.toncenter.com/api/v2/jsonRPC' };
    if (apiKey) clientOpts.apiKey = apiKey;
    const client       = new TonClient(clientOpts);
    const walletProv   = client.open(wallet) as any;
    const minterProv   = client.open(TonstableMinter.fromAddress(MINTER_ADDR));

    // ── fetch current on-chain price ──────────────────────────────────────────
    const minterData  = await minterProv.getGetJettonData();
    // cachedTonUsdPrice is not in jettonData — get it via getContractState approach:
    // We stored it via PriceUpdate, so let's read it from the minter getter
    let currentRaw: bigint;
    try {
        currentRaw = await (minterProv as any).getCachedTonUsdPrice();
    } catch {
        // fallback: assume the known test value
        currentRaw = 100_000n * PRICE_DECIMALS;
        console.log('getCachedTonUsdPrice not exposed — assuming $100,000 start price');
    }

    const realUsd   = await fetchRealPrice();
    const targetRaw = BigInt(Math.round(realUsd * Number(PRICE_DECIMALS)));

    console.log(`On-chain price : $${(Number(currentRaw) / Number(PRICE_DECIMALS)).toFixed(4)}`);
    console.log(`Real TON/USD   : $${realUsd.toFixed(4)}`);
    console.log(`Target raw     : ${targetRaw}`);

    if (currentRaw <= targetRaw * 15n / 10n) {
        console.log('Price already close enough — no step-down needed.');
        return;
    }

    // ── calculate steps ───────────────────────────────────────────────────────
    // We step down by STEP_FACTOR each time until we're within 50% of target.
    const steps: bigint[] = [];
    let p = Number(currentRaw);
    while (true) {
        p = p * STEP_FACTOR;
        const pBig = BigInt(Math.round(p));
        steps.push(pBig);
        const deviation = Math.abs(Number(pBig) - Number(targetRaw)) / Number(targetRaw);
        if (deviation <= 0.49) break; // one more oracle update can close the gap
        if (steps.length > 30) { console.error('Too many steps needed — check start price'); process.exit(1); }
    }

    console.log(`\nNeed ${steps.length} step(s) to reach $${realUsd.toFixed(4)}:\n`);
    steps.forEach((s, i) =>
        console.log(`  step ${i + 1}: $${(Number(s) / Number(PRICE_DECIMALS)).toFixed(4)}  (raw ${s})`),
    );

    // ── send each step ────────────────────────────────────────────────────────
    let lastTs = 0n;
    for (let i = 0; i < steps.length; i++) {
        const price = steps[i];
        const timestamp = BigInt(Math.floor(Date.now() / 1000));
        if (timestamp <= lastTs) {
            // ensure each update has a strictly newer timestamp
            await sleep(1100);
        }
        lastTs = BigInt(Math.floor(Date.now() / 1000));

        const seqno = await walletProv.getSeqno();
        console.log(`\n[step ${i + 1}/${steps.length}]  $${(Number(price) / Number(PRICE_DECIMALS)).toFixed(4)}  seqno=${seqno}`);

        await walletProv.sendTransfer({
            seqno,
            secretKey: keyPair.secretKey,
            sendMode: SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS,
            messages: [internal({
                to:    MINTER_ADDR,
                value: toNano('0.02'),
                body:  beginCell()
                    .storeUint(0x544E5320, 32)
                    .storeUint(price, 128)
                    .storeUint(lastTs, 64)
                    .endCell(),
            })],
        });

        // wait for seqno to advance before next step
        for (let w = 0; w < 20; w++) {
            await sleep(3000);
            const cur = await walletProv.getSeqno();
            if (cur > seqno) { console.log(`  confirmed (seqno ${seqno} → ${cur})`); break; }
            if (w === 19) console.warn('  WARNING: seqno stuck — continuing anyway');
        }
    }

    console.log(`\nStep-down complete. On-chain price now ≈ $${(Number(steps[steps.length - 1]) / Number(PRICE_DECIMALS)).toFixed(4)}`);
    console.log('Now start the oracle keeper — it will close the remaining gap:');
    console.log('  npx ts-node scripts/oracleKeeper.ts');
}

main().catch(console.error);
