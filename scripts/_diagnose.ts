// Deep diagnostic: trace the mint chain and verify on-chain state
import { TonClient } from '@ton/ton';
import { Address, Cell, beginCell } from '@ton/core';
import {
    TonstableMinter,
} from '../build/TonstableMinter/TonstableMinter_TonstableMinter';
import {
    TonstableJettonWallet,
} from '../build/TonstableJettonWallet/TonstableJettonWallet_TonstableJettonWallet';

const MINTER_ADDR  = Address.parse('EQDDp5bjnJuNP1Au2G5tRfvoBXxM7JP6VzLI6mXN_PTsODpC');
const ADAPTER_ADDR = Address.parse('EQBFN5NGvD5Vgh3mhCePHNO7llLi1m6fCvoWPMpwc_mkKK6M');
const USER_ADDR    = Address.parse('0QAvWnxIIxiQ73MrKzI9_zQCxinF1yO5G7WZ1s7_Yo7lb8dv');
const KNOWN_WALLET = Address.parse('EQA9EcFP5ZaQGSjPna0Uujf_Yqi1qiVZszfeDTMOkaJQuH_b');

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
        const data = await wallet.getWalletData();
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

    // ── 7. Check standard TEP-74 getter methodId 0x5B88 = get_wallet_data ─
    console.log('\n=== 7. TEP-74 standard getter check ===');
    // TEP-74: get_wallet_data method_id = -4 (in old FunC) or crc16-based
    // Tact compiled walletData has methodId=103862 (0x19616)
    // Standard get_wallet_data methodId = 0x5B88 (23432)
    // Standard get_balance methodId = 0x6EF (?)
    console.log('Tact compiled walletData methodId  :', 103862, '(0x' + (103862).toString(16) + ')');
    console.log('Tact compiled balance methodId     :', 104128, '(0x' + (104128).toString(16) + ')');
    console.log('TEP-74 standard get_wallet_data    : methodId should be derived from name');
    console.log('Tonviewer looks for "get_wallet_data" — Tact exported "walletData"');
    console.log('=> This is why tonviewer shows 0 balance even if tokens exist on-chain');
}

main().catch(console.error);
