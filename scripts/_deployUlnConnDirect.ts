/**
 * Direct manual deployment of ULN Connection at 0:9a78f45c...
 *
 * Background: Endpoint stores a different ulnConnectionCode (from older UlnManager registration)
 * than what UlnManager currently has in its storage. This means:
 *   - Endpoint computes sendMsglibConnection using OLD code → address 0:9a78f45c...
 *   - UlnManager deploys using CURRENT code → address 0:e8d2432c...
 *
 * Fix: extract OLD code + initStorage from Endpoint, manually deploy to 0:9a78f45c...
 * then send INITIALIZE with correct endpoint/channel addresses.
 */
import { Address, beginCell, toNano, external, storeMessage, Cell, internal } from '@ton/core';
import { WalletContractV5R1 } from '@ton/ton';
import { mnemonicToPrivateKey } from '@ton/crypto';
import * as https from 'https';
import {
    clDeclare,
    asciiStringToBigint,
    emptyCell,
    cl,
} from '@layerzerolabs/lz-ton-sdk-v2';

const MNEMONIC = process.env.WALLET_MNEMONIC!;
const WORKCHAIN = 0;
const TONAPI_BASE = 'https://testnet.tonapi.io/v2';

// Known addresses (hashparts)
const ENDPOINT_ADDR = '0:c54d322c2ce2ccc5f78ca6479a631e54218f1165c3a80c0ad005fa9367b1fee9';
const CHANNEL_ADDR  = '0:445b4a01f30cc68de147f8d99a6d9c2d498637b1c229c279546e90b56572817b';
const ULN_CONN_ADDR = '0:9a78f45c1aabdfd836a792c2604985f770354262a6804953600ec285d7bfe145';

const ENDPOINT_HASH = BigInt('0xc54d322c2ce2ccc5f78ca6479a631e54218f1165c3a80c0ad005fa9367b1fee9');
const CHANNEL_HASH  = BigInt('0x445b4a01f30cc68de147f8d99a6d9c2d498637b1c229c279546e90b56572817b');

// OApp path for the connection
const OAPP_HASH     = BigInt('0x3648f2ed6d01a48a379a7573477613b7b3018824204aff82e115c2411ca57aff');
const VAULT_PADDED  = BigInt('0x000000000000000000000000Ac997b1723b497Aa7694D4a402Dd34943df81B20');
const DST_EID       = 40231n;

// INITIALIZE opcode (BaseInterface::OP::INITIALIZE)
const OP_INITIALIZE = 0xf65ce988;
// MsglibConnection::OP::MSGLIB_CONNECTION_SEND
const PathFieldIdx = 1; // MsglibConnection::PathFieldIdx

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

// Build md::InitUlnConnection with all-null configs + real endpoint/channel addresses
function buildInitUlnConnection(endpointAddress: bigint, channelAddress: bigint): any {
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
    return clDeclare(asciiStringToBigint('initUlnCon'), [
        { type: cl.t.objRef,  value: ulnSendConfig },
        { type: cl.t.objRef,  value: ulnReceiveConfig },
        { type: cl.t.address, value: endpointAddress },
        { type: cl.t.address, value: channelAddress },
    ]);
}

