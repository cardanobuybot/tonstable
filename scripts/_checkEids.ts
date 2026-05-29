/**
 * Check which dstEids are supported on LZ TON testnet.
 * Equivalent of isSupportedEid() — checks if a Uln is deployed by UlnManager for each dstEid.
 * Also reads Endpoint storage to inspect channelCode.
 */
import { TonClient } from '@ton/ton';
import { Address, Cell } from '@ton/core';

// Known LZ testnet addresses
const ULN_MANAGER = 'EQC0tTlvumGHvKzMHPODV7ARp3DLIV4P_zXeZ-SQ7MO0kCMC';
const ENDPOINT    = 'EQDFTTIsLOLMxfeMpkeaYx5UIY8RZcOoDArQBfqTZ7H-6Ybs';

const EIDS_TO_CHECK = [
    { eid: 40161, label: 'Sepolia ETH' },
    { eid: 40231, label: 'Arb Sepolia' },
    { eid: 40232, label: 'Optimism Sepolia' },
    { eid: 40245, label: 'Base Sepolia' },
    { eid: 40102, label: 'BSC testnet' },
];

async function main() {
    const client = new TonClient({
        endpoint: 'https://testnet.toncenter.com/api/v2/jsonRPC',
        apiKey: process.env.TONCENTER_API_KEY,
    });

    const ulnManagerAddr = Address.parse(ULN_MANAGER);
    const endpointAddr   = Address.parse(ENDPOINT);

    // ── 1. Read Endpoint storage — check channelCode ─────────────────────────
    console.log('\n=== Endpoint storage ===');
    const epState = await client.getContractState(endpointAddr);
    if (!epState.data) { console.log('Endpoint: no data'); return; }
    const epCell = Cell.fromBoc(epState.data)[0];
    console.log('Endpoint cell bits:', epCell.bits.length, 'refs:', epCell.refs.length);
    // The first ref [0] is baseStorage; subsequent fields follow the Endpoint layout.
    // channelCode is typically stored in a ref or as an inline field.
    // Print top-level cell structure for manual inspection.
    for (let i = 0; i < epCell.refs.length; i++) {
        const ref = epCell.refs[i];
        console.log(`  ref[${i}] bits:${ref.bits.length} refs:${ref.refs.length} hash:${ref.hash().toString('hex').slice(0,16)}...`);
    }

    // ── 2. Get UlnManager storage ────────────────────────────────────────────
    console.log('\n=== UlnManager storage ===');
    const ulmState = await client.getContractState(ulnManagerAddr);
    if (!ulmState.data) { console.log('UlnManager: no data'); return; }
    const ulmStorageCell = Cell.fromBoc(ulmState.data)[0];
    console.log('UlnManager cell bits:', ulmStorageCell.bits.length, 'refs:', ulmStorageCell.refs.length);

    // ── 3. For each dstEid: compute Uln address and check deployment ─────────
    console.log('\n=== Uln deployment per dstEid ===');
    console.log('(isSupportedEid equivalent: is a Uln deployed for this dstEid?)\n');

    const results: { eid: number; label: string; ulnAddr: string; deployed: boolean }[] = [];

    for (const { eid, label } of EIDS_TO_CHECK) {
        try {
            // Call UlnManager getter: _calculateUlnAddress(storage: Cell, dstEid: int) → int
            const result = await client.runMethod(ulnManagerAddr, '_calculateUlnAddress', [
                { type: 'cell', cell: ulmStorageCell },
                { type: 'int', value: BigInt(eid) },
            ]);
            const ulnHash = result.stack.readBigNumber();
            // Convert: bigint is the raw hash, workchain=0
            const ulnRaw = '0:' + ulnHash.toString(16).padStart(64, '0');
            const ulnAddr = Address.parseRaw(ulnRaw).toString();

            // Check if Uln is deployed
            const ulnState = await client.getContractState(Address.parseRaw(ulnRaw));
            const deployed = ulnState.state === 'active';

            results.push({ eid, label, ulnAddr, deployed });
            console.log(`EID ${eid} (${label}): Uln=${ulnAddr}`);
            console.log(`  → isSupportedEid = ${deployed ? 'TRUE ✅' : 'FALSE ❌'} (state=${ulnState.state})`);
        } catch (e: any) {
            console.log(`EID ${eid} (${label}): ERROR — ${e.message}`);
            results.push({ eid, label, ulnAddr: 'error', deployed: false });
        }
    }

    // ── 4. Summary ─────────────────────────────────────────────────────────
    console.log('\n=== Summary ===');
    const supported = results.filter(r => r.deployed);
    console.log(`isSupportedEid(40231) = ${results.find(r => r.eid === 40231)?.deployed ?? 'error'}`);
    console.log(`\nPaths with Uln deployed (potential workaround destinations):`);
    if (supported.length === 0) {
        console.log('  NONE — no EID has a deployed Uln on LZ TON testnet');
    } else {
        for (const r of supported) {
            console.log(`  EID ${r.eid} (${r.label})`);
        }
    }
}

main().catch(e => { console.error(e.message); process.exit(1); });
