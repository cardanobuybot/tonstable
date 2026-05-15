import { toNano, Address } from '@ton/core';
import { TonstableJettonWallet, Deploy } from '../build/TonstableJettonWallet/TonstableJettonWallet_TonstableJettonWallet';
import { NetworkProvider } from '@ton/blueprint';

// Deployer / owner address (W5 testnet wallet derived from WALLET_MNEMONIC).
const OWNER_ADDRESS  = Address.parse('0QAvWnxIIxiQ73MrKzI9_zQCxinF1yO5G7WZ1s7_Yo7lb8dv');

// TonstableMinter deployed in the previous step.
const MASTER_ADDRESS = Address.parse('EQDDp5bjnJuNP1Au2G5tRfvoBXxM7JP6VzLI6mXN_PTsODpC');

export async function run(provider: NetworkProvider) {
    const tonstableJettonWallet = provider.open(
        await TonstableJettonWallet.fromInit(OWNER_ADDRESS, MASTER_ADDRESS)
    );

    const deployMsg: Deploy = { $$type: 'Deploy', queryId: 0n };

    await tonstableJettonWallet.send(
        provider.sender(),
        { value: toNano('0.05') },
        deployMsg,
    );

    await provider.waitForDeploy(tonstableJettonWallet.address);

    console.log('TonstableJettonWallet deployed at', tonstableJettonWallet.address.toString());
}
