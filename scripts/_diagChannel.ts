/**
 * Channel address diagnostics:
 * 1. Read live Endpoint storage — code hash, channelCode hash, channelStorageInit
 * 2. Build path cell for (srcOApp=NEW_OAPP, dstEid=40231) and call get_getChannelAddress
 * 3. Compare computed Channel address vs old bounced address (0:445B4A01...)
 * 4. Check status of computed Channel
 * 5. Read OApp storage — check embedded channelCode hash
 */
import { TonClient } from '@ton/ton';
import { Address, Cell, beginCell } from '@ton/core';
import { getCompiledCode, buildPathClass, addressToBigInt } from '@layerzerolabs/lz-ton-sdk-v2';

const ENDPOINT    = 'EQDFTTIsLOLMxfeMpkeaYx5UIY8RZcOoDArQBfqTZ7H-6Ybs';
const NEW_OAPP    = 'EQA2SPLtbQGkijeadXNHdhO3swGIJCBK_4LhFcJBHKV6_9BK';
// Vault EVM address padded to 32-byte big-endian (as LZ path stores it)
const VAULT_PADDED = BigInt('0x000000000000000000000000Ac997b1723b497Aa7694D4a402Dd34943df81B20');
const OLD_CHANNEL  = '0:445B4A01F30CC68DE147F8D99A6D9C2D498637B1C229C279546E90B56572817B';

const TON_EID = 40343n;
const ARB_EID = 40231n;