async function main() {
    if (!MNEMONIC) throw new Error('WALLET_MNEMONIC not set');
    const keyPair = await mnemonicToPrivateKey(MNEMONIC.split(' '));
    const wallet = WalletContractV5R1.create({
        publicKey: keyPair.publicKey,
        walletId: { networkGlobalId: -3, context: { workchain: WORKCHAIN, subwalletNumber: 0, walletVersion: 'v5r1' as const } },
    });
    console.log('Wallet:', wallet.address.toString({ testOnly: true, bounceable: false }));

    // ── 1. Get Endpoint storage to extract the OLD msglibConnectionCode ───────
    console.log('\n=== Extracting code from Endpoint storage ===');
    const epAcc = await tonapiGet(`/blockchain/accounts/EQDFTTIsLOLMxfeMpkeaYx5UIY8RZcOoDArQBfqTZ7H-6Ybs`);
    const epCells = Cell.fromBoc(Buffer.from(epAcc.data, 'hex'));
    const epRoot = epCells[0];

    // Field 8 (defaultSendLibInfo): cellId=2, refIdx=2
    const containerCell = epRoot.refs[2];
    const defaultSendLibInfo = containerCell.refs[2];
    console.log('defaultSendLibInfo: bits=', defaultSendLibInfo.bits.length, 'refs=', defaultSendLibInfo.refs.length);

    const msglibConnectionCode = defaultSendLibInfo.refs[0];
    const msglibConnectionInitStorageBase = defaultSendLibInfo.refs[1];
    console.log('msglibConnectionCode hash:', msglibConnectionCode.hash().toString('hex'));
    console.log('msglibConnectionInitStorage hash:', msglibConnectionInitStorageBase.hash().toString('hex'));

    // ── 2. Build actual path cell: lz::Path::New(srcEid=40343, srcOApp=OAPP_HASH, dstEid, dstOApp) ──
    const actualPath = clDeclare(asciiStringToBigint('path'), [
        { type: cl.t.uint32,  value: 40343n },     // srcEid (TON testnet)
        { type: cl.t.address, value: OAPP_HASH },   // srcOApp
        { type: cl.t.uint32,  value: DST_EID },     // dstEid (Arb Sepolia)
        { type: cl.t.address, value: VAULT_PADDED }, // dstOApp (Vault)
    ]);
    const actualPathCell = Cell.fromBoc((actualPath as any).toBoc())[0];
    console.log('\nactualPath cell: bits=', actualPathCell.bits.length, 'refs=', actualPathCell.refs.length);

    // ── 3. Replace path field in initStorage (cl::set field 1) ──────────────
    // cl::set(PathFieldIdx=1, actualPath) on msglibConnectionInitStorageBase
    // We need to use the SDK or manual cell manipulation to do this
    //
    // Since msglibConnectionInitStorageBase is a UlnConnection::New cell,
    // we use the classlib cl::set logic to replace field 1 (path)

    // Simplified approach: read field 1 info from header and replace
    const initStorageSlice = msglibConnectionInitStorageBase.beginParse();
    const fieldInfoOffset = 80 + 1 * 18; // field 1 info at offset 80+18 bits

    // Read field 1 info
    const headerS = msglibConnectionInitStorageBase.beginParse();
    headerS.skip(80 + 1 * 18); // skip name + field0 info
    const field1Type = headerS.loadUint(4);  // should be 9 (objRef)
    const field1Cell = headerS.loadUint(2);  // cell index
    headerS.loadUint(10); // offset (unused for refs)
    const field1Ref = headerS.loadUint(2);   // ref index
    console.log(`\nField 1 (path): type=${field1Type} cellId=${field1Cell} refIdx=${field1Ref}`);

    // Replace ref[field1Ref] in the appropriate cell with actualPathCell
    // For simplicity since field1Cell=0 and field1Ref should be 1 (second ref)
    // Let's manually verify by checking the current path cell
    if (field1Cell === 0) {
        // Path is in root cell at ref[field1Ref]
        const currentPath = msglibConnectionInitStorageBase.refs[field1Ref];
        console.log('Current path cell hash:', currentPath.hash().toString('hex'));
        console.log('Current path cell bits:', currentPath.bits.length);
    }

    // Build new init storage by replacing field 1 (path ref)
    // We rebuild the root cell with the new path ref
    // Root cell: same bits, same other refs, but ref[field1Ref] = actualPathCell
    const initStorageBits = msglibConnectionInitStorageBase.bits;
    const newStorageBuilder = beginCell();

    // Store all bits from original
    // This is the bits of the classlib-encoded cell
    newStorageBuilder.storeBits(initStorageBits);

    // Store refs, replacing ref[field1Ref] with actualPathCell
    for (let i = 0; i < msglibConnectionInitStorageBase.refs.length; i++) {
        if (i === field1Ref) {
            newStorageBuilder.storeRef(actualPathCell);
        } else {
            newStorageBuilder.storeRef(msglibConnectionInitStorageBase.refs[i]);
        }
    }

    const newInitStorage = newStorageBuilder.endCell();
    console.log('\nNew initStorage hash:', newInitStorage.hash().toString('hex'));

    // ── 4. Compute expected ULN Connection address ────────────────────────────
    const stateInitCell = beginCell()
        .storeUint(6, 5)  // has code + data
        .storeRef(msglibConnectionCode)
        .storeRef(newInitStorage)
        .endCell();
    const computedAddr = '0:' + stateInitCell.hash().toString('hex');
    console.log('\nComputed ULN Connection address:', computedAddr);
    console.log('Expected ULN Connection address:', ULN_CONN_ADDR);

    if (computedAddr !== ULN_CONN_ADDR) {
        console.error('❌ Address mismatch! Path replacement produced wrong address.');
        console.log('Investigating...');

        // Maybe field1Ref is different - let me try all ref positions
        for (let tryRef = 0; tryRef < msglibConnectionInitStorageBase.refs.length; tryRef++) {
            const b = beginCell();
            b.storeBits(initStorageBits);
            for (let i = 0; i < msglibConnectionInitStorageBase.refs.length; i++) {
                b.storeRef(i === tryRef ? actualPathCell : msglibConnectionInitStorageBase.refs[i]);
            }
            const si = beginCell().storeUint(6,5).storeRef(msglibConnectionCode).storeRef(b.endCell()).endCell();
            const addr = '0:' + si.hash().toString('hex');
            console.log(`  tryRef=${tryRef}: ${addr} ${addr === ULN_CONN_ADDR ? '✅ MATCH' : ''}`);
        }
        return;
    }

    console.log('✅ Address matches! Proceeding with deployment...');

    // ── 5. Build INITIALIZE message for ULN Connection ───────────────────────
    const initUlnConnRaw = buildInitUlnConnection(ENDPOINT_HASH, CHANNEL_HASH);
    const initUlnConnCell = Cell.fromBoc((initUlnConnRaw as any).toBoc())[0];

    // INITIALIZE body format (from buildLayerzeroMessageBody):
    // op(32) | query_id(64) | donation_coins | origin_addr(267) | ref(initUlnConnection)
    // For simple direct deployment, we use minimal format the ULN Connection expects
    const initBody = beginCell()
        .storeUint(OP_INITIALIZE, 32)
        .storeUint(0n, 64)           // query_id
        .storeCoins(0n)              // donation
        .storeBits(Buffer.from('800000000000000000000000000000000000000000000000000000000000000000', 'hex').slice(0, 34)) // addr_none (267 bits)
        .storeRef(initUlnConnCell)
        .endCell();

    // ── 6. Send deployment transaction with StateInit ─────────────────────────
    const seqno = await getSeqno(wallet.address.toRawString());
    console.log('seqno:', seqno);

    const deployAddr = Address.parseRaw(ULN_CONN_ADDR);

    const transfer = wallet.createTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        sendMode: 3,
        messages: [
            internal({
                to: deployAddr,
                value: toNano('0.35'),
                bounce: false,
                init: {
                    code: msglibConnectionCode,
                    data: newInitStorage,
                },
                body: initBody,
            }),
        ],
    } as any);

    const extMsg = external({ to: wallet.address, body: transfer });
    const boc = beginCell().store(storeMessage(extMsg)).endCell().toBoc().toString('base64');
    console.log('\nSending deployment to', ULN_CONN_ADDR);
    console.log('BOC (first 64):', boc.substring(0, 64));

    const result = await tonapiPost('/blockchain/message', { boc });
    if ((result as any).error) throw new Error('Broadcast failed: ' + (result as any).error);
    console.log('✅ Sent!', JSON.stringify(result));

    console.log('\nWaiting 15s for deployment...');
    await new Promise(r => setTimeout(r, 15_000));

    const acc = await tonapiGet(`/accounts/${ULN_CONN_ADDR}`);
    console.log('ULN_CONN status:', acc.status, 'balance:', acc.balance);
}

main().catch((e) => { console.error(e); process.exit(1); });
