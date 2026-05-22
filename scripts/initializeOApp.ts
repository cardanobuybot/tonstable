import { NetworkProvider } from '@ton/blueprint';
import { Address, toNano } from '@ton/core';
import { TonstableOApp } from '../wrappers/TonstableOApp';

const OAPP_ADDR = 'EQCauDCj8lkhYYs9LQqWJ6snD0Wguk-cwB3mmaQxlcxbbO5r';

export async function run(provider: NetworkProvider) {
    const oapp = provider.open(TonstableOApp.createFromAddress(Address.parse(OAPP_ADDR)));

    console.log('=== Initialize TonstableOApp ===');
    console.log('OApp:', OAPP_ADDR);
    console.log('Sending OP_INITIALIZE (sets initialized=true in BaseStorage)...');

    await oapp.sendInitialize(provider.sender(), toNano('0.1'));

    console.log('Initialize transaction sent. Monitor via tonviewer.');
}
