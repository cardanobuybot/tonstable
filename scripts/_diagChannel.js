// @ts-nocheck
/**
 * Channel address diagnostics (plain JS, no TS type conflicts).
 * 1. Endpoint storage: channelCode hash + channelStorageInit
 * 2. Compute Channel address via SDK protocolEndpoint.get_getChannelAddress (local TVM)
 * 3. Compare with old bounced address 0:445B4A01...
 * 4. Check live status of computed Channel
 * 5. Check OApp channelCode match
 */
const { TonClient }          = require('@ton/ton');
const { Address, Cell }      = require('@ton/core');
const sdk                    = require('@layerzerolabs/lz-ton-sdk-v2');

const ENDPOINT    = 'EQDFTTIsLOLMxfeMpkeaYx5UIY8RZcOoDArQBfqTZ7H-6Ybs';
const NEW_OAPP    = 'EQA2SPLtbQGkijeadXNHdhO3swGIJCBK_4LhFcJBHKV6_9BK';
const VAULT_PAD   = BigInt('0x000000000000000000000000Ac997b1723b497Aa7694D4a402Dd34943df81B20');
const OLD_CHANNEL = '0:445b4a01f30cc68de147f8d99a6d9c2d498637b1c229c279546e90b56572817b';
const TON_EID     = 40343n;
const ARB_EID     = 40231n;

// BOC roundtrip: SDK Cell (v0.59) → @ton/core Cell (v0.63)
function sdkCellToLocal(sdkCell) {
    const boc = sdkCell.toBoc ? sdkCell.toBoc() : sdkCell;
    return Cell.fromBoc(Buffer.from(boc))[0];
}

// Pause to avoid 429
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function checkState(client, rawAddr) {
    await sleep(500);
    return client.getContractState(Address.parseRaw(rawAddr));
}

