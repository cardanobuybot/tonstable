import { toNano } from '@ton/core';
import { TonstableMinter } from '../build/TonstableMinter/TonstableMinter_TonstableMinter';
import { NetworkProvider } from '@ton/blueprint';

export async function run(provider: NetworkProvider) {
    const tonstableMinter = provider.open(await TonstableMinter.fromInit());

    await tonstableMinter.send(
        provider.sender(),
        {
            value: toNano('0.05'),
        },
        null,
    );

    await provider.waitForDeploy(tonstableMinter.address);

    // run methods on `tonstableMinter`
}
