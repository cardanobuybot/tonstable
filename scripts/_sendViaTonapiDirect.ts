/**
 * Standalone sender for deployUlnConnection — bypasses toncenter (HTTP 500).
 * Uses tonapi.io testnet for seqno + BOC broadcast.
 */
import { Address, Cell, beginCell, toNano, internal, external, storeMessage } from '@ton/core';
import { WalletContractV5R1 } from '@ton/ton';
import { mnemonicToPrivateKey } from '@ton/crypto';
import * as https from 'https';
import {
    OPCODES,
    clDeclare,
    asciiStringToBigint,
    emptyCell,
    cl,
    addressToBigInt,
} from '@layerzerolabs/lz-ton-sdk-v2';

const MNEMONIC       = process.env.WALLET_MNEMONIC!;
const OAPP_ADDR      = 'EQA2SPLtbQGkijeadXNHdhO3swGIJCBK_4LhFcJBHKV6_9BK';
const ULN_MANAGER    = 'EQC0tTlvumGHvKzMHPODV7ARp3DLIV4P_zXeZ-SQ7MO0kCMC';
const VAULT_PADDED   = BigInt('0x000000000000000000000000Ac997b1723b497Aa7694D4a402Dd34943df81B20');
const DST_EID        = 40231n;
const INITIAL_DEPOSIT = 300_000_000n;
const TONAPI_BASE    = 'https://testnet.tonapi.io/v2';
const WORKCHAIN      = 0;

async function tonapiGet(path: string): Promise<any> {
    return new Promise((resolve, reject) => {
        const url = TONAPI_BASE + path;
        https.get(url, { headers: { accept: 'application/json' } }, (res) => {
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
        const options = {
            hostname: url.hostname,
            path: url.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'accept': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
            },
        };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (c) => data += c);
            res.on('end', () => {
                if (!data.trim()) {
                    resolve({ statusCode: res.statusCode, ok: true });
                } else {
                    try { resolve(JSON.parse(data)); } catch { resolve({ raw: data }); }
                }
            });
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

async function main() {
    if (!MNEMONIC) throw new Error('WALLET_MNEMONIC not set');

    // ── 1. Derive keypair ────────────────────────────────────────────────────
    const words = MNEMONIC.split(' ');
    const keyPair = await mnemonicToPrivateKey(words);
    const wallet = WalletContractV5R1.create({
        publicKey: keyPair.publicKey,
        walletId: {
            networkGlobalId: -3, // testnet
            context: {
                workchain: WORKCHAIN,
                subwalletNumber: 0,
                walletVersion: 'v5r1' as const,
            },
        },
    });
    const walletAddr = wallet.address.toString({ testOnly: true, bounceable: false });
    console.log('Wallet:', walletAddr);

    // ── 2. Get seqno via tonapi ──────────────────────────────────────────────
    const addrRaw = wallet.address.toRawString();
    const seqnoRes = await tonapiGet(`/blockchain/accounts/${addrRaw}/methods/seqno`);
    const seqno = parseInt(seqnoRes.decoded?.state ?? seqnoRes.stack?.[0]?.num ?? '0');
    console.log('seqno:', seqno);

    // ── 3. Build message body (same as deployUlnConnection.ts) ───────────────
    const NIL_ADDRESS = 2n ** 256n - 1n;
    const ulnSendConfig = clDeclare(asciiStringToBigint('UlnSendCfg'), [
        { type: cl.t.uint32,  value: 0n },
        { type: cl.t.uint32,  value: 0n },
        { type: cl.t.bool,    value: 1n },
        { type: cl.t.address, value: NIL_ADDRESS },
        { type: cl.t.bool,    value: 1n },
        { type: cl.t.objRef,  value: emptyCell() },
        { type: cl.t.bool,    value: 1n },
        { type: cl.t.objRef,  value: emptyCell() },
        { type: cl.t.bool,    value: 1n },
        { type: cl.t.uint64,  value: 0n },
    ]);
    const ulnReceiveConfig = clDeclare(asciiStringToBigint('UlnRecvCfg'), [
        { type: cl.t.bool,    value: 1n },
        { type: cl.t.uint32,  value: 0n },
        { type: cl.t.bool,    value: 1n },
        { type: cl.t.uint64,  value: 0n },
        { type: cl.t.bool,    value: 1n },
        { type: cl.t.objRef,  value: emptyCell() },
        { type: cl.t.bool,    value: 1n },
        { type: cl.t.objRef,  value: emptyCell() },
        { type: cl.t.uint8,   value: 0n },
    ]);
    const initUlnConnection = clDeclare(asciiStringToBigint('initUlnCon'), [
        { type: cl.t.objRef,  value: ulnSendConfig },
        { type: cl.t.objRef,  value: ulnReceiveConfig },
        { type: cl.t.address, value: 0n },
        { type: cl.t.address, value: 0n },
    ]);

    const mdDeployRaw = clDeclare(asciiStringToBigint('deploy'), [
        { type: cl.t.coins,   value: INITIAL_DEPOSIT },
        { type: cl.t.uint32,  value: DST_EID },
        { type: cl.t.uint256, value: VAULT_PADDED },
        { type: cl.t.objRef,  value: initUlnConnection },
    ]);
    const ulnManagerInt = addressToBigInt(ULN_MANAGER);
    const mdMdAddressRaw = clDeclare(asciiStringToBigint('MdAddr'), [
        { type: cl.t.objRef,  value: mdDeployRaw },
        { type: cl.t.address, value: ulnManagerInt },
    ]);
    const mdMdAddressCell = Cell.fromBoc(
        (mdMdAddressRaw as unknown as { toBoc(): Buffer }).toBoc()
    )[0];

    const OP_DEPLOY_CONNECTION = Number(OPCODES.OP_DeployConnection);
    const msgBody = beginCell()
        .storeUint(OP_DEPLOY_CONNECTION, 32)
        .storeUint(0n, 64)
        .storeCoins(0n)
        .storeRef(mdMdAddressCell)
        .endCell();

    console.log('op: 0x' + OP_DEPLOY_CONNECTION.toString(16));
    console.log('body bits:', msgBody.bits.length, 'refs:', msgBody.refs.length);

    // ── 4. Build and sign external tx ────────────────────────────────────────
    const transfer = wallet.createTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        sendMode: 3,
        messages: [
            internal({
                to: Address.parse(OAPP_ADDR),
                value: toNano('0.65'),
                bounce: true,
                body: msgBody,
            }),
        ],
    });

    // Wrap signed transfer body in an external-in message envelope
    const extMsg = external({ to: wallet.address, body: transfer });
    const boc = beginCell().store(storeMessage(extMsg)).endCell().toBoc().toString('base64');
    console.log('\nBOC (first 64 chars):', boc.substring(0, 64));
    console.log('Sending to tonapi.io...');

    // ── 5. Broadcast ─────────────────────────────────────────────────────────
    const result = await tonapiPost('/blockchain/message', { boc });
    console.log('\ntonapi response:', JSON.stringify(result, null, 2));

    if ((result as any).error) {
        console.error('\n❌ Broadcast failed:', (result as any).error);
        process.exit(1);
    }
    console.log('\n✅ Transaction sent! Monitor:');
    console.log('  OApp: https://testnet.tonviewer.com/' + OAPP_ADDR);
    console.log('  Target: https://testnet.tonviewer.com/0:9a78f45c1aabdfd836a792c2604985f770354262a6804953600ec285d7bfe145');
}

main().catch((e) => { console.error(e); process.exit(1); });
