import { TonClient } from '@ton/ton';
import { Cell, Address } from '@ton/core';
import { loadTonstableMinter$Data } from '../build/TonstableMinter/TonstableMinter_TonstableMinter';

(async () => {
    const client = new TonClient({
        endpoint: 'https://testnet.toncenter.com/api/v2/jsonRPC',
        apiKey: process.env.APIKEY!
    });
    const minterAddr = Address.parse('EQAYNaqE6fdlxo2giEWWQU3QDHyxdN4atT9ixf8fAAy4XWth');
    const state = await client.getContractState(minterAddr);
    if (!state.data) { console.log('no data'); return; }
    const dataCell = Cell.fromBoc(state.data)[0];
    const storage = loadTonstableMinter$Data(dataCell.beginParse());
    console.log('bridgeAdapter:', storage.bridgeAdapter.toString());
    console.log('owner:        ', storage.owner.toString());
})().catch(e => { console.error(e.message); process.exit(1); });
