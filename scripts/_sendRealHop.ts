/**
 * Standalone _realHop sender — bypasses toncenter (HTTP 500).
 * Sends PriceUpdate + DepositTon to Minter via tonapi.io testnet.
 */
import { Address, beginCell, toNano, external, storeMessage } from '@ton/core';
import { WalletContractV5R1 } from '@ton/ton';
import { mnemonicToPrivateKey } from '@ton/crypto';
import * as https from 'https';

const MNEMONIC       = process.env.WALLET_MNEMONIC!;
const MINTER_ADDR    = 'EQA31yC0LEgeshdze-eFQntYknWsFkZfYKPpIAi0XbGIhPKi';
const ORACLE_PRICE   = 190_000_000n;
const WORKCHAIN      = 0;
const TONAPI_BASE    = 'https://testnet.tonapi.io/v2';

async function tonapiGet(path: string): Promise<any> {
    return new Promise((resolve, reject) => {
        https.get(TONAPI_BASE + path, { headers: { accept: 'application/json' } }, (res) => {
            let data = '';
            res.on('data', (c) => data += c);
            res.on('end', () => resolve(JSON.parse(data)));
        }).on('error', reject);
    });
}

async function tonapiPost(path: string, body: object): Promise<any> {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const url = new URL(TONAPI_BASE + path);
        const req = https.request({
            hostname: url.hostname, path: url.pathname, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'accept': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        }, (res) => {
            let data = '';
            res.on('data', (c) => data += c);
            res.on('end', () => {
                if (!data.trim()) resolve({ statusCode: res.statusCode, ok: true });
                else { try { resolve(JSON.parse(data)); } catch { resolve({ raw: data }); } }
            });
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

async function getSeqno(addrRaw: string): Promise<number> {
    const r = await tonapiGet(`/blockchain/accounts/${addrRaw}/methods/seqno`);
    return parseInt(r.decoded?.state ?? r.stack?.[0]?.num ?? '0');
}

async function sendTx(wallet: ReturnType<typeof WalletContractV5R1.create>, secretKey: Buffer, seqno: number, to: Address, value: bigint, body: any) {
    const { internal } = await import('@ton/core');
    const transfer = await wallet.createTransfer({
        seqno,
        secretKey,
        sendMode: 3,
        messages: [internal({ to, value, bounce: true, body })],
    } as any);
    const extMsg = external({ to: wallet.address, body: transfer });
    const boc = beginCell().store(storeMessage(extMsg)).endCell().toBoc().toString('base64');
    console.log('  BOC (first 64):', boc.substring(0, 64));
    const result = await tonapiPost('/blockchain/message', { boc });
    if ((result as any).error) throw new Error('Broadcast failed: ' + (result as any).error);
    console.log('  ✅ sent (HTTP', (result as any).statusCode ?? 200, ')');
}

async function main() {
    if (!MNEMONIC) throw new Error('WALLET_MNEMONIC not set');
    const keyPair = await mnemonicToPrivateKey(MNEMONIC.split(' '));
    const wallet = WalletContractV5R1.create({
        publicKey: keyPair.publicKey,
        walletId: { networkGlobalId: -3, context: { workchain: WORKCHAIN, subwalletNumber: 0, walletVersion: 'v5r1' as const } },
    });
    console.log('Wallet:', wallet.address.toString({ testOnly: true, bounceable: false }));

    const minterAddr = Address.parse(MINTER_ADDR);

    // ── Step 1: PriceUpdate ──────────────────────────────────────────────────
    const seqno1 = await getSeqno(wallet.address.toRawString());
    console.log('seqno:', seqno1);
    const ts = BigInt(Math.floor(Date.now() / 1000));
    const priceUpdateBody = beginCell()
        .storeUint(1414419232, 32)  // PriceUpdate opcode
        .storeUint(ORACLE_PRICE, 128)
        .storeUint(ts, 64)
        .endCell();
    console.log('[1/2] PriceUpdate price=$1.90 ts=' + ts);
    await sendTx(wallet, keyPair.secretKey, seqno1, minterAddr, toNano('0.05'), priceUpdateBody);
    console.log('  Waiting 22s for oracle state...');
    await new Promise(r => setTimeout(r, 22_000));

    // ── Step 2: DepositTon ───────────────────────────────────────────────────
    const seqno2 = await getSeqno(wallet.address.toRawString());
    console.log('seqno:', seqno2);
    const deadline = BigInt(Math.floor(Date.now() / 1000)) + 3600n;
    const depositBody = beginCell()
        .storeUint(1414419201, 32)  // DepositTon opcode
        .storeUint(1n, 128)         // minTonstblOut = 1
        .storeUint(deadline, 64)
        .endCell();
    console.log('[2/2] DepositTon value=3 TON deadline+3600s');
    await sendTx(wallet, keyPair.secretKey, seqno2, minterAddr, toNano('3'), depositBody);

    console.log('\n✓ DepositTon sent. Cross-chain delivery takes 2-5 min.');
    console.log('Monitor Minter:   https://testnet.tonviewer.com/' + MINTER_ADDR);
    console.log('Monitor OApp:     https://testnet.tonviewer.com/EQA2SPLtbQGkijeadXNHdhO3swGIJCBK_4LhFcJBHKV6_9BK');
    console.log('Monitor Vault:    https://sepolia.arbiscan.io/address/0xAc997b1723b497Aa7694D4a402Dd34943df81B20');
}

main().catch((e) => { console.error(e); process.exit(1); });
