import {
    Address,
    Cell,
    Contract,
    ContractProvider,
    SendMode,
    Sender,
    beginCell,
    contractAddress,
} from '@ton/core';
import type { SendMessageResult } from '@ton/sandbox';
import { compile } from '@ton/blueprint';
import {
    ClDeclareField,
    OPCODES,
    addressToBigInt,
    asciiStringToBigint,
    cl,
    clDeclare,
    initBaseOApp,
    initBaseStorage,
} from '@layerzerolabs/lz-ton-sdk-v2';

const OAPP_NAME = asciiStringToBigint('tonstable'); // MAX_NAME_LEN=10
// cl.t.address == cl.t.uint256 == 8 → both serialized as 256-bit storeUint (hash only, no workchain)
const CONTROLLER_ADDR: bigint = addressToBigInt('EQAYlRK0qV4D1VqN7kl8NN3ghmO8xDgoGO84LLe3zfetaogF');
const MINTER_ADDR: bigint     = addressToBigInt('EQA31yC0LEgeshdze-eFQntYknWsFkZfYKPpIAi0XbGIhPKi');
const TON_EID = 40343n;
const BASE_LZ_RECEIVE_GAS = 100000n;

// Opcodes the Minter sends to this OApp (interface.fc).
const OP_BRIDGE_MINT_REQUEST   = 0x544e5310;
const OP_BRIDGE_REDEEM_REQUEST = 0x544e5311;

export interface TonstableOAppConfig {
    owner: Address;
    endpointCode: Cell;
    channelCode: Cell;
}

function buildData(config: TonstableOAppConfig): Cell {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fields: ClDeclareField[] = [
        { type: cl.t.objRef,  value: initBaseStorage(addressToBigInt(config.owner.toString({ testOnly: false }))) },
        { type: cl.t.objRef,  value: initBaseOApp({
            controllerAddress: CONTROLLER_ADDR,
            srcEid:            TON_EID,
            baseLzReceiveGas:  BASE_LZ_RECEIVE_GAS,
            endpointCode:      config.endpointCode as any,
            channelCode:       config.channelCode as any,
        }) },
        { type: cl.t.uint256, value: MINTER_ADDR },
    ];
    // SDK uses @ton/core@0.59; project uses @ton/core@0.63 — BOC round-trip bridges the version gap
    const sdkCell = clDeclare(OAPP_NAME, fields) as unknown as { toBoc(): Buffer };
    return Cell.fromBoc(sdkCell.toBoc())[0];
}

export class TonstableOApp implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell },
    ) {}

    static async createFromConfig(
        config: TonstableOAppConfig,
        workchain = 0,
    ): Promise<TonstableOApp> {
        const code = await compile('TonstableOApp');
        const data = buildData(config);
        const init = { code, data };
        return new TonstableOApp(contractAddress(workchain, init), init);
    }

    static createFromAddress(address: Address): TonstableOApp {
        return new TonstableOApp(address);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint): Promise<void> {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    async sendInitialize(provider: ContractProvider, via: Sender, value: bigint): Promise<void> {
        // BaseInterface::OP::INITIALIZE = "BaseInterface::OP::INITIALIZE"c = 4133284232
        const OP_INITIALIZE = 4133284232n;
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(OP_INITIALIZE, 32)
                .storeUint(0n, 64)
                .storeCoins(0n)
                .storeRef(beginCell().endCell())
                .endCell(),
        });
    }

    async sendSetPeer(
        provider: ContractProvider,
        via: Sender,
        opts: { value: bigint; dstEid: number; peer: bigint },
    ): Promise<void> {
        // Build md::SetPeer cell via SDK clDeclare (same pattern as buildData).
        // SDK uses @ton/core@0.59 — BOC round-trip bridges the version gap.
        const sdkMd = clDeclare(
            asciiStringToBigint('setPeer'),
            [
                { type: cl.t.uint32,  value: BigInt(opts.dstEid) },
                { type: cl.t.uint256, value: opts.peer },
            ],
        ) as unknown as { toBoc(): Buffer };
        const mdCell = Cell.fromBoc(sdkMd.toBoc())[0];

        // contractMain message format (txnContext.fc):
        //   uint32 op | uint64 query_id | coins donationNanos | ref $md
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(OPCODES.OP_SetPeer, 32)
                .storeUint(0n, 64)
                .storeCoins(0n)
                .storeRef(mdCell)
                .endCell(),
        });
    }

    // Mirrors the Minter's BridgeMintRequest. $md layout (handler.fc handleBridgeMintRequest):
    //   [uint64 nonce][addr userTon][uint128 usdValue][uint128 minLusdOut][uint64 deadline]
    // contractMain inbound body: uint32 op | uint64 query_id | coins donationNanos | ref $md.
    async sendBridgeMintRequest(
        provider: ContractProvider,
        via: Sender,
        opts: {
            value: bigint;
            nonce: bigint;
            userTon: Address;
            usdValue: bigint;
            minLusdOut: bigint;
            deadline: bigint;
        },
    ): Promise<SendMessageResult> {
        const md = beginCell()
            .storeUint(opts.nonce, 64)
            .storeAddress(opts.userTon)
            .storeUint(opts.usdValue, 128)
            .storeUint(opts.minLusdOut, 128)
            .storeUint(opts.deadline, 64)
            .endCell();
        return (await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(OP_BRIDGE_MINT_REQUEST, 32)
                .storeUint(0n, 64)
                .storeCoins(0n)
                .storeRef(md)
                .endCell(),
        })) as unknown as SendMessageResult;
    }

    // Mirrors the Minter's BridgeRedeemRequest. $md layout (handler.fc handleBridgeRedeemRequest):
    //   [uint64 nonce][addr userTon][uint128 tonstblBurned][uint64 deadline]
    async sendBridgeRedeemRequest(
        provider: ContractProvider,
        via: Sender,
        opts: {
            value: bigint;
            nonce: bigint;
            userTon: Address;
            tonstblBurned: bigint;
            deadline: bigint;
        },
    ): Promise<SendMessageResult> {
        const md = beginCell()
            .storeUint(opts.nonce, 64)
            .storeAddress(opts.userTon)
            .storeUint(opts.tonstblBurned, 128)
            .storeUint(opts.deadline, 64)
            .endCell();
        return (await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(OP_BRIDGE_REDEEM_REQUEST, 32)
                .storeUint(0n, 64)
                .storeCoins(0n)
                .storeRef(md)
                .endCell(),
        })) as unknown as SendMessageResult;
    }
}
