import { WalletContractV4, WalletContractV3R2, WalletContractV5R1 } from '@ton/ton';
import { mnemonicToPrivateKey } from '@ton/crypto';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
    const m = process.env.WALLET_MNEMONIC!;
    console.log('Mnemonic words:', m.split(' ').length);
    const keys = await mnemonicToPrivateKey(m.split(' '));
    const v4   = WalletContractV4.create({ workchain: 0, publicKey: keys.publicKey });
    const v3r2 = WalletContractV3R2.create({ workchain: 0, publicKey: keys.publicKey });
    const v5r1 = WalletContractV5R1.create({ workchain: 0, publicKey: keys.publicKey });
    console.log('v4  :', v4.address.toString({ bounceable: false, testOnly: true }));
    console.log('v3r2:', v3r2.address.toString({ bounceable: false, testOnly: true }));
    console.log('v5r1:', v5r1.address.toString({ bounceable: false, testOnly: true }));
    console.log('ADMIN (from scripts): 0QAvWnxIIxiQ73MrKzI9_zQCxinF1yO5G7WZ1s7_Yo7lb8dv');
}
main().catch(console.error);
