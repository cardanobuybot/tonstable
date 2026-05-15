// ============================================================================
//  oracleKeeper.ts  —  Production oracle keeper for TonstableMinter
//
//  Fetches TON/USD spot price and submits PriceUpdate on a configurable
//  interval, keeping the on-chain oracle fresh within oracleMaxStaleness
//  (default 300 s in the contract).
//
//  Usage:
//    npx ts-node scripts/oracleKeeper.ts
//
//  Required env vars (.env):
//    WALLET_MNEMONIC   BIP-39 mnemonic of the oracleKeeper wallet
//    WALLET_VERSION    v5r1 | v4r2 | v3r2 | v4  (default: v5r1)
//    MINTER_ADDRESS    TonstableMinter contract address
//
//  Optional env vars:
//    TON_ENDPOINT      RPC URL (default: https://toncenter.com/api/v2/jsonRPC)
//    TONCENTER_API_KEY toncenter.com API key for higher rate limits
//    UPDATE_INTERVAL   seconds between price pushes (default: 120)
//    MAX_DEVIATION_PCT refuse to submit if price moves >N% since last push
//                      (default: 45 — just below the contract's 50% hard limit)
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { Address, beginCell, SendMode, internal, toNano } from '@ton/core';
import {
    TonClient,
    WalletContractV5R1,
    WalletContractV4,
    WalletContractV3R2,
} from '@ton/ton';
import { mnemonicToPrivateKey } from '@ton/crypto';

// ─── price scale ─────────────────────────────────────────────────────────────
// Must match PRICE_DECIMALS in tonstable_minter.tact
const PRICE_DECIMALS = 100_000_000n;

// ─── load .env ───────────────────────────────────────────────────────────────
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

// ─── price fetch helpers ──────────────────────────────────────────────────────

function httpsGet(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'tonstable-oracle/1.0' } }, (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => resolve(data));
        }).on('error', reject);
    });
}

async function fetchPriceFromBinance(): Promise<number> {
    const raw = await httpsGet('https://api.binance.com/api/v3/ticker/price?symbol=TONUSDT');
    const { price } = JSON.parse(raw) as { price: string };
    const usd = parseFloat(price);
    if (!isFinite(usd) || usd <= 0) throw new Error(`Binance: bad price "${price}"`);
    return usd;
}

async function fetchPriceFromCoinGecko(): Promise<number> {
    const raw = await httpsGet(
        'https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd',
    );
    const data = JSON.parse(raw) as { 'the-open-network'?: { usd?: number } };
    const usd = data['the-open-network']?.usd;
    if (typeof usd !== 'number' || usd <= 0) throw new Error('CoinGecko: bad price');
    return usd;
}

// Try Binance first (no rate limit for single-symbol ticker), fall back to CoinGecko
async function fetchTonUsd(): Promise<number> {
    try {
        return await fetchPriceFromBinance();
    } catch (primaryErr) {
        console.warn('[oracle] Binance failed, trying CoinGecko:', (primaryErr as Error).message);
        return fetchPriceFromCoinGecko();
    }
}

// ─── wallet factory ───────────────────────────────────────────────────────────

function makeWallet(version: string, publicKey: Buffer) {
    switch (version.toLowerCase()) {
        case 'v5r1':
            return WalletContractV5R1.create({ publicKey, workchain: 0 });
        case 'v4':
        case 'v4r2':
            return WalletContractV4.create({ publicKey, workchain: 0 });
        case 'v3r2':
            return WalletContractV3R2.create({ publicKey, workchain: 0 });
        default:
            throw new Error(`Unsupported wallet version: ${version}. Use v5r1, v4r2, or v3r2`);
    }
}

// ─── main loop ────────────────────────────────────────────────────────────────

