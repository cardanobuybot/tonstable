// @ts-nocheck
/**
 * Channel diagnostics using pre-fetched BOC from tonapi.io
 * No TonClient needed for the main computation.
 */
const fs   = require('fs');
const path = require('path');
const sdk  = require('@layerzerolabs/lz-ton-sdk-v2');
const { Address, Cell, contractAddress } = require('@ton/core');
const https = require('https');

const OLD_CHANNEL = '0:445b4a01f30cc68de147f8d99a6d9c2d498637b1c229c279546e90b56572817b';
const NEW_OAPP    = 'EQA2SPLtbQGkijeadXNHdhO3swGIJCBK_4LhFcJBHKV6_9BK';
const ENDPOINT    = 'EQDFTTIsLOLMxfeMpkeaYx5UIY8RZcOoDArQBfqTZ7H-6Ybs';
const VAULT_PAD   = BigInt('0x000000000000000000000000Ac997b1723b497Aa7694D4a402Dd34943df81B20');
const TON_EID     = 40343n;
const ARB_EID     = 40231n;
const TONAPI_BASE = 'https://testnet.tonapi.io/v2';

// Simple HTTPS GET returning JSON
function httpsGet(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'Accept': 'application/json' } }, res => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error('JSON parse: ' + data.slice(0, 200))); }
            });
        }).on('error', reject);
    });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// BOC roundtrip: SDK @ton/core@0.59 Cell → @ton/core@0.63 Cell
function sdkToLocal(sdkCell) {
    const boc = sdkCell.toBoc ? sdkCell.toBoc() : Buffer.from(sdkCell);
    return Cell.fromBoc(boc)[0];
}

async function checkAddr(rawAddr) {
    try {
        const url = TONAPI_BASE + '/accounts/' + encodeURIComponent(Address.parseRaw(rawAddr).toString({ testOnly: true }));
        const d = await httpsGet(url);
        return { state: d.status ?? 'unknown', balance: d.balance ?? 0 };
    } catch (e) { return { state: 'error: ' + e.message, balance: 0 }; }
}

