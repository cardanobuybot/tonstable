import { Blockchain, SandboxContract, TreasuryContract, SendMessageResult } from '@ton/sandbox';
import { Address, Cell, toNano } from '@ton/core';
import { getCompiledCode } from '@layerzerolabs/lz-ton-sdk-v2';
import { TonstableOApp } from '../wrappers/TonstableOApp';
import '@ton/test-utils';

// LayerZero EID for Arbitrum Sepolia (interface.fc ARBITRUM_SEPOLIA_EID).
const ARB_SEPOLIA_EID = 40231;
// Arb Vault, right-aligned in uint256 (same value sendSetPeer uses on testnet).
const ARB_VAULT = BigInt('0xAc997b1723b497Aa7694D4a402Dd34943df81B20');
// OPCODES.Endpoint_OP_ENDPOINT_SEND — the op the OApp uses on its outbound msg to the endpoint.
const ENDPOINT_OP_ENDPOINT_SEND = 3712918452;

// ── cl object navigation (funC++/classlib.fc header layout) ─────────────────
// Field info is packed into the object header; we re-derive clGetCellRef here
// rather than calling the SDK's, which bundles @ton/core@0.59 (version gap).
const BASIC_HEADER_WIDTH = 80; // 8 * MAX_NAME_LEN(10)
const FIELD_TYPE_WIDTH = 4;
const CELL_ID_WIDTH = 2;
const DATA_OFFSET_WIDTH = 10;
const REF_OFFSET_WIDTH = 2;
const FIELD_INFO_WIDTH = FIELD_TYPE_WIDTH + CELL_ID_WIDTH + DATA_OFFSET_WIDTH + REF_OFFSET_WIDTH;

// Field indices (classes/msgdata/LzSend.fc, classes/lz/Packet.fc).
const LZSEND_PACKET = 4;
const PACKET_MESSAGE = 1;

function clGetCellRef(obj: Cell, fieldName: number): Cell {
    const info = obj.beginParse();
    info.skip(BASIC_HEADER_WIDTH + fieldName * FIELD_INFO_WIDTH + FIELD_TYPE_WIDTH);
    const fieldCellIndex = info.loadUint(CELL_ID_WIDTH);
    info.loadUint(DATA_OFFSET_WIDTH); // data offset — unused for ref fields
    const fieldRefIdx = info.loadUint(REF_OFFSET_WIDTH);

    const walk = obj.beginParse();
    if (fieldCellIndex === 0) {
        for (let i = 0; i < fieldRefIdx; i++) walk.loadRef();
        return walk.loadRef();
    }
    for (let i = 0; i < fieldCellIndex; i++) walk.loadRef();
    const inner = walk.loadRef().beginParse();
    for (let i = 0; i < fieldRefIdx; i++) inner.loadRef();
    return inner.loadRef();
}

// BytesEncoder (protocol/msglibs/BytesEncoder.fc) packs byte-aligned data, up to
// 127 bytes/cell, chained via ref[0]. Walk the chain and concatenate raw bytes.
function readBytes(head: Cell): Buffer {
    const parts: Buffer[] = [];
    let cur: Cell | null = head;
    while (cur) {
        const s = cur.beginParse();
        const nbytes = s.remainingBits >> 3;
        if (nbytes > 0) parts.push(s.loadBuffer(nbytes));
        cur = cur.refs.length > 0 ? cur.refs[0] : null;
    }
    return Buffer.concat(parts);
}

// Slice the byte stream into n big-endian 32-byte ABI words.
function readSlots(head: Cell, n: number): bigint[] {
    const buf = readBytes(head);
    const out: bigint[] = [];
    for (let i = 0; i < n; i++) {
        const w = buf.subarray(i * 32, (i + 1) * 32);
        out.push(w.length > 0 ? BigInt('0x' + w.toString('hex')) : 0n);
    }
    return out;
}

