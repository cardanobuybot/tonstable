import { WalletContractV4 } from '@ton/ton';
import { mnemonicToPrivateKey } from '@ton/crypto';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
    const m = process.env.WALLET_MNEMONIC!;
    console.log('Words:', m.split(' ').length);
    const keys = await mnemonicToPrivateKey(m.split(' '));
    const target = '0QAvWnxIIxiQ73MrKzI9_zQCxinF1yO5G7WZ1s7_Yo7lb8dv';
    for (const id of [698983191, 0, 1, 2, 100, 698983190, 42]) {
        const w = WalletContractV4.create({ workchain: 0, publicKey: keys.publicKey, walletId: id });
        const addr = w.address.toString({ bounceable: false, testOnly: true });
        console.log(`walletId=${id} -> ${addr}`);
        if (addr === target) console.log('  ^^^ MATCH!');
    }
    console.log('Target:', target);
}
main().catch(console.error);