async function main() {
    const client = new TonClient({
        endpoint: 'https://testnet.toncenter.com/api/v2/jsonRPC',
        apiKey: process.env.TONCENTER_API_KEY,
    });

    const endpointAddr = Address.parse(ENDPOINT);
    const oappAddr     = Address.parse(NEW_OAPP);

    // ── 1. Endpoint code hash: live vs SDK ──────────────────────────────────
    console.log('\n=== 1. Endpoint code hash ===');
    const epState = await client.getContractState(endpointAddr);
    if (!epState.data || !epState.code) throw new Error('Endpoint: no state');

    const epData = Cell.fromBoc(epState.data)[0];
    const epCode = Cell.fromBoc(epState.code)[0];

    const liveEpCodeHash = epCode.hash().toString('hex');
    // SDK bundled codes (v0.59 @ton/core) — use BOC roundtrip to get hash
    const sdkEpBoc  = (getCompiledCode('Endpoint') as unknown as { toBoc(): Buffer }).toBoc();
    const sdkEpHash = Cell.fromBoc(sdkEpBoc)[0].hash().toString('hex');
    const sdkChBoc  = (getCompiledCode('Channel') as unknown as { toBoc(): Buffer }).toBoc();
    const sdkChHash = Cell.fromBoc(sdkChBoc)[0].hash().toString('hex');

    console.log('Live Endpoint code hash :', liveEpCodeHash);
    console.log('SDK  Endpoint code hash :', sdkEpHash);
    console.log('Code match              :', liveEpCodeHash === sdkEpHash ? '✅ YES (same)' : '❌ NO — Endpoint was upgraded');
    console.log('\nSDK Channel code hash   :', sdkChHash);

    // ── 2. Endpoint storage structure ────────────────────────────────────────
    console.log('\n=== 2. Endpoint storage structure (live) ===');
    console.log('Root: bits=' + epData.bits.length + ' refs=' + epData.refs.length);
    for (let i = 0; i < epData.refs.length; i++) {
        const r = epData.refs[i];
        console.log(`  ref[${i}] bits=${r.bits.length} refs=${r.refs.length} hash=${r.hash().toString('hex').slice(0,16)}...`);
        for (let j = 0; j < r.refs.length; j++) {
            const rr = r.refs[j];
            const codeLike = rr.bits.length > 0 || rr.refs.length > 0;
            const isSdkChan = rr.hash().toString('hex') === sdkChHash;
            console.log(`    ref[${i}][${j}] bits=${rr.bits.length} refs=${rr.refs.length} hash=${rr.hash().toString('hex').slice(0,16)}... ${isSdkChan ? '← SDK Channel code ✅' : ''}`);
        }
    }

    // channelCode in Endpoint is one of the top-level refs (per SDK schema: Endpoint::channelCode)
    // Walk all cells up to depth 3 to find channelCode by hash comparison
    let liveChannelCodeHash = '';
    function searchForChannelCode(cell: Cell, depth: number, path: string) {
        const h = cell.hash().toString('hex');
        if (depth === 1 || depth === 2) { // channelCode is a direct ref of Endpoint data or once nested
            // We'll just record all refs at depth=1 and depth=2 for inspection
        }
        if (h === sdkChHash) {
            console.log(`\n  ✅ SDK Channel code found in Endpoint storage at path: ${path}`);
            liveChannelCodeHash = h;
        }
        if (depth < 3) {
            cell.refs.forEach((r, i) => searchForChannelCode(r, depth + 1, `${path}.ref[${i}]`));
        }
    }
    searchForChannelCode(epData, 0, 'root');
    if (!liveChannelCodeHash) {
        console.log('\n  ❌ SDK Channel code NOT found in Endpoint storage — Endpoint uses a DIFFERENT channelCode');
        // Show hash of all depth-1 refs (candidates for channelCode)
        console.log('  Depth-1 ref hashes (candidates):');
        epData.refs.forEach((r, i) => console.log(`    ref[${i}]: ${r.hash().toString('hex')}`));
    }

    // ── 3. Build path cell via SDK ───────────────────────────────────────────
    console.log('\n=== 3. Path cell (srcOApp=NEW_OAPP dstEid=40231) ===');
    const srcOAppHash = addressToBigInt(NEW_OAPP);
    // buildPathClass uses SDK's @ton/core — BOC roundtrip to get @ton/core@0.63 Cell
    const sdkPathBoc = (buildPathClass({
        srcEid:  TON_EID,
        srcOApp: srcOAppHash,
        dstEid:  ARB_EID,
        dstOApp: VAULT_PADDED,
    }) as unknown as { toBoc(): Buffer }).toBoc();
    const pathCell = Cell.fromBoc(sdkPathBoc)[0];
    console.log('Path cell: bits=' + pathCell.bits.length + ' refs=' + pathCell.refs.length);
    console.log('srcEid=' + TON_EID + ' dstEid=' + ARB_EID);
    console.log('srcOApp:', srcOAppHash.toString(16).padStart(64, '0'));
    console.log('dstOApp:', VAULT_PADDED.toString(16).padStart(64, '0'));

    // ── 4. Call get_getChannelAddress on live Endpoint ───────────────────────
    console.log('\n=== 4. get_getChannelAddress (live Endpoint getter) ===');
    let computedChannelHash: bigint | null = null;
    try {
        const result = await client.runMethod(endpointAddr, 'get_getChannelAddress', [
            { type: 'cell', cell: epData },
            { type: 'cell', cell: pathCell },
        ]);
        computedChannelHash = result.stack.readBigNumber();
        const computedRaw  = '0:' + computedChannelHash.toString(16).padStart(64, '0');
        const computedFriendly = Address.parseRaw(computedRaw).toString({ testOnly: true });
        console.log('Computed Channel (raw)     :', computedRaw);
        console.log('Computed Channel (friendly):', computedFriendly);
        console.log('Old bounce Channel  (raw)  :', OLD_CHANNEL);
        const same = computedRaw.toLowerCase() === OLD_CHANNEL.toLowerCase();
        console.log('Addresses match            :', same ? '✅ SAME — address unchanged' : '❌ DIFFERENT — channelCode changed, new address');
    } catch (e: any) {
        console.log('runMethod get_getChannelAddress failed:', e.message);
        console.log('(Endpoint may not expose this getter by this name)');
    }

    // ── 5. Check computed Channel status ────────────────────────────────────
    if (computedChannelHash !== null) {
        const computedRaw  = '0:' + computedChannelHash.toString(16).padStart(64, '0');
        console.log('\n=== 5. Computed Channel on-chain status ===');
        const chanState = await client.getContractState(Address.parseRaw(computedRaw));
        console.log('State:', chanState.state);
        console.log('Balance:', chanState.balance?.toString() ?? '0', 'nanoTON');
        if (chanState.state === 'active') {
            console.log('✅ Channel IS deployed at computed address!');
        } else {
            console.log('❌ Channel NOT deployed at computed address');
        }
    }

    // ── 6. Sanity: old Channel still nonexist? ────────────────────────────────
    console.log('\n=== 6. Old Channel (0:445B4A01...) status ===');
    const oldChanState = await client.getContractState(Address.parseRaw(OLD_CHANNEL));
    console.log('State:', oldChanState.state);

    // ── 7. OApp storage — check embedded channelCode hash ────────────────────
    console.log('\n=== 7. OApp embedded channelCode ===');
    const oappState = await client.getContractState(oappAddr);
    if (!oappState.data) { console.log('OApp: no data'); return; }
    const oappData = Cell.fromBoc(oappState.data)[0];
    console.log('OApp root: bits=' + oappData.bits.length + ' refs=' + oappData.refs.length);

    let oappSdkChannelFound = false;
    function searchOApp(cell: Cell, depth: number, path: string) {
        const h = cell.hash().toString('hex');
        if (h === sdkChHash) {
            console.log(`  ✅ SDK Channel code found in OApp at: ${path}`);
            oappSdkChannelFound = true;
        }
        if (!liveChannelCodeHash && computedChannelHash !== null) {
            // If we know live channelCode is different, check if OApp has the live one too
        }
        if (depth < 4) {
            cell.refs.forEach((r, i) => searchOApp(r, depth + 1, `${path}.ref[${i}]`));
        }
    }
    searchOApp(oappData, 0, 'root');
    if (!oappSdkChannelFound) {
        console.log('  ❌ SDK Channel code NOT found in OApp — OApp has a DIFFERENT channelCode baked in');
    }

    // Print OApp ref structure for reference
    oappData.refs.forEach((r, i) => {
        console.log(`  OApp ref[${i}]: bits=${r.bits.length} refs=${r.refs.length} hash=${r.hash().toString('hex').slice(0,16)}...`);
        r.refs.forEach((rr, j) => {
            const isSdkChan = rr.hash().toString('hex') === sdkChHash;
            console.log(`    OApp ref[${i}][${j}]: bits=${rr.bits.length} refs=${rr.refs.length} hash=${rr.hash().toString('hex').slice(0,16)}... ${isSdkChan ? '← SDK Channel ✅' : ''}`);
        });
    });

    // ── Summary ──────────────────────────────────────────────────────────────
    console.log('\n══════════════════════════ DIAGNOSIS ══════════════════════════');
    if (computedChannelHash !== null) {
        const computedRaw = '0:' + computedChannelHash.toString(16).padStart(64, '0');
        const same = computedRaw.toLowerCase() === OLD_CHANNEL.toLowerCase();
        const chanState = await client.getContractState(Address.parseRaw(computedRaw));
        const deployed  = chanState.state === 'active';

        if (same && !deployed) {
            console.log('STATUS: Channel address UNCHANGED and still NONEXIST');
            console.log('CONCLUSION: LZ testnet Channel for this path is not deployed yet.');
            console.log('ACTION: Wait for LZ team to deploy Channel, or try triggering via another lzSend.');
        } else if (!same && !deployed) {
            console.log('STATUS: Channel address CHANGED (Endpoint updated), new Channel also NONEXIST');
            console.log('CONCLUSION: Endpoint was updated, Channel needs re-deployment at new address.');
            console.log('ACTION: Try a real hop — new Endpoint may now provide StateInit to auto-deploy Channel.');
            console.log('        If still bounces, LZ still needs to init Channel for new path config.');
        } else if (deployed) {
            console.log('STATUS: Channel IS deployed at current computed address ✅');
            console.log('CONCLUSION: Previous blocker is RESOLVED. Try real hop now.');
        }
        if (liveEpCodeHash !== sdkEpHash) {
            console.log('\nNOTE: Endpoint code was upgraded. Our OApp baked in OLD channelCode.');
            if (!oappSdkChannelFound) {
                console.log('      OApp channelCode also differs from SDK — but this is cosmetic (OApp stores it for reference only).');
                console.log('      The Endpoint is the authority for Channel address computation.');
            }
        }
    } else {
        console.log('Could not compute Channel address — runMethod failed. Check logs above.');
    }
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
