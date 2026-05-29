/**
 * Step 13 — Override Channel's sendMsglibConnection per-OApp via OP_SetLzConfig.
 *
 * Why: Channel routes to 0:9a78f45c (old code, UNINIT). We need it to use
 * 0:e8d2432c (new code, ACTIVE+INITIALIZED). Endpoint msglibs dict already has
 * UlnManager → new code; passing UlnManager as sendMsglibManager triggers
 * Endpoint to resolve 0:e8d2432c and write it into Channel.epConfigOApp.
 *
 * Message flow: OApp → Endpoint::SET_EP_CONFIG_OAPP(MdObj{SetEpConfig, path})
 *   → _getEpConfigFromManagerAddresses (dict lookup, no UlnManager query)
 *   → Channel::SET_EP_CONFIG_OAPP(resolvedEpConfig)
 *   → Channel stores epConfigOApp.sendMsglibConnection = 0:e8d2432c
 *
 * Uses tonapi.io (toncenter is HTTP 500).
 */
import { Address, Cell, beginCell, toNano, internal, external, storeMessage } from '@ton/core';
import { WalletContractV5R1 } from '@ton/ton';
import { mnemonicToPrivateKey } from '@ton/crypto';
import * as https from 'https';
import {
    OPCODES,
    clDeclare,
    asciiStringToBigint,
    cl,
    addressToBigInt,
} from '@layerzerolabs/lz-ton-sdk-v2';

const MNEMONIC      = process.env.WALLET_MNEMONIC!;
const OAPP_ADDR        = 'EQA2SPLtbQGkijeadXNHdhO3swGIJCBK_4LhFcJBHKV6_9BK';
const CONTROLLER_ADDR  = 'EQAYlRK0qV4D1VqN7kl8NN3ghmO8xDgoGO84LLe3zfetaogF';
const ULN_MANAGER      = 'EQC0tTlvumGHvKzMHPODV7ARp3DLIV4P_zXeZ-SQ7MO0kCMC';
const VAULT_PADDED     = BigInt('0x000000000000000000000000Ac997b1723b497Aa7694D4a402Dd34943df81B20');

const TON_EID  = 40343n;
const ARB_EID  = 40231n;

// Controller::OP::SET_EP_CONFIG_OAPP — permission: caller must be srcOApp in path
// Flow: OApp → Controller → Endpoint → Channel
const Controller_OP_SET_EP_CONFIG_OAPP = 172926131n;

