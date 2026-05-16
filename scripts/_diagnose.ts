// Deep diagnostic: trace the mint chain and verify on-chain state
import { TonClient } from '@ton/ton';
import { Address, Cell, beginCell } from '@ton/core';
import {
    TonstableMinter,
} from '../build/TonstableMinter/TonstableMinter_TonstableMinter';
import {
    TonstableJettonWallet,
} from '../build/TonstableJettonWallet/TonstableJettonWallet_TonstableJettonWallet';

const MINTER_ADDR  = Address.parse('EQAYNaqE6fdlxo2giEWWQU3QDHyxdN4atT9ixf8fAAy4XWth');
const ADAPTER_ADDR = Address.parse('EQDEvaMoKgKukFGOQMqZaxaKT0BmYMUmkyj45B6rUbGTXrKp');
const USER_ADDR    = Address.parse('0QAvWnxIIxiQ73MrKzI9_zQCxinF1yO5G7WZ1s7_Yo7lb8dv');
const KNOWN_WALLET = Address.parse('EQAdd0dSXN5asuj2EVitWslgCQjU13ATYnCU8eJiEz_QIkTW');

async function main() {
    const client = new TonClient({
        endpoint: 'https://testnet.toncenter.com/api/v2/jsonRPC',
        apiKey: '',
    });

    // ── 1. What does the Minter say the wallet address should be? ──────────
    console.log('\n=== 1. On-chain wallet address (from Minter getter) ===');
    const minter = client.open(TonstableMinter.fromAddress(MINTER_ADDR));
    let minterWalletAddr: Address;
    try {
        minterWalletAddr = await minter.getGetWalletAddress(USER_ADDR);
        console.log('get_wallet_address(user) =>', minterWalletAddr.toString());
        console.log('pre-deployed wallet      =>', KNOWN_WALLET.toString());
        console.log('Match?', minterWalletAddr.equals(KNOWN_WALLET));
    } catch (e: any) {
        console.log('ERROR calling get_wallet_address:', e.message);
        minterWalletAddr = KNOWN_WALLET;
    }

    // ── 2. Minter total supply ──────────────────────────────────────────────
    console.log('\n=== 2. Minter state ===');
    try {
        const supply = await minter.getTotalSupplyOf();
        console.log('totalSupplyOf()  =>', supply.toString());
        const data = await minter.getGetJettonData();
        console.log('get_jetton_data.totalSupply =>', data.totalSupply.toString());
    } catch (e: any) {
        console.log('ERROR:', e.message);
    }

    // ── 3. JettonWallet state (via Tact wrapper — uses correct methodId) ───
    console.log('\n=== 3. JettonWallet state via Tact wrapper ===');
    const wallet = client.open(TonstableJettonWallet.fromAddress(minterWalletAddr));
    try {
        const bal = await wallet.getBalance();
        console.log('balance() =>', bal.toString());
        const data = await wallet.getGetWalletData();
        console.log('walletData.balance =>', data.balance.toString());
        console.log('walletData.owner   =>', data.owner.toString());
        console.log('walletData.jetton  =>', data.jetton.toString());
    } catch (e: any) {
        console.log('ERROR calling wallet getters:', e.message);
    }

    // ── 4. Is the wallet even deployed? ────────────────────────────────────
    console.log('\n=== 4. Contract deployment status ===');
    try {
        const walletState = await client.getContractState(minterWalletAddr);
        console.log('JettonWallet state:', walletState.state);
        console.log('JettonWallet balance (TON):', walletState.balance.toString(), 'nanoTON');
    } catch (e: any) {
        console.log('ERROR:', e.message);
    }

    // ── 5. Recent txs on JettonWallet — look for JettonTransferInternal ───
    console.log('\n=== 5. JettonWallet recent txs ===');
    try {
        const txs = await client.getTransactions(minterWalletAddr, { limit: 10 });
        if (txs.length === 0) {
            console.log('  NO transactions found — wallet was never messaged!');
        }
        for (const tx of txs) {
            const cp = tx.description.type === 'generic' ? tx.description.computePhase : null;
            const exit = (cp && cp.type === 'vm') ? cp.exitCode : 'skip';
            const aborted = tx.description.type === 'generic' && tx.description.aborted;
            let inOp = 'empty';
            try {
                const b = tx.inMessage?.body.beginParse();
                if (b && b.remainingBits >= 32) inOp = '0x' + b.loadUint(32).toString(16);
            } catch (_) {}
            console.log(`  op:${inOp}  exit:${exit}  aborted:${aborted}  outMsgs:${tx.outMessages.size}`);
        }
    } catch (e: any) {
        console.log('ERROR:', e.message);
    }

    // ── 6. Recent txs on Minter — look for MintConfirmation (0x544E5302) ──
    console.log('\n=== 6. Minter recent txs (MintConfirmation = 0x544e5302) ===');
    try {
        const txs = await client.getTransactions(MINTER_ADDR, { limit: 15 });
        for (const tx of txs) {
            const cp = tx.description.type === 'generic' ? tx.description.computePhase : null;
            const exit = (cp && cp.type === 'vm') ? cp.exitCode : 'skip';
            const aborted = tx.description.type === 'generic' && tx.description.aborted;
            let inOp = 'empty';
            try {
                const b = tx.inMessage?.body.beginParse();
                if (b && b.remainingBits >= 32) inOp = '0x' + b.loadUint(32).toString(16);
            } catch (_) {}
            let outOps: string[] = [];
            for (const [, msg] of tx.outMessages) {
                try {
                    const b = msg.body.beginParse();
                    if (b.remainingBits >= 32) outOps.push('0x' + b.loadUint(32).toString(16));
                } catch (_) {}
            }
            console.log(`  in:${inOp}  out:${outOps.join(',')}  exit:${exit}  aborted:${aborted}`);
        }
    } catch (e: any) {
        console.log('ERROR:', e.message);
    }

    // ── 7. Verify TEP-74 standard getter get_wallet_data is callable ──────────
    console.log('\n=== 7. TEP-74 get_wallet_data live check ===');
    try {
        const walletState = await client.getContractState(minterWalletAddr);
        if (walletState.state !== 'active') {
            console.log('Wallet not deployed yet — skip getter check');
        } else {
            const r = await client.runMethod(minterWalletAddr, 'get_wallet_data', []);
            const bal    = r.stack.readBigNumber();
            const owner  = r.stack.readAddress();
            const jetton = r.stack.readAddress();
            console.log('balance :', bal.toString());
            console.log('owner   :', owner.toString());
            console.log('jetton  :', jetton.toString());
            if (bal > 0n) {
                console.log('=> TEP-74 getter OK — tonviewer/tonscan will show correct balance.');
            } else {
                console.log('=> balance=0 via standard getter (wallet may not have tokens yet).');
            }
        }
    } catch (e: any) {
        console.log('ERROR calling get_wallet_data:', e.message);
    }
}

main().catch(console.error);