async function main() {
    // ── 1. Load pre-fetched Endpoint BOC ─────────────────────────────────────
    console.log('\n=== 1. Load Endpoint BOC (/tmp/ep_code.boc, /tmp/ep_data.boc) ===');
    const epCodeBuf = fs.readFileSync('/tmp/ep_code.boc');
    const epDataBuf = fs.readFileSync('/tmp/ep_data.boc');
    const epCode    = Cell.fromBoc(epCodeBuf)[0];
    const epData    = Cell.fromBoc(epDataBuf)[0];

    const liveEpHash  = epCode.hash().toString('hex');
    const sdkEpHash   = sdkToLocal(sdk.getCompiledCode('Endpoint')).hash().toString('hex');
    const sdkChHash   = sdkToLocal(sdk.getCompiledCode('Channel')).hash().toString('hex');

    console.log('Live Endpoint code hash:', liveEpHash);
    console.log('SDK  Endpoint code hash:', sdkEpHash);
    console.log('Endpoint upgraded      :', liveEpHash !== sdkEpHash ? '❌ YES' : '✅ NO (same)');
    console.log('SDK  Channel code hash :', sdkChHash);

    // ── 2. Inspect Endpoint data structure ───────────────────────────────────
    console.log('\n=== 2. Endpoint data refs ===');
    console.log('Root: bits=' + epData.bits.length + ' refs=' + epData.refs.length);

    let channelCodeCell = null;
    let channelStorInitCell = null;

    epData.refs.forEach((r, i) => {
        const h = r.hash().toString('hex');
        console.log(`  ref[${i}]: bits=${r.bits.length} refs=${r.refs.length} hash=${h.slice(0,16)}...`);
        r.refs.forEach((rr, j) => {
            const hh = rr.hash().toString('hex');
            const isChan = hh === sdkChHash;
            console.log(`    ref[${i}][${j}]: bits=${rr.bits.length} refs=${rr.refs.length} hash=${hh.slice(0,16)}... ${isChan ? '← channelCode ✅' : ''}`);
            if (isChan) channelCodeCell = rr;
            // channelStorageInit is right after channelCode in the same parent
            if (channelCodeCell && channelCodeCell === r.refs[j-1]) {
                channelStorInitCell = rr;
            }
        });
    });

    // ref[2] should have channelCode at [0] and channelStorInit at [1]
    if (!channelStorInitCell && epData.refs.length >= 3) {
        const ep2 = epData.refs[2];
        if (ep2.refs.length >= 2) {
            if (!channelCodeCell) channelCodeCell = ep2.refs[0];
            channelStorInitCell = ep2.refs[1];
            console.log('\nchannelCode (ref[2][0]) hash:', ep2.refs[0].hash().toString('hex'));
            console.log('channelStorInit (ref[2][1]) hash:', ep2.refs[1].hash().toString('hex'));
            console.log('channelStorInit bits:', ep2.refs[1].bits.length, 'refs:', ep2.refs[1].refs.length);
        }
    }

    // ── 3. Build path cell & compute Channel address via SDK local TVM ────────
    console.log('\n=== 3. Compute Channel address (SDK protocolEndpoint.get_getChannelAddress) ===');

    const srcOAppHash = sdk.addressToBigInt(NEW_OAPP);
    const sdkPathCell = sdk.buildPathClass({
        srcEid:  TON_EID,
        srcOApp: srcOAppHash,
        dstEid:  ARB_EID,
        dstOApp: VAULT_PAD,
    });

    console.log('Path built: bits=' + sdkPathCell.bits.length);

    let computedRaw = null;

    // Approach A: TonContractWrapper.create with SDK cells
    try {
        const sdkEpCode = sdk.getCompiledCode('Endpoint');
        // Use hexToCells to create SDK Cell from live data BOC
        const sdkEpData = sdk.hexToCells(epDataBuf.toString('hex'))[0];

        const wrapper = sdk.TonContractWrapper.create(sdkEpCode, sdkEpData);

        console.log('TonContractWrapper created ✅');

        // get_getChannelAddress(contract, storage, path)
        const [channelHash] = await sdk.protocolEndpoint.get_getChannelAddress(
            wrapper,
            sdkEpData,
            sdkPathCell,
        );

        computedRaw = '0:' + channelHash.toString(16).padStart(64, '0');
        console.log('Computed Channel (raw):', computedRaw);
        const friendly = Address.parseRaw(computedRaw).toString({ testOnly: true });
        console.log('Computed Channel (friendly):', friendly);
    } catch (e) {
        console.log('Approach A (TonContractWrapper) failed:', e.message);

        // Approach B: try with wrapper object that has runGetMethod
        try {
            const sdkEpCode = sdk.getCompiledCode('Endpoint');
            const sdkEpData = sdk.hexToCells(epDataBuf.toString('hex'))[0];
            const wrapper = sdk.TonContractWrapper.create(sdkEpCode, sdkEpData);

            // Try the instance method if it exists
            const result = await sdk.protocolEndpoint.get_getChannelAddress(
                { runGetMethod: async (name, args) => wrapper.runGetMethod(name, args) },
                sdkEpData,
                sdkPathCell,
            );
            const [channelHash] = result;
            computedRaw = '0:' + channelHash.toString(16).padStart(64, '0');
            console.log('Approach B result:', computedRaw);
        } catch (e2) {
            console.log('Approach B also failed:', e2.message);

            // Approach C: compute contractAddress from channelCode + channelStorInit directly
            // (assumes no path customization, or template IS the full init)
            if (channelCodeCell && channelStorInitCell) {
                console.log('\nApproach C: contractAddress(channelCode, channelStorInit) — no path customization:');
                const addr = contractAddress(0, { code: channelCodeCell, data: channelStorInitCell });
                console.log('Result (no-path):', addr.toRaw());
                console.log('(This ignores path customization — may not match live behavior)');
            }
        }
    }

    console.log('\nOld bounce address:', OLD_CHANNEL);
    if (computedRaw) {
        const same = computedRaw.toLowerCase() === OLD_CHANNEL.toLowerCase();
        console.log('Same as old       :', same ? '✅ YES (unchanged)' : '❌ NO (changed)');
    }

    // ── 4. Check Channel status via tonapi.io ────────────────────────────────
    if (computedRaw) {
        console.log('\n=== 4. Computed Channel status (tonapi.io) ===');
        await sleep(300);
        const st = await checkAddr(computedRaw);
        console.log('State  :', st.state);
        console.log('Balance:', st.balance, 'nanoTON');
        console.log(st.state === 'active' ? '✅ DEPLOYED' : '❌ NOT deployed');
    }

    // ── 5. Old Channel status ────────────────────────────────────────────────
    console.log('\n=== 5. Old Channel (0:445B4A01...) status ===');
    await sleep(300);
    const oldSt = await checkAddr(OLD_CHANNEL);
    console.log('State:', oldSt.state);

    // ── 6. OApp channelCode check ────────────────────────────────────────────
    console.log('\n=== 6. OApp (EQA2SPLt...) embedded channelCode ===');
    await sleep(300);
    let oappComputedRaw = null;
    try {
        const oappUrl = TONAPI_BASE + '/blockchain/accounts/' + encodeURIComponent(NEW_OAPP);
        const oappAcc = await httpsGet(oappUrl);
        if (oappAcc.data) {
            const oappDataBuf = Buffer.from(oappAcc.data, 'base64');
            const oappData = Cell.fromBoc(oappDataBuf)[0];
            console.log('OApp root: bits=' + oappData.bits.length + ' refs=' + oappData.refs.length);

            let oappChFound = false;
            function walkOApp(cell, depth, label) {
                if (cell.hash().toString('hex') === sdkChHash) {
                    console.log('✅ SDK channelCode in OApp at:', label);
                    oappChFound = true;
                }
                if (depth < 4) cell.refs.forEach((r, i) => walkOApp(r, depth+1, label+'.ref['+i+']'));
            }
            walkOApp(oappData, 0, 'root');
            if (!oappChFound) {
                console.log('❌ SDK channelCode NOT in OApp — OApp baked different channelCode');
                // Show structure
                oappData.refs.forEach((r, i) => {
                    console.log(`  OApp ref[${i}]: bits=${r.bits.length} refs=${r.refs.length} hash=${r.hash().toString('hex').slice(0,16)}...`);
                    r.refs.forEach((rr, j) => {
                        console.log(`    OApp ref[${i}][${j}]: bits=${rr.bits.length} refs=${rr.refs.length} hash=${rr.hash().toString('hex').slice(0,16)}...`);
                    });
                });
            }

            // Also compute what Channel address our OApp "thinks" it should use
            // by extracting its own channelCode and endpointCode
            // BaseOApp ref structure: [endpointCode, channelCode, ...] or similar
            if (!oappChFound && oappData.refs.length >= 2) {
                console.log('\n  Checking OApp baseOApp ref for channelCode:');
                const baseOApp = oappData.refs[1]; // second ref = baseOApp
                baseOApp.refs.forEach((r, i) => {
                    console.log(`    baseOApp ref[${i}]: bits=${r.bits.length} refs=${r.refs.length} hash=${r.hash().toString('hex').slice(0,16)}...`);
                });
            }
        } else {
            console.log('No data field in OApp response');
        }
    } catch (e) {
        console.log('OApp check failed:', e.message);
    }

    // ── 7. Recent Endpoint transactions ─────────────────────────────────────
    console.log('\n=== 7. Recent Endpoint transactions (looking for Channel init) ===');
    await sleep(300);
    try {
        const txUrl = TONAPI_BASE + '/blockchain/accounts/' + encodeURIComponent(ENDPOINT) + '/transactions?limit=10';
        const txResp = await httpsGet(txUrl);
        const txs = txResp.transactions ?? [];
        console.log('Recent transactions:', txs.length);
        for (const tx of txs.slice(0, 5)) {
            const lt   = tx.lt;
            const hash = tx.hash?.slice(0, 16) ?? '?';
            const inMsg = tx.in_msg;
            const outs  = tx.out_msgs?.length ?? 0;
            const success = tx.success ? '✅' : '❌';
            const exitCode = tx.compute_phase?.exit_code ?? '?';
            let inOp = '?';
            if (inMsg?.raw_body) {
                try {
                    const body = Cell.fromBoc(Buffer.from(inMsg.raw_body, 'hex'))[0].beginParse();
                    if (body.remainingBits >= 32) inOp = '0x' + body.loadUint(32).toString(16);
                } catch (_) {}
            }
            console.log(`  lt=${lt} hash=${hash} inOp=${inOp} outs=${outs} exit=${exitCode} ${success}`);
        }
    } catch (e) {
        console.log('Transaction fetch failed:', e.message);
    }

    // ── Summary ──────────────────────────────────────────────────────────────
    console.log('\n══════════════════════ DIAGNOSIS ══════════════════════');
    console.log('Endpoint code = SDK   :', liveEpHash === sdkEpHash ? '✅ YES' : '❌ NO (upgraded)');
    console.log('channelCode in Endpoint = SDK Channel:', channelCodeCell ? '✅ YES' : '❌ NO (different code)');
    if (computedRaw) {
        const same = computedRaw.toLowerCase() === OLD_CHANNEL.toLowerCase();
        const st = await checkAddr(computedRaw);
        console.log('Channel address changed :', same ? 'NO (same)' : 'YES → new=' + computedRaw);
        console.log('Channel deployed        :', st.state === 'active' ? '✅ YES' : '❌ NO');

        if (same && st.state !== 'active') {
            console.log('\nCONCLUSION: Channel address UNCHANGED, still not deployed.');
            console.log('The Endpoint computes the same address as before.');
            console.log('LZ needs to deploy/initialize Channel for this path on testnet.');
        } else if (!same && st.state !== 'active') {
            console.log('\nCONCLUSION: Channel address changed (new Endpoint config), but new Channel also not deployed yet.');
            console.log('Try another lzSend — Endpoint may now auto-deploy Channel (if it sends StateInit).');
        } else if (st.state === 'active') {
            console.log('\nCONCLUSION: Channel IS DEPLOYED at', computedRaw);
            console.log('ACTION: Try real hop — should work now!');
        }
    } else {
        console.log('\nCould not compute Channel address via local TVM.');
        console.log('Manual approach: look at how Endpoint customizes channelStorageInit with path.');
        console.log('Key fact: channelCode in live Endpoint = SDK Channel code ✅ (same as at OApp deploy).');
    }
}

main().catch(e => { console.error('FATAL:', e.message, '\n', e.stack?.split('\n').slice(0,5).join('\n')); process.exit(1); });
