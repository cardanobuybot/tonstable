import { toNano } from '@ton/core';
import { TonstableJettonWallet } from '../build/TonstableJettonWallet/TonstableJettonWallet_TonstableJettonWallet';
import { NetworkProvider } from '@ton/blueprint';

export async function run(provider: NetworkProvider) {
    const tonstableJettonWallet = provider.open(await TonstableJettonWallet.fromInit());

    await tonstableJettonWallet.send(
        provider.sender(),
        {
            value: toNano('0.05'),
        },
        null,
    );

    await provider.waitForDeploy(tonstableJettonWallet.address);

    // run methods on `tonstableJettonWallet`
}
