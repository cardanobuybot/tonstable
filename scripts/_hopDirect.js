// @ts-nocheck
/**
 * Bypass toncenter (broken) — use tonapi.io for seqno + broadcast.
 * Sends PriceUpdate then DepositTon to Minter via V5R1 wallet (testnet globalId=-3).
 */
const { WalletContractV5R1, SendMode } = require('@ton/ton');
const { mnemonicToPrivateKey } = require('@ton/crypto');
const { beginCell, toNano, Address, internal, external, storeMessage } = require('@ton/core');
const https = require('https');
const dotenv = require('dotenv');
dotenv.config();

const MINTER = Address.parse('EQA31yC0LEgeshdze-eFQntYknWsFkZfYKPpIAi0XbGIhPKi');
const ORACLE_PRICE = 190_000_000n;
const TONAPI_BASE  = 'https://testnet.tonapi.io/v2';
const WALLET_ADDR  = 'EQAvWnxIIxiQ73MrKzI9_zQCxinF1yO5G7WZ1s7_Yo7lbyEg';

function httpsPost(url, body) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const u = new URL(url);
        const req = https.request({
            hostname: u.hostname, port: 443, path: u.pathname + u.search,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        }, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
                catch(e) { resolve({ status: res.statusCode, body: d }); }
            });
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

function httpsGet(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { Accept: 'application/json' } }, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
                catch(e) { resolve({ status: res.statusCode, body: d }); }
            });
        }).on('error', reject);
    });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getSeqno(walletAddrFriendly) {
    const url = TONAPI_BASE + '/wallet/' + encodeURIComponent(walletAddrFriendly) + '/seqno';
    const r = await httpsGet(url);
    if (r.status !== 200) throw new Error('seqno fetch failed: ' + JSON.stringify(r.body));
    return r.body.seqno;
}

async function broadcast(bocBase64) {
    const r = await httpsPost(TONAPI_BASE + '/blockchain/message', { boc: bocBase64 });
    return r;
}

async function main() {
    const mnemonic = process.env.WALLET_MNEMONIC;
    if (!mnemonic) throw new Error('WALLET_MNEMONIC not set');

    const keys = await mnemonicToPrivateKey(mnemonic.split(' '));
    const wallet = WalletContractV5R1.create({
        publicKey: keys.publicKey,
        walletId: {
            networkGlobalId: -3,  // testnet
            context: { workchain: 0, subwalletNumber: 0, walletVersion: 'v5r1' },
        },
    });

    console.log('Wallet:', wallet.address.toString({ testOnly: true, bounceable: false }));
    console.log('Match :', wallet.address.toString({ testOnly: true, bounceable: false }) ===
        '0QAvWnxIIxiQ73MrKzI9_zQCxinF1yO5G7WZ1s7_Yo7lb8dv' ? '✅' : '❌ WRONG');

    // ── Step 1: PriceUpdate ──────────────────────────────────────────────────
    const priceTimestamp = BigInt(Math.floor(Date.now() / 1000));
    const priceUpdateBody = beginCell()
        .storeUint(1414419232, 32)   // PriceUpdate op
        .storeUint(ORACLE_PRICE, 128)
        .storeUint(priceTimestamp, 64)
        .endCell();

    console.log('\n[1/2] PriceUpdate  price=190000000  timestamp=' + priceTimestamp);
    let seqno = await getSeqno(WALLET_ADDR);
    console.log('seqno:', seqno);

    const priceBody = wallet.createTransfer({
        seqno,
        secretKey: keys.secretKey,
        sendMode: SendMode.PAY_GAS_SEPARATELY,
        timeout: Math.floor(Date.now() / 1000) + 3600,
        messages: [internal({
            to: MINTER,
            value: toNano('0.05'),
            bounce: true,
            body: priceUpdateBody,
        })],
    });
    const priceExt = external({ to: wallet.address, body: priceBody });
    const priceBoc = beginCell().store(storeMessage(priceExt)).endCell().toBoc().toString('base64');
    const priceResult = await broadcast(priceBoc);
    console.log('Broadcast status:', priceResult.status);
    console.log('Response:', JSON.stringify(priceResult.body).slice(0, 200));

    if (priceResult.status !== 200) {
        throw new Error('PriceUpdate broadcast failed: ' + JSON.stringify(priceResult.body));
    }
    console.log('PriceUpdate sent. Waiting 22s...');
    await sleep(22_000);

    // ── Step 2: DepositTon ────────────────────────────────────────────────────
    const depositDeadline = BigInt(Math.floor(Date.now() / 1000)) + 3600n;
    const depositBody = beginCell()
        .storeUint(1414419201, 32)   // DepositTon op
        .storeUint(1n, 128)          // minTonstblOut = 1
        .storeUint(depositDeadline, 64)
        .endCell();

    console.log('\n[2/2] DepositTon  value=3 TON  deadline=' + depositDeadline);
    seqno = await getSeqno(WALLET_ADDR);
    console.log('seqno:', seqno);

    const depositBodyCell = wallet.createTransfer({
        seqno,
        secretKey: keys.secretKey,
        sendMode: SendMode.PAY_GAS_SEPARATELY,
        timeout: Math.floor(Date.now() / 1000) + 3600,
        messages: [internal({
            to: MINTER,
            value: toNano('3'),
            bounce: true,
            body: depositBody,
        })],
    });
    const depositExt = external({ to: wallet.address, body: depositBodyCell });
    const depositBoc = beginCell().store(storeMessage(depositExt)).endCell().toBoc().toString('base64');
    const depositResult = await broadcast(depositBoc);
    console.log('Broadcast status:', depositResult.status);
    console.log('Response:', JSON.stringify(depositResult.body).slice(0, 200));

    if (depositResult.status !== 200) {
        throw new Error('DepositTon broadcast failed: ' + JSON.stringify(depositResult.body));
    }

    console.log('\n✅ DepositTon sent! Monitor cross-chain delivery (2-5 min):');
    console.log('  Minter: https://testnet.tonviewer.com/EQA31yC0LEgeshdze-eFQntYknWsFkZfYKPpIAi0XbGIhPKi');
    console.log('  OApp  : https://testnet.tonviewer.com/EQA2SPLtbQGkijeadXNHdhO3swGIJCBK_4LhFcJBHKV6_9BK');
    console.log('  Vault : https://sepolia.arbiscan.io/address/0xAc997b1723b497Aa7694D4a402Dd34943df81B20');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
