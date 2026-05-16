// Polls until the redeem settles: totalSupply = 0 and wallet balance = 0
import { TonClient } from '@ton/ton';
import { Address } from '@ton/core';
import { TonstableMinter } from '../build/TonstableMinter/TonstableMinter_TonstableMinter';
import { TonstableJettonWallet } from '../build/TonstableJettonWallet/TonstableJettonWallet_TonstableJettonWallet';

const MINTER_ADDRESS = Address.parse('EQAYNaqE6fdlxo2giEWWQU3QDHyxdN4atT9ixf8fAAy4XWth');
const USER_ADDRESS   = Address.parse('0QAvWnxIIxiQ73MrKzI9_zQCxinF1yO5G7WZ1s7_Yo7lb8dv');

const client = new TonClient({ endpoint: 'https://testnet.toncenter.com/api/v2/jsonRPC' });

async function delay(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
    const minter = client.open(TonstableMinter.fromAddress(MINTER_ADDRESS));
    const walletAddr = await minter.getGetWalletAddress(USER_ADDRESS);
    const wallet = client.open(TonstableJettonWallet.fromAddress(walletAddr));

    console.log('Polling for redeem confirmation...');
    console.log('JettonWallet:', walletAddr.toString());

    for (let i = 0; i < 60; i++) {
        try {
            const supply  = await minter.getTotalSupplyOf();
            await delay(1500);
            const balance = await wallet.getBalance();

            process.stdout.write(`  totalSupply=${supply}  walletBalance=${balance}  attempt ${i+1}/60\r`);

            if (supply === 0n && balance === 0n) {
                console.log('\n\nCONFIRMED — redeem complete!');
                console.log('totalSupply = 0 ✓');
                console.log('wallet balance = 0 ✓');
                return;
            }
        } catch (e: any) {
            process.stdout.write(`attempt ${i+1} error: ${e.message}\r`);
        }
        await delay(3000);
    }
    console.log('\nTimed out — check tonscan manually');
}

main().catch(console.error);