// Locate the OApp's outbound ENDPOINT_SEND message and descend
// $lzSendMd → packet → message to recover the ABI-encoded lzMessage cell.
function extractLzMessage(result: SendMessageResult, oapp: Address): Cell {
    for (const tx of result.transactions) {
        for (const out of tx.outMessages.values()) {
            if (out.info.type !== 'internal') continue;
            if (!out.info.src.equals(oapp)) continue;
            const bs = out.body.beginParse();
            if (bs.remainingBits < 32) continue;
            if (bs.loadUint(32) !== ENDPOINT_OP_ENDPOINT_SEND) continue;
            // body: op | query | coins | originStd | ref $lzSendMd  → single ref.
            const lzSendMd = out.body.refs[0];
            const packet = clGetCellRef(lzSendMd, LZSEND_PACKET);
            return clGetCellRef(packet, PACKET_MESSAGE);
        }
    }
    throw new Error('No ENDPOINT_SEND message emitted by the OApp');
}

describe('TonstableOApp — outbound ABI encoder', () => {
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let minterSender: SandboxContract<TreasuryContract>;
    let user: SandboxContract<TreasuryContract>;
    let oapp: SandboxContract<TonstableOApp>;

    // 256-bit hash part of the userTon address — what parseStdAddress yields on-chain.
    function userTonHash(): bigint {
        return BigInt('0x' + user.address.hash.toString('hex'));
    }

    beforeEach(async () => {
        blockchain = await Blockchain.create();

        deployer = await blockchain.treasury('deployer');
        minterSender = await blockchain.treasury('minterSender');
        user = await blockchain.treasury('user');

        // Offline prebuilt artifacts (no network); same path as deployTonstableOApp.ts.
        const endpointCode = getCompiledCode('Endpoint') as unknown as Cell;
        const channelCode = getCompiledCode('Channel') as unknown as Cell;

        oapp = blockchain.openContract(
            await TonstableOApp.createFromConfig(
                { owner: deployer.address, endpointCode, channelCode },
            ),
        );

        await oapp.sendDeploy(deployer.getSender(), toNano('0.5'));
        await oapp.sendInitialize(deployer.getSender(), toNano('0.1'));
        // _lzSend requires the peer to be set, else ERROR::PeerNotSet. One peer covers both tests.
        await oapp.sendSetPeer(deployer.getSender(), {
            value: toNano('0.1'),
            dstEid: ARB_SEPOLIA_EID,
            peer: ARB_VAULT,
        });
    });

    it('encodes BridgeRedeemRequest (msgType 2 → 7 ABI slots)', async () => {
        const nonce = 7n;
        const tonstblBurned = 5_000_000n;
        const deadline = 1_700_003_600n;

        const result = await oapp.sendBridgeRedeemRequest(minterSender.getSender(), {
            value: toNano('1'),
            nonce,
            userTon: user.address,
            tonstblBurned,
            deadline,
        });

        expect(result.transactions).toHaveTransaction({
            from: minterSender.address,
            to: oapp.address,
            success: true,
        });

        const slots = readSlots(extractLzMessage(result, oapp.address), 7);
        expect(slots[0]).toBe(2n); // msgType
        expect(slots[1]).toBe(0x40n); // bytes offset
        expect(slots[2]).toBe(0x80n); // bytes length (4 inner words)
        expect(slots[3]).toBe(nonce);
        expect(slots[4]).toBe(userTonHash());
        expect(slots[5]).toBe(tonstblBurned);
        expect(slots[6]).toBe(deadline);
    });

    it('encodes BridgeMintRequest (msgType 1 → 8 ABI slots)', async () => {
        const nonce = 3n;
        const usdValue = 12_000_000n;
        const minLusdOut = 11_500_000n;
        const deadline = 1_700_007_200n;

        const result = await oapp.sendBridgeMintRequest(minterSender.getSender(), {
            value: toNano('1'),
            nonce,
            userTon: user.address,
            usdValue,
            minLusdOut,
            deadline,
        });

        expect(result.transactions).toHaveTransaction({
            from: minterSender.address,
            to: oapp.address,
            success: true,
        });

        const slots = readSlots(extractLzMessage(result, oapp.address), 8);
        expect(slots[0]).toBe(1n); // msgType
        expect(slots[1]).toBe(0x40n); // bytes offset
        expect(slots[2]).toBe(0xa0n); // bytes length (5 inner words)
        expect(slots[3]).toBe(nonce);
        expect(slots[4]).toBe(userTonHash());
        expect(slots[5]).toBe(usdValue);
        expect(slots[6]).toBe(minLusdOut);
        expect(slots[7]).toBe(deadline);
    });
});
