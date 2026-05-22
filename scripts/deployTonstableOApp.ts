import { Cell, toNano } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';
import { getCompiledCode } from '@layerzerolabs/lz-ton-sdk-v2';
import { TonstableOApp } from '../wrappers/TonstableOApp';

export async function run(provider: NetworkProvider) {
    const sender = provider.sender();
    if (!sender.address) throw new Error('sender.address is undefined — connect a wallet first');
    const owner = sender.address;

    // getCompiledCode returns SDK's bundled @ton/core Cell (v0.59); project uses v0.63.
    // Same runtime bytes — cast is safe, matches the as-any pattern in the wrapper.
    const endpointCode = getCompiledCode('Endpoint') as unknown as Cell;
    const channelCode  = getCompiledCode('Channel')  as unknown as Cell;

    const oapp = provider.open(
        await TonstableOApp.createFromConfig({ owner, endpointCode, channelCode })
    );

    if (await provider.isContractDeployed(oapp.address)) {
        console.log('TonstableOApp already deployed at', oapp.address.toString());
        return;
    }

    await oapp.sendDeploy(provider.sender(), toNano('0.5'));
    await provider.waitForDeploy(oapp.address);

    console.log('TonstableOApp deployed at', oapp.address.toString());
    console.log('Next: wire this address via SetPeer / SetLzConfig on both chains.');
}
