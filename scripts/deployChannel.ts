/**
 * Deploy the LZ Channel for our OApp (srcOApp=EQA2SPLt..., dstEid=40231).
 *
 * Why: Endpoint sends Channel_OP_CHANNEL_SEND to Channel address WITHOUT StateInit.
 * Channel must be pre-deployed via OApp's OP_DeployChannel handler.
 *
 * What this does:
 *   1. Sends OP_DeployChannel (0x70ead753) to our OApp
 *   2. OApp computes Channel StateInit and deploys it with StateInit
 *   3. Channel at 0:445B4A01... becomes active
 *   4. Subsequent lzSend hops will succeed
 */
import { NetworkProvider } from '@ton/blueprint';
import { Address, Cell, beginCell, toNano } from '@ton/core';
import {
    OPCODES,
    clDeclare,
    asciiStringToBigint,
    emptyCell,
    cl,
} from '@layerzerolabs/lz-ton-sdk-v2';

const OAPP_ADDR = 'EQA2SPLtbQGkijeadXNHdhO3swGIJCBK_4LhFcJBHKV6_9BK';

// Vault EVM address padded to 256-bit big-endian (as stored in LZ path)
const VAULT_PADDED = BigInt('0x000000000000000000000000Ac997b1723b497Aa7694D4a402Dd34943df81B20');
const DST_EID      = 40231n;  // Arb Sepolia

// Initial balance for the Channel contract. Must be > 0 to survive storage fees.
// 0.3 TON keeps Channel alive indefinitely at testnet storage rates.
const INITIAL_DEPOSIT = 300_000_000n; // 0.3 TON in nanotons

export async function run(provider: NetworkProvider) {
    const oappAddr = Address.parse(OAPP_ADDR);

    console.log('=== Deploy Channel via OP_DeployChannel ===');
    console.log('OApp:', OAPP_ADDR);
    console.log('dstEid:', DST_EID.toString(), '(Arb Sepolia)');
    console.log('dstOApp (Vault):', '0x' + VAULT_PADDED.toString(16).padStart(64, '0'));
    console.log('initialDeposit:', INITIAL_DEPOSIT.toString(), 'nanoTON');

    // Build md::Deploy cell
    const deployName = asciiStringToBigint('deploy');
    const sdkMdDeploy = clDeclare(deployName, [
        { type: cl.t.coins,   value: INITIAL_DEPOSIT },
        { type: cl.t.uint32,  value: DST_EID },
        { type: cl.t.uint256, value: VAULT_PADDED },
        { type: cl.t.objRef,  value: emptyCell() },   // extraInfo = empty
    ]) as unknown as { toBoc(): Buffer };
    const mdCell = Cell.fromBoc(sdkMdDeploy.toBoc())[0];

    // Build message: op | query_id | donation | ref(md::Deploy)
    const OP_DEPLOY_CHANNEL = Number(OPCODES.OP_DeployChannel);
    const body = beginCell()
        .storeUint(OP_DEPLOY_CHANNEL, 32)
        .storeUint(0n, 64)        // query_id
        .storeCoins(0n)           // donation nanos
        .storeRef(mdCell)
        .endCell();

    console.log('\nMessage body built:');
    console.log('  op: 0x' + OP_DEPLOY_CHANNEL.toString(16));
    console.log('  body bits:', body.bits.length, 'refs:', body.refs.length);
    console.log('  value to attach: 0.5 TON (0.3 Channel deposit + 0.2 OApp gas)');

    const sender = provider.sender();
    await sender.send({
        to: oappAddr,
        value: toNano('0.5'),
        body,
    });

    console.log('\n✅ DeployChannel transaction sent. Monitor at tonviewer:');
    console.log('  OApp: https://testnet.tonviewer.com/' + OAPP_ADDR);
    console.log('  Expected Channel: https://testnet.tonviewer.com/EQBEW0oB8wzGjeFH-NmabZwtSYY3scIpwnlUbpC1ZXKBe2iK');
    console.log('\nAfter Channel deploys, run: npx blueprint run _realHop --testnet');
}
