// Direct deploy script using TonCenter v3 /message API
// Used when blueprint's v2 sendBoc returns 500 on large BOCs
import { Address, beginCell, Cell, Dictionary, toNano, internal, SendMode } from '@ton/core';
import { TonstableMinter, Deploy } from '../build/TonstableMinter/TonstableMinter_TonstableMinter';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { WalletContractV5R1, TonClient } from '@ton/ton';
import { createHash } from 'crypto';
import * as dotenv from 'dotenv';
dotenv.config();

const ADMIN_ADDRESS = Address.parse('0QAvWnxIIxiQ73MrKzI9_zQCxinF1yO5G7WZ1s7_Yo7lb8dv');
const API_KEY = process.env.TONCENTER_API_KEY!;
const MNEMONIC  = process.env.WALLET_MNEMONIC!;
const V3_BASE   = 'https://testnet.toncenter.com/api/v3';

function buildOnChainMetadata(fields: Record<string, string>): Cell {
    const dict = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
    for (const [key, value] of Object.entries(fields)) {
        const keyHash = BigInt('0x' + createHash('sha256').update(key).digest('hex'));
        dict.set(keyHash, beginCell().storeUint(0x00, 8).storeStringTail(value).endCell());
    }
    return beginCell().storeUint(0x00, 8).storeDict(dict).endCell();
}

const JETTON_CONTENT = buildOnChainMetadata({
    name:        'TONSTABLE',
    symbol:      'TONSTBL',
    decimals:    '9',
    description: 'Cross-chain backed stablecoin pegged to USD and secured by Arbitrum vaults',
    image:       'https://tonstable.io/logo.png',
});

async function sendBocV3(boc: string): Promise<string> {
    const res = await fetch(`${V3_BASE}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
        body: JSON.stringify({ boc }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`v3 /message error ${res.status}: ${text}`);
    return text;
}

async function main() {
    const keys = await mnemonicToPrivateKey(MNEMONIC.split(' '));
    const wallet = WalletContractV5R1.create({ workchain: 0, publicKey: keys.publicKey });

    const client = new TonClient({
        endpoint: `https://testnet.toncenter.com/api/v2/jsonRPC?api_key=${API_KEY}`,
    });
    const walletContract = client.open(wallet);

    const minterContract = await TonstableMinter.fromInit(
        ADMIN_ADDRESS, ADMIN_ADDRESS, ADMIN_ADDRESS, ADMIN_ADDRESS, JETTON_CONTENT,
    );

    console.log('Expected NEW_MINTER_ADDR:', minterContract.address.toString({ bounceable: true }));
    console.log('Wallet:', wallet.address.toString({ bounceable: false, testOnly: true }));

    const seqno = await walletContract.getSeqno();
    console.log('Wallet seqno:', seqno);

    const deployMsg: Deploy = { $$type: 'Deploy', queryId: 0n };
    const deployPayload = beginCell().store(storeDeploy(deployMsg)).endCell();

    const transfer = walletContract.createTransfer({
        seqno,
        secretKey: keys.secretKey,
        messages: [
            internal({
                to: minterContract.address,
                value: toNano('0.05'),
                init: minterContract.init,
                body: deployPayload,
                bounce: true,
            }),
        ],
        sendMode: SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS,
    });

    const boc = transfer.toBoc().toString('base64');
    console.log('BOC size (bytes):', transfer.toBoc().length);
    console.log('Sending via v3 /message...');

    const result = await sendBocV3(boc);
    console.log('v3 response:', result);
    console.log('\nNEW_MINTER_ADDR =', minterContract.address.toString({ bounceable: true }));
    console.log('Monitor at: https://testnet.tonscan.io/address/', minterContract.address.toString({ bounceable: true }));
}

// Inline the Deploy store function since we need it from the generated types
function storeDeploy(msg: Deploy) {
    return (builder: any) => {
        builder.storeUint(2490013878, 32);
        builder.storeUint(msg.queryId, 64);
    };
}

main().catch(e => { console.error(e); process.exit(1); });