const TONAPI_BASE = 'https://testnet.tonapi.io/v2';
const WORKCHAIN   = 0;

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

    const words = MNEMONIC.split(' ');
    const keyPair = await mnemonicToPrivateKey(words);
    const wallet = WalletContractV5R1.create({
        publicKey: keyPair.publicKey,
        walletId: {
            networkGlobalId: -3,
            context: { workchain: WORKCHAIN, subwalletNumber: 0, walletVersion: 'v5r1' as const },
        },
    });
    const walletAddr = wallet.address.toString({ testOnly: true, bounceable: false });
    console.log('Wallet:', walletAddr);

    const addrRaw = wallet.address.toRawString();
    const seqnoRes = await tonapiGet(`/blockchain/accounts/${addrRaw}/methods/seqno`);
    const seqno = parseInt(seqnoRes.decoded?.state ?? seqnoRes.stack?.[0]?.num ?? '0');
    console.log('seqno:', seqno);

    // ── lz::Path (srcEid=TON, srcOApp=OApp, dstEid=ARB, dstOApp=Vault) ────────
    const oappInt = addressToBigInt(OAPP_ADDR);
    const path = clDeclare(asciiStringToBigint('path'), [
        { type: cl.t.uint32,   value: TON_EID },
        { type: cl.t.address,  value: oappInt },
        { type: cl.t.uint32,   value: ARB_EID },
        { type: cl.t.address,  value: VAULT_PADDED },
    ]);

    // ── md::SetEpConfig ────────────────────────────────────────────────────────
    // useDefaults=0 → isNull=false in resulting EpConfig → OApp override IS used
    // sendMsglibManager=UlnManager → Endpoint looks up NEW connCode → resolves 0:e8d2432c
    // receiveMsglibManager=0=NULLADDRESS → no receive override
    // timeoutReceiveMsglibManager=0=NULLADDRESS → no timeout override
    const ulnManagerInt = addressToBigInt(ULN_MANAGER);
    const setEpConfig = clDeclare(asciiStringToBigint('SetEpCfg'), [
        { type: cl.t.bool,    value: 0n },            // useDefaults = false
        { type: cl.t.address, value: ulnManagerInt }, // sendMsglibManager → NEW code
        { type: cl.t.address, value: 0n },            // receiveMsglibManager = NULLADDRESS
        { type: cl.t.address, value: 0n },            // timeoutReceiveMsglibManager = NULLADDRESS
        { type: cl.t.uint64,  value: 0n },            // timeoutReceiveMsglibExpiry
    ]);

    // ── lz::Config ─────────────────────────────────────────────────────────────
    // forwardingAddress = Controller (not Endpoint):
    //   Endpoint::SET_EP_CONFIG_OAPP requires caller=Controller (assertOwner)
    //   Controller::SET_EP_CONFIG_OAPP requires caller=srcOApp (= us) ✓
    const controllerInt = addressToBigInt(CONTROLLER_ADDR);
    const lzConfig = clDeclare(asciiStringToBigint('Config'), [
        { type: cl.t.objRef,  value: path },
        { type: cl.t.address, value: controllerInt },
        { type: cl.t.uint32,  value: Controller_OP_SET_EP_CONFIG_OAPP },
        { type: cl.t.objRef,  value: setEpConfig },
    ]);

    const lzConfigCell = Cell.fromBoc(
        (lzConfig as unknown as { toBoc(): Buffer }).toBoc()
    )[0];

    const OP_SET_LZ_CONFIG = Number(OPCODES.OP_SetLzConfig);
    const msgBody = beginCell()
        .storeUint(OP_SET_LZ_CONFIG, 32)
        .storeUint(0n, 64)
        .storeCoins(0n)
        .storeRef(lzConfigCell)
        .endCell();

    console.log('op: 0x' + OP_SET_LZ_CONFIG.toString(16), '(=', OP_SET_LZ_CONFIG, ')');
    console.log('forwardingAddress → Controller: 0x' + controllerInt.toString(16).slice(-16) + '...');
    console.log('opCode: Controller_OP_SET_EP_CONFIG_OAPP =', Controller_OP_SET_EP_CONFIG_OAPP.toString());
    console.log('body bits:', msgBody.bits.length, 'refs:', msgBody.refs.length);
    console.log('lzConfig cell bits:', lzConfigCell.bits.length, 'refs:', lzConfigCell.refs.length);

    const transfer = wallet.createTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        sendMode: 3,
        messages: [
            internal({
                to: Address.parse(OAPP_ADDR),
                value: toNano('0.3'),
                bounce: true,
                body: msgBody,
            }),
        ],
    });

    const extMsg = external({ to: wallet.address, body: transfer });
    const boc = beginCell().store(storeMessage(extMsg)).endCell().toBoc().toString('base64');
    console.log('\nBOC (first 64 chars):', boc.substring(0, 64));
    console.log('Sending to tonapi.io...');

    const result = await tonapiPost('/blockchain/message', { boc });
    console.log('\ntonapi response:', JSON.stringify(result, null, 2));

    if ((result as any).error) {
        console.error('\n❌ Broadcast failed:', (result as any).error);
        process.exit(1);
    }
    console.log('\n✅ Transaction sent! Monitor:');
    console.log('  OApp:       https://testnet.tonviewer.com/' + OAPP_ADDR);
    console.log('  Controller: https://testnet.tonviewer.com/' + CONTROLLER_ADDR);
    console.log('  Channel:    https://testnet.tonviewer.com/0:445b4a01f30cc68de147f8d99a6d9c2d498637b1c229c279546e90b56572817b');
}

main().catch((e) => { console.error(e); process.exit(1); });
