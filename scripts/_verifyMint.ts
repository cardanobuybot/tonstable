import { TonClient } from '@ton/ton';
import { Address } from '@ton/core';
import { TonstableMinter } from '../build/TonstableMinter/TonstableMinter_TonstableMinter';

const NEW_MINTER = Address.parse('EQAYNaqE6fdlxo2giEWWQU3QDHyxdN4atT9ixf8fAAy4XWth');
const USER       = Address.parse('0QAvWnxIIxiQ73MrKzI9_zQCxinF1yO5G7WZ1s7_Yo7lb8dv');

const client = new TonClient({ endpoint: 'https://testnet.toncenter.com/api/v2/jsonRPC' });

async function delay(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
    console.log('Polling new Minter for successful mint...');
    let walletAddr: Address | undefined;

    for (let i = 0; i < 60; i++) {
        try {
            const minter = client.open(TonstableMinter.fromAddress(NEW_MINTER));
            const supply = await minter.getTotalSupplyOf();
            if (!walletAddr) walletAddr = await minter.getGetWalletAddress(USER);

            if (supply > 0n) {
                console.log(`\ntotalSupply = ${supply} ✓`);
                console.log(`JettonWallet = ${walletAddr!.toString()}`);

                await delay(2000);
                const ws = await client.getContractState(walletAddr!);
                console.log(`Wallet state: ${ws.state}  TON balance: ${ws.balance}`);

                if (ws.state === 'active') {
                    await delay(2000);
                    // Test standard TEP-74 getter get_wallet_data
                    const r2 = await client.runMethod(walletAddr!, 'get_wallet_data', []);
                    const bal = r2.stack.readBigNumber();
                    const owner = r2.stack.readAddress();
                    const jetton = r2.stack.readAddress();
                    console.log(`\nget_wallet_data() balance = ${bal}`);
                    console.log(`get_wallet_data() owner   = ${owner.toString()}`);
                    console.log(`get_wallet_data() jetton  = ${jetton.toString()}`);

                    if (bal > 0n) {
                        console.log('\nCONFIRMED — tokens visible via TEP-74 standard getter!');
                        console.log('Tonviewer should now show the balance.');
                    } else {
                        console.log('\nWARNING: wallet active but balance=0 via get_wallet_data');
                    }
                } else {
                    console.log('Wallet not yet active — JettonTransferInternal may not have landed yet');
                }
                return;
            }

            process.stdout.write(`totalSupply=0 attempt ${i + 1}/60\r`);
        } catch (e: any) {
            process.stdout.write(`attempt ${i + 1} error: ${e.message}\r`);
        }
        await delay(3000);
    }
    console.log('\nTimed out after 3 minutes — check tonscan manually');
}

main().catch(console.error);
