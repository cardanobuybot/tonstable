/**
 * Deploy the LZ ULN Connection for our OApp path (srcOApp → dstEid=40231 → Vault).
 *
 * Why: lzSend fails at the ULN stage because UlnManager has no UlnConnection record
 * for our specific OApp+path combo. UlnConnection must be pre-deployed via
 * OApp's OP_DeployConnection handler.
 *
 * What this does:
 *   1. Builds md::MdAddress wrapping md::Deploy + UlnManager address
 *   2. Sends OP_DeployConnection (0xDD1FDFDB) to our OApp
 *   3. OApp extracts (deploy, ulnManagerAddr) from md::MdAddress and forwards
 *      to UlnManager with MsglibManager_OP_DEPLOY_CONNECTION
 *   4. UlnManager computes UlnConnection StateInit from path+caller, deploys it,
 *      and immediately sends INITIALIZE to the new contract
 *
 * Gas budget (3 hops):
 *   0.30 TON — UlnConnection initial deposit (must survive storage fees)
 *   0.10 TON — OApp → UlnManager message processing
 *   0.10 TON — UlnManager deploy + forward to UlnConnection
 *   0.15 TON — UlnConnection INITIALIZE processing (separate internal message)
 *   ─────────
 *   0.65 TON  total (vs 0.5 TON for deployChannel which has 2 hops and no INITIALIZE)
 */
import { NetworkProvider } from '@ton/blueprint';
import { Address, Cell, beginCell, toNano } from '@ton/core';
import {
    OPCODES,
    clDeclare,
    asciiStringToBigint,
    emptyCell,
    cl,
    addressToBigInt,
    nullObject,
} from '@layerzerolabs/lz-ton-sdk-v2';

const OAPP_ADDR    = 'EQA2SPLtbQGkijeadXNHdhO3swGIJCBK_4LhFcJBHKV6_9BK';
const ULN_MANAGER  = 'EQC0tTlvumGHvKzMHPODV7ARp3DLIV4P_zXeZ-SQ7MO0kCMC';

const VAULT_PADDED    = BigInt('0x000000000000000000000000Ac997b1723b497Aa7694D4a402Dd34943df81B20');
const DST_EID         = 40231n;
const INITIAL_DEPOSIT = 300_000_000n; // 0.3 TON in nanotons