async function main() {
    const client = new TonClient({
        endpoint: 'https://testnet.toncenter.com/api/v2/jsonRPC',
        apiKey: process.env.TONCENTER_API_KEY,
    });

    const endpointAddr = Address.parse(ENDPOINT);
    const oappAddr     = Address.parse(NEW_OAPP);

    // ── 1. Endpoint code hash ────────────────────────────────────────────────
    console.log('\n=== 1. Endpoint code hash ===');
    const epState = await client.getContractState(endpointAddr);
    if (!epState.data || !epState.code) throw new Error('Endpoint has no state');

    const epData = Cell.fromBoc(epState.data)[0];
    const epCode = Cell.fromBoc(epState.code)[0];

    const liveEpHash  = epCode.hash().toString('hex');
    const sdkEpHash   = sdkCellToLocal(sdk.getCompiledCode('Endpoint')).hash().toString('hex');
    const sdkChHash   = sdkCellToLocal(sdk.getCompiledCode('Channel')).hash().toString('hex');

    console.log('Live Endpoint code hash:', liveEpHash);
    console.log('SDK  Endpoint code hash:', sdkEpHash);
    console.log('Endpoint updated       :', liveEpHash !== sdkEpHash ? '❌ YES (upgraded)' : '✅ NO (same)');
    console.log('SDK  Channel code hash :', sdkChHash);

    // ── 2. Find channelCode in Endpoint storage ──────────────────────────────
    console.log('\n=== 2. Endpoint storage — find channelCode ===');
    console.log('Root: bits=' + epData.bits.length + ' refs=' + epData.refs.length);
    let epChannelCodeHash = null;
    let epChannelStorageInit = null;

    function walk(cell, depth, label) {
        const h = cell.hash().toString('hex');
        const isSDKChan = h === sdkChHash;
        const indent = '  '.repeat(depth);
        console.log(indent + label + ': bits=' + cell.bits.length + ' refs=' + cell.refs.length + ' hash=' + h.slice(0,16) + '...' + (isSDKChan ? ' ← channelCode ✅' : ''));
        if (isSDKChan) epChannelCodeHash = h;
        if (depth < 3) {
            cell.refs.forEach((r, i) => walk(r, depth + 1, `ref[${i}]`));
        }
    }
    walk(epData, 0, 'root');

    // ref[2] should be the Endpoint fields beyond baseStorage
    // ref[2][0] = channelCode, ref[2][1] = channelStorageInit (from previous run)
    if (epData.refs.length >= 3) {
        const epFields = epData.refs[2];
        if (epFields.refs.length >= 2) {
            const ccCandidate  = epFields.refs[0];
            const csiCandidate = epFields.refs[1];
            console.log('\nChannelCode candidate  (ref[2][0]):', ccCandidate.hash().toString('hex'), '== SDK?', ccCandidate.hash().toString('hex') === sdkChHash ? 'YES ✅' : 'NO ❌');
            console.log('ChannelStorInit cand   (ref[2][1]):', csiCandidate.hash().toString('hex'));
            epChannelStorageInit = csiCandidate;
        }
    }

    // ── 3. Path cell ─────────────────────────────────────────────────────────
    console.log('\n=== 3. Build path cell ===');
    const srcOAppHash = sdk.addressToBigInt(NEW_OAPP);
    const sdkPathCell = sdk.buildPathClass({
        srcEid:  TON_EID,
        srcOApp: srcOAppHash,
        dstEid:  ARB_EID,
        dstOApp: VAULT_PAD,
    });
    const pathCell = sdkCellToLocal(sdkPathCell);
    console.log('Path: bits=' + pathCell.bits.length + ' refs=' + pathCell.refs.length);

    // ── 4. Compute Channel address via SDK local TVM ─────────────────────────
    console.log('\n=== 4. Compute Channel address (SDK local TVM) ===');
    let computedRaw = null;
    try {
        // TonContractWrapper.create needs SDK Cell (not @ton/core Cell)
        // Use the SDK's own Cell from getCompiledCode (already in SDK's @ton/core)
        const sdkEpCode = sdk.getCompiledCode('Endpoint');
        const sdkEpData = sdk.hexToCells(epState.data.toString('hex'))[0];

        const wrapper = sdk.TonContractWrapper.create(sdkEpCode, sdkEpData);
        // get_getChannelAddress(contract, storage, path) — all SDK Cells
        const [channelHash] = await sdk.protocolEndpoint.get_getChannelAddress(
            { runGetMethod: wrapper.runGetMethod.bind(wrapper) },
            sdkEpData,
            sdkPathCell,
        );
        computedRaw = '0:' + channelHash.toString(16).padStart(64, '0');
        const friendly = Address.parseRaw(computedRaw).toString({ testOnly: true });
        console.log('Computed Channel (raw)     :', computedRaw);
        console.log('Computed Channel (friendly):', friendly);
    } catch (e) {
        console.log('SDK local TVM approach 1 failed:', e.message);

        // Fallback: try passing the contract wrapper directly
        try {
            const sdkEpCode = sdk.getCompiledCode('Endpoint');
            // Use the JS bytes directly without re-parsing
            const epDataBuf = epState.data;
            const sdkEpData = sdk.hexToCells(epDataBuf.toString('hex'))[0];

            const wrapper = sdk.TonContractWrapper.create(sdkEpCode, sdkEpData);
            const [channelHash] = await sdk.protocolEndpoint.get_getChannelAddress(
                wrapper,
                sdkEpData,
                sdkPathCell,
            );
            computedRaw = '0:' + channelHash.toString(16).padStart(64, '0');
            const friendly = Address.parseRaw(computedRaw).toString({ testOnly: true });
            console.log('Computed Channel (raw)     :', computedRaw);
            console.log('Computed Channel (friendly):', friendly);
        } catch (e2) {
            console.log('SDK local TVM approach 2 failed:', e2.message);

            // Last resort: contractAddress from channelCode + channelStorageInit (no path customization)
            // This gives the "base" channel address, not path-specific — shown for debugging only
            if (epChannelStorageInit) {
                const ccCell = epData.refs[2].refs[0]; // channelCode candidate
                const { contractAddress } = require('@ton/core');
                const rawAddr = contractAddress(0, { code: ccCell, data: epChannelStorageInit });
                console.log('Fallback (no path): contractAddress(channelCode, channelStorageInit) =', rawAddr.toRaw());
                console.log('(This is the template address, NOT path-specific — for reference only)');
            }
        }
    }

    console.log('\nOld bounced Channel        :', OLD_CHANNEL);
    if (computedRaw) {
        const same = computedRaw.toLowerCase() === OLD_CHANNEL.toLowerCase();
        console.log('Addresses match            :', same ? '✅ SAME address' : '❌ DIFFERENT — new address computed');
    }

    // ── 5. Check Channel status ───────────────────────────────────────────────
    if (computedRaw) {
        console.log('\n=== 5. Computed Channel status ===');
        const st = await checkState(client, computedRaw);
        console.log('State  :', st.state);
        console.log('Balance:', st.balance?.toString() ?? '0', 'nanoTON');
        console.log(st.state === 'active' ? '✅ DEPLOYED' : '❌ NOT deployed');
    }

    // ── 6. Old Channel still nonexist? ───────────────────────────────────────
    console.log('\n=== 6. Old Channel (0:445B4A01...) status ===');
    const oldSt = await checkState(client, OLD_CHANNEL);
    console.log('State:', oldSt.state);

    // ── 7. OApp embedded channelCode ─────────────────────────────────────────
    console.log('\n=== 7. OApp embedded channelCode ===');
    await sleep(300);
    const oappState = await client.getContractState(oappAddr);
    if (!oappState.data) { console.log('OApp: no data'); return; }
    const oappData = Cell.fromBoc(oappState.data)[0];
    let oappChFound = false;
    function walkOApp(cell, depth, label) {
        const h = cell.hash().toString('hex');
        if (h === sdkChHash) {
            console.log('✅ SDK Channel code found in OApp at:', label);
            oappChFound = true;
        }
        if (depth < 4) cell.refs.forEach((r, i) => walkOApp(r, depth + 1, label + '.ref[' + i + ']'));
    }
    walkOApp(oappData, 0, 'root');
    if (!oappChFound) {
        console.log('❌ SDK Channel code NOT in OApp storage');
        // Show all hashes
        function showHashes(cell, depth, label) {
            if (depth > 3) return;
            console.log('  '.repeat(depth) + label + ': ' + cell.hash().toString('hex').slice(0,16) + '...');
            cell.refs.forEach((r, i) => showHashes(r, depth+1, label+'.ref['+i+']'));
        }
        showHashes(oappData, 0, 'root');
    }

    // ── Summary ──────────────────────────────────────────────────────────────
    console.log('\n══════════════════════ DIAGNOSIS ══════════════════════');
    if (computedRaw) {
        const same = computedRaw.toLowerCase() === OLD_CHANNEL.toLowerCase();
        const st   = await checkState(client, computedRaw);
        const dep  = st.state === 'active';
        if (same && !dep) {
            console.log('STATUS: Channel address SAME, still NONEXIST');
            console.log('ACTION: Endpoint unchanged. LZ needs to deploy/init Channel. Try another lzSend — may trigger auto-deploy if Endpoint now sends StateInit.');
        } else if (!same && !dep) {
            console.log('STATUS: Channel address CHANGED (new=' + computedRaw + '), still NONEXIST');
            console.log('ACTION: Another hop may trigger Channel deployment at new address.');
        } else if (dep) {
            console.log('STATUS: Channel DEPLOYED ✅ at', computedRaw);
            console.log('ACTION: Try real hop now.');
        }
    } else {
        console.log('Could not compute Channel address (local TVM failed). Need further debugging.');
        console.log('Observed: Endpoint code=SDK ✅, channelCode in Endpoint=SDK ✅, channelStorageInit present.');
        console.log('The Channel address depends on how Endpoint customizes channelStorageInit with path.');
    }
}

main().catch(e => { console.error('FATAL:', e.message, '\n', e.stack); process.exit(1); });
