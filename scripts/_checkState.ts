import { TonClient } from '@ton/ton';
import { Address } from '@ton/core';

async function main() {
    const client = new TonClient({ endpoint: 'https://testnet.toncenter.com/api/v2/jsonRPC' });
    const adapter = Address.parse('EQBFN5NGvD5Vgh3mhCePHNO7llLi1m6fCvoWPMpwc_mkKK6M');
    const minter  = Address.parse('EQDDp5bjnJuNP1Au2G5tRfvoBXxM7JP6VzLI6mXN_PTsODpC');

    for (const [label, addr] of [['MockBridgeAdapter', adapter], ['Minter', minter]] as [string, Address][]) {
        const txs = await client.getTransactions(addr, { limit: 8 });
        console.log(`\n=== ${label} — ${txs.length} recent txs:`);
        for (const tx of txs) {
            const cp = tx.description.type === 'generic' ? tx.description.computePhase : null;
            const exit = (cp && cp.type === 'vm') ? cp.exitCode : 'skip';
            let inOp = 'empty';
            try {
                const b = tx.inMessage?.body.beginParse();
                if (b && b.remainingBits >= 32) inOp = '0x' + b.loadUint(32).toString(16);
            } catch (_) {}
            const aborted = tx.description.type === 'generic' && tx.description.aborted;
            console.log(`  op:${inOp}  out:${tx.outMessages.size}  exit:${exit}  aborted:${aborted}`);
        }
    }
}
main().catch(console.error);