export async function run(provider: NetworkProvider) {
    const oappAddr = Address.parse(OAPP_ADDR);

    console.log('=== Deploy ULN Connection via OP_DeployConnection ===');
    console.log('OApp:        ', OAPP_ADDR);
    console.log('UlnManager:  ', ULN_MANAGER);
    console.log('dstEid:      ', DST_EID.toString(), '(Arb Sepolia)');
    console.log('dstOApp (Vault):', '0x' + VAULT_PADDED.toString(16).padStart(64, '0'));
    console.log('initialDeposit:', INITIAL_DEPOSIT.toString(), 'nanoTON (0.3 TON)');

    // ── 0. Build md::InitUlnConnection (extraInfo) ───────────────────────────
    // The deployed UlnManager calls md::InitUlnConnection::sanitize() on extraInfo,
    // then overwrites endpointAddress+channelAddress from on-chain storage.
    // We must pass a valid InitUlnConnection cell; emptyCell() causes exit_code=9.
    // All-null flags → UlnManager uses its on-chain defaults for DVNs / executor / confirmations.
    const NIL_ADDRESS = 2n ** 256n - 1n; // MAX_U256 = NIL executor address
    const ulnSendConfig = clDeclare(asciiStringToBigint('UlnSendCfg'), [
        { type: cl.t.uint32,  value: 0n },           // workerQuoteGasLimit = 0
        { type: cl.t.uint32,  value: 0n },           // maxMessageBytes = 0
        { type: cl.t.bool,    value: 1n },           // executorNull = true
        { type: cl.t.address, value: NIL_ADDRESS },  // executor = NIL
        { type: cl.t.bool,    value: 1n },           // requiredDVNsNull = true
        { type: cl.t.objRef,  value: emptyCell() },  // requiredDVNs = empty
        { type: cl.t.bool,    value: 1n },           // optionalDVNsNull = true
        { type: cl.t.objRef,  value: emptyCell() },  // optionalDVNs = empty
        { type: cl.t.bool,    value: 1n },           // confirmationsNull = true
        { type: cl.t.uint64,  value: 0n },           // confirmations = 0
    ]);
    const ulnReceiveConfig = clDeclare(asciiStringToBigint('UlnRecvCfg'), [
        { type: cl.t.bool,    value: 1n },           // minCommitPacketGasNull = true
        { type: cl.t.uint32,  value: 0n },           // minCommitPacketGas = 0
        { type: cl.t.bool,    value: 1n },           // confirmationsNull = true
        { type: cl.t.uint64,  value: 0n },           // confirmations = 0
        { type: cl.t.bool,    value: 1n },           // requiredDVNsNull = true
        { type: cl.t.objRef,  value: emptyCell() },  // requiredDVNs = empty
        { type: cl.t.bool,    value: 1n },           // optionalDVNsNull = true
        { type: cl.t.objRef,  value: emptyCell() },  // optionalDVNs = empty
        { type: cl.t.uint8,   value: 0n },           // optionalDVNThreshold = 0
    ]);
    const initUlnConnection = clDeclare(asciiStringToBigint('initUlnCon'), [
        { type: cl.t.objRef,  value: ulnSendConfig },    // ulnSendConfigOApp (all-null = use defaults)
        { type: cl.t.objRef,  value: ulnReceiveConfig }, // ulnReceiveConfigOApp (all-null = use defaults)
        { type: cl.t.address, value: 0n },               // endpointAddress (overwritten by UlnManager)
        { type: cl.t.address, value: 0n },               // channelAddress (overwritten by UlnManager)
    ]);

    // ── 1. md::Deploy ────────────────────────────────────────────────────────
    const mdDeployRaw = clDeclare(asciiStringToBigint('deploy'), [
        { type: cl.t.coins,   value: INITIAL_DEPOSIT },
        { type: cl.t.uint32,  value: DST_EID },
        { type: cl.t.uint256, value: VAULT_PADDED },
        { type: cl.t.objRef,  value: initUlnConnection }, // extraInfo = InitUlnConnection
    ]);

    // ── 2. md::MdAddress (name="MdAddr") wraps deploy + UlnManager address ──
    // Unlike deployChannel (which reads controllerAddress from OApp storage),
    // deployConnection requires the caller to specify the MsglibManager address
    // explicitly inside md::MdAddress.
    const ulnManagerInt = addressToBigInt(ULN_MANAGER);
    const mdMdAddressRaw = clDeclare(asciiStringToBigint('MdAddr'), [
        { type: cl.t.objRef,  value: mdDeployRaw },   // md::MdAddress::md
        { type: cl.t.address, value: ulnManagerInt },  // md::MdAddress::address
    ]);
    const mdMdAddressCell = Cell.fromBoc(
        (mdMdAddressRaw as unknown as { toBoc(): Buffer }).toBoc()
    )[0];

    // ── 3. Outer message: op | query_id | donation | ref(mdMdAddress) ────────
    const OP_DEPLOY_CONNECTION = Number(OPCODES.OP_DeployConnection);
    const body = beginCell()
        .storeUint(OP_DEPLOY_CONNECTION, 32)
        .storeUint(0n, 64)    // query_id
        .storeCoins(0n)        // donation nanos
        .storeRef(mdMdAddressCell)
        .endCell();

    console.log('\nMessage body built:');
    console.log('  op: 0x' + OP_DEPLOY_CONNECTION.toString(16));
    console.log('  body bits:', body.bits.length, 'refs:', body.refs.length);
    console.log('  value to attach: 0.65 TON');

    const sender = provider.sender();
    await sender.send({
        to: oappAddr,
        value: toNano('0.65'),
        body,
    });

    console.log('\n✅ DeployUlnConnection transaction sent. Monitor at tonviewer:');
    console.log('  OApp:       https://testnet.tonviewer.com/' + OAPP_ADDR);
    console.log('  UlnManager: https://testnet.tonviewer.com/' + ULN_MANAGER);
    console.log('\nAfter UlnConnection deploys, run: npx blueprint run _realHop --testnet');
}
