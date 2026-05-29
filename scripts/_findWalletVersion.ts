import { WalletContractV1R1, WalletContractV1R2, WalletContractV1R3,
         WalletContractV2R1, WalletContractV2R2,
         WalletContractV3R1, WalletContractV3R2,
         WalletContractV4, WalletContractV5R1 } from '@ton/ton';
import { mnemonicToPrivateKey } from '@ton/crypto';
import * as dotenv from 'dotenv';
dotenv.config();

const TARGET = '0QAvWnxIIxiQ73MrKzI9_zQCxinF1yO5G7WZ1s7_Yo7lb8dv';

async function main() {
    const m = process.env.WALLET_MNEMONIC!;
    console.log('Mnemonic word count:', m.split(' ').length);
    const keys = await mnemonicToPrivateKey(m.split(' '));
    
    const versions: Array<[string, any]> = [
        ['v1r1',  WalletContractV1R1],
        ['v1r2',  WalletContractV1R2],
        ['v1r3',  WalletContractV1R3],
        ['v2r1',  WalletContractV2R1],
        ['v2r2',  WalletContractV2R2],
        ['v3r1',  WalletContractV3R1],
        ['v3r2',  WalletContractV3R2],
        ['v4r2',  WalletContractV4],
        ['v5r1',  WalletContractV5R1],
    ];
    
    for (const [name, Cls] of versions) {
        try {
            const w = Cls.create({ workchain: 0, publicKey: keys.publicKey });
            const addr = w.address.toString({ bounceable: false, testOnly: true });
            const match = addr === TARGET ? ' *** MATCH ***' : '';
            console.log(`${name.padEnd(6)}: ${addr}${match}`);
        } catch(e) {
            console.log(`${name.padEnd(6)}: error`);
        }
    }
    console.log('TARGET:', TARGET);
    
    // Also try v4 with different walletIds
    console.log('\nv4r2 with walletId variations:');
    for (const id of [698983191, 698983190, 0, 1, 698983192]) {
        const w = WalletContractV4.create({ workchain: 0, publicKey: keys.publicKey, walletId: id });
        const addr = w.address.toString({ bounceable: false, testOnly: true });
        const match = addr === TARGET ? ' *** MATCH ***' : '';
        console.log(`  walletId=${id}: ${addr}${match}`);
    }
}
main().catch(console.error);