async function main() {
    const env = { ...loadEnv(), ...process.env };

    const mnemonic     = env['WALLET_MNEMONIC'];
    const walletVer    = env['WALLET_VERSION']    ?? 'v5r1';
    const minterRaw    = env['MINTER_ADDRESS'];
    const endpoint     = env['TON_ENDPOINT']      ?? 'https://toncenter.com/api/v2/jsonRPC';
    const apiKey       = env['TONCENTER_API_KEY'];
    const intervalSec  = parseInt(env['UPDATE_INTERVAL']    ?? '120', 10);
    const maxDevPct    = parseInt(env['MAX_DEVIATION_PCT']  ?? '45',  10);

    if (!mnemonic)   throw new Error('WALLET_MNEMONIC not set in .env');
    if (!minterRaw)  throw new Error('MINTER_ADDRESS not set in .env');

    const minterAddress = Address.parse(minterRaw);
    const keyPair       = await mnemonicToPrivateKey(mnemonic.split(' '));
    const wallet        = makeWallet(walletVer, keyPair.publicKey);

    const clientOptions: ConstructorParameters<typeof TonClient>[0] = { endpoint };
    if (apiKey) (clientOptions as any).apiKey = apiKey;
    const client = new TonClient(clientOptions);

    const walletProvider = client.open(wallet);

    console.log(`[oracle] keeper started`);
    console.log(`[oracle] wallet  : ${wallet.address.toString()}`);
    console.log(`[oracle] minter  : ${minterAddress.toString()}`);
    console.log(`[oracle] endpoint: ${endpoint}`);
    console.log(`[oracle] interval: ${intervalSec}s  max-deviation: ${maxDevPct}%`);

    let lastSubmittedPrice = 0n;   // 0 means "not yet submitted" — contract skips deviation check
    let consecutiveErrors  = 0;

    while (true) {
        try {
            // ── fetch price ──────────────────────────────────────────────────
            const usdFloat = await fetchTonUsd();
            const newPrice = BigInt(Math.round(usdFloat * Number(PRICE_DECIMALS)));

            // ── local deviation guard (mirrors the contract's 50% check) ─────
            if (lastSubmittedPrice > 0n) {
                const delta   = newPrice > lastSubmittedPrice
                    ? newPrice - lastSubmittedPrice
                    : lastSubmittedPrice - newPrice;
                const maxDelta = (lastSubmittedPrice * BigInt(maxDevPct)) / 100n;
                if (delta > maxDelta) {
                    console.warn(
                        `[oracle] SKIP — price moved ${(Number(delta) / Number(lastSubmittedPrice) * 100).toFixed(1)}%` +
                        ` (>${maxDevPct}% local guard). New: $${usdFloat.toFixed(4)},` +
                        ` last: $${(Number(lastSubmittedPrice) / Number(PRICE_DECIMALS)).toFixed(4)}`,
                    );
                    await sleep(intervalSec * 1000);
                    continue;
                }
            }

            const timestamp = BigInt(Math.floor(Date.now() / 1000));

            // ── build PriceUpdate message body ───────────────────────────────
            // op=0x544E5320  price:uint128  timestamp:uint64
            const body = beginCell()
                .storeUint(0x544E5320, 32)
                .storeUint(newPrice, 128)
                .storeUint(timestamp, 64)
                .endCell();

            // ── get seqno and send ────────────────────────────────────────────
            const seqno = await walletProvider.getSeqno();

            await walletProvider.sendTransfer({
                seqno,
                secretKey: keyPair.secretKey,
                sendMode: SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS,
                messages: [
                    internal({
                        to:    minterAddress,
                        value: toNano('0.02'),
                        body,
                    }),
                ],
            });

            lastSubmittedPrice = newPrice;
            consecutiveErrors  = 0;

            console.log(
                `[oracle] PriceUpdate sent — $${usdFloat.toFixed(4)} (raw ${newPrice})` +
                `  seqno=${seqno}  ts=${timestamp}`,
            );

        } catch (err) {
            consecutiveErrors++;
            console.error(`[oracle] error (attempt ${consecutiveErrors}):`, (err as Error).message);

            // Back off exponentially, capping at 5× the normal interval
            const backoff = Math.min(intervalSec * 5, intervalSec * 2 ** (consecutiveErrors - 1));
            console.warn(`[oracle] backing off ${backoff}s before retry`);
            await sleep(backoff * 1000);
            continue;
        }

        await sleep(intervalSec * 1000);
    }
}

function sleep(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
    console.error('[oracle] fatal:', err);
    process.exit(1);
});
