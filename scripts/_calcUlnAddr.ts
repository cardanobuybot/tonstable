/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Offline computation of predicted ULN Connection address.
 * Getters (_calculateUlnConnectionAddress etc.) are impure inline method_id —
 * NOT externally callable. We compute the address from first principles:
 *   StateInit = { code: ulnConnectionCode, data: UlnConnection::New(...) }
 *   address   = contractAddress(0, StateInit)
 */
import { TonClient } from '@ton/ton';
import { Address, Cell, contractAddress as tonContractAddress } from '@ton/core';
import {
    addressToBigInt,
    buildClass,
    baseBuildClass,
    clGetCellRef,
    initBaseStorage,
    emptyCell,
    emptyMap,
    emptyPOOO,
    clDeclare,
    asciiStringToBigint,
    cl,
} from '@layerzerolabs/lz-ton-sdk-v2';

const ULN_MANAGER = 'EQC0tTlvumGHvKzMHPODV7ARp3DLIV4P_zXeZ-SQ7MO0kCMC';
const OAPP_ADDR   = 'EQA2SPLtbQGkijeadXNHdhO3swGIJCBK_4LhFcJBHKV6_9BK';
const ULN_40231   = 'EQCaoxMQ3rv1HIJXXM9vhbQxA8dZ0FNAmW1R1-YzWGDGDqyT';
const VAULT_PADDED = BigInt('0x000000000000000000000000Ac997b1723b497Aa7694D4a402Dd34943df81B20');
const SRC_EID = 40343n;
const DST_EID = 40231n;
const NULLADDRESS = 0n;

/** Convert SDK internal cell (may have different @ton/core) to project Cell via BOC */
function toProjectCell(sdkCell: any): Cell {
    const boc: Buffer = sdkCell.toBoc ? sdkCell.toBoc() : Buffer.from(sdkCell.toBoc?.() ?? sdkCell.hash());
    // If already a @ton/core Cell, it has .bits — just return it
    if (sdkCell.bits !== undefined) return sdkCell as Cell;
    return Cell.fromBoc(boc)[0];
}

async function main() {
    const client = new TonClient({
        endpoint: 'https://testnet.toncenter.com/api/v2/jsonRPC',
        apiKey: process.env.TONCENTER_API_KEY,
    });

    // ── 1. Get UlnManager storage ────────────────────────────────────────────
    const ulmAddr = Address.parse(ULN_MANAGER);
    const ulmState = await client.getContractState(ulmAddr);
    if (!ulmState.data) { console.error('UlnManager: no data'); process.exit(1); }
    const ulmStorage = Cell.fromBoc(ulmState.data)[0];
    console.log('UlnManager state:', ulmState.state);

    // ── 2. Extract ulnConnectionCode (field index 2) ─────────────────────────
    // clGetCellRef uses the header field info to navigate refs
    const ulnConnectionCode = (clGetCellRef as any)(ulmStorage, 2) as Cell;
    console.log('ulnConnectionCode bits:', ulnConnectionCode.bits.length,
        'refs:', ulnConnectionCode.refs.length);

    // ── 3. Build lz::Path cell ────────────────────────────────────────────────
    const oappInt = addressToBigInt(OAPP_ADDR);
    const pathRaw = clDeclare(asciiStringToBigint('path'), [
        { type: cl.t.uint32,  value: SRC_EID },
        { type: cl.t.address, value: oappInt },
        { type: cl.t.uint32,  value: DST_EID },
        { type: cl.t.address, value: VAULT_PADDED },
    ]);
    const pathCell = Cell.fromBoc((pathRaw as any).toBoc())[0];
    console.log('Path cell bits:', pathCell.bits.length, 'refs:', pathCell.refs.length);

    // ── 4. Build UlnConnection init data ─────────────────────────────────────
    const ulnManagerInt = addressToBigInt(ULN_MANAGER);
    const uln40231Int   = addressToBigInt(ULN_40231);

    // buildClass handles tonObjects (UlnConnection, UlnSendConfig, etc.)
    const initData = (buildClass as any)('UlnConnection', {
        baseStorage:          initBaseStorage(ulnManagerInt),
        path:                 pathCell,
        endpointAddress:      NULLADDRESS,
        channelAddress:       NULLADDRESS,
        firstUnexecutedNonce: 1n,
        ulnAddress:           uln40231Int,
        UlnSendConfigOApp:    (buildClass as any)('UlnSendConfig::NewWithDefaults', {}),
        UlnReceiveConfigOApp: (buildClass as any)('UlnReceiveConfig::NewWithDefaults', {}),
        hashLookups:          emptyMap(),
        commitPOOO:           (emptyPOOO as any)(),
    }) as Cell;
    console.log('UlnConnection initData bits:', initData.bits.length, 'refs:', initData.refs.length);

    // ── 5. Compute contract address ────────────────────────────────────────────
    const stateInit = { code: ulnConnectionCode, data: initData };
    const addr = tonContractAddress(0, stateInit);

    console.log('\n=== Predicted ULN Connection address ===');
    console.log('Raw:          ', addr.toRawString());
    console.log('User-friendly:', addr.toString());

    // ── 6. Check current state (expect NONEXIST) ──────────────────────────────
    const state = await client.getContractState(addr);
    console.log('\nCurrent state:', state.state, '← expected: nonexist before broadcast');
    console.log('Balance:', state.balance, 'nanoTON');

    console.log('\nVerification plan:');
    console.log('  BEFORE broadcast → state should be: nonexist');
    console.log('  AFTER broadcast  → state should be: active, balance ≥ 0.3 TON');
}

main().catch(e => {
    console.error('ERROR:', e.message);
    if (e.stack) console.error(e.stack.split('\n').slice(1, 3).join('\n'));
    process.exit(1);
});
