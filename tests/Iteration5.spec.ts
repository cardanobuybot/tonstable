import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { beginCell, toNano } from '@ton/core';
import {
    TonstableMinter,
    DepositTon,
    MintConfirmation,
    PriceUpdate,
    ProposeOwner,
    AcceptOwnership,
    CancelOwnerProposal,
    WithdrawFees,
    SetPendingTimeout,
    SetMinDeposit,
} from '../wrappers/TonstableMinter';
import '@ton/test-utils';

const PRICE = 3_000_000_000n;
const NOW   = 1_700_000_000;

function emptyContent() {
    return beginCell().endCell();
}

describe('Iteration 5 — admin functions + ownership events', () => {
    let blockchain:    Blockchain;
    let owner:         SandboxContract<TreasuryContract>;
    let user:          SandboxContract<TreasuryContract>;
    let bridgeAdapter: SandboxContract<TreasuryContract>;
    let oracleKeeper:  SandboxContract<TreasuryContract>;
    let minter:        SandboxContract<TonstableMinter>;

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        blockchain.now = NOW;

        owner         = await blockchain.treasury('owner');
        user          = await blockchain.treasury('user');
        bridgeAdapter = await blockchain.treasury('bridgeAdapter');
        oracleKeeper  = await blockchain.treasury('oracleKeeper');

        minter = blockchain.openContract(
            await TonstableMinter.fromInit(
                owner.address,
                owner.address,
                bridgeAdapter.address,
                oracleKeeper.address,
                emptyContent(),
            ),
        );

        await minter.send(owner.getSender(), { value: toNano('10') }, { $$type: 'Deploy', queryId: 0n });

        await minter.send(oracleKeeper.getSender(), { value: toNano('0.05') }, {
            $$type:    'PriceUpdate',
            price:     PRICE,
            timestamp: BigInt(NOW),
        } satisfies PriceUpdate);
    });

    // ── WithdrawFees ─────────────────────────────────────────────────────────────

    describe('WithdrawFees', () => {
        it('owner can withdraw fees to a destination', async () => {
            // The Deployable trait returns change via SendRemainingValue, so the minter's
            // post-deploy balance is small. Fund it explicitly via a no-refund admin call.
            await minter.send(owner.getSender(), { value: toNano('5') }, {
                $$type:    'SetFeeParams',
                feeBps:    30n,
                feeFloor:  toNano('0.5'),
            });

            const destBefore = await user.getBalance();

            const result = await minter.send(
                owner.getSender(),
                { value: toNano('0.1') },
                {
                    $$type:      'WithdrawFees',
                    amount:      toNano('1'),
                    destination: user.address,
                } satisfies WithdrawFees,
            );

            expect(result.transactions).toHaveTransaction({
                from: owner.address,
                to:   minter.address,
                success: true,
            });

            // TON forwarded to destination
            expect(result.transactions).toHaveTransaction({
                from: minter.address,
                to:   user.address,
                success: true,
            });

            const destAfter = await user.getBalance();
            expect(destAfter).toBeGreaterThan(destBefore);
        });

        it('rejects non-owner', async () => {
            const result = await minter.send(
                user.getSender(),
                { value: toNano('0.1') },
                {
                    $$type:      'WithdrawFees',
                    amount:      toNano('1'),
                    destination: user.address,
                } satisfies WithdrawFees,
            );

            expect(result.transactions).toHaveTransaction({
                from: user.address,
                to:   minter.address,
                success: false,
            });
        });

        it('rejects when balance would drop below 2 TON operational reserve', async () => {
            // minter post-deploy balance is small (~0.05 TON); trying to withdraw 9 TON
            // makes myBalance() - amount deeply negative → fails the reserve check.
            const result = await minter.send(
                owner.getSender(),
                { value: toNano('0.1') },
                {
                    $$type:      'WithdrawFees',
                    amount:      toNano('9'),
                    destination: user.address,
                } satisfies WithdrawFees,
            );

            expect(result.transactions).toHaveTransaction({
                from: owner.address,
                to:   minter.address,
                success: false,
            });
        });

        it('rejects when paused', async () => {
            await minter.send(owner.getSender(), { value: toNano('0.05') }, { $$type: 'Pause' });

            const result = await minter.send(
                owner.getSender(),
                { value: toNano('0.1') },
                {
                    $$type:      'WithdrawFees',
                    amount:      toNano('1'),
                    destination: user.address,
                } satisfies WithdrawFees,
            );

            expect(result.transactions).toHaveTransaction({
                from: owner.address,
                to:   minter.address,
                success: false,
            });
        });
    });

    // ── SetPendingTimeout ────────────────────────────────────────────────────────

    describe('SetPendingTimeout', () => {
        it('owner can set timeout within bounds', async () => {
            const result = await minter.send(
                owner.getSender(),
                { value: toNano('0.05') },
                { $$type: 'SetPendingTimeout', newTimeout: 7200n } satisfies SetPendingTimeout,
            );

            expect(result.transactions).toHaveTransaction({
                from: owner.address,
                to:   minter.address,
                success: true,
            });
        });

        it('rejects timeout below 1 hour (3600s)', async () => {
            const result = await minter.send(
                owner.getSender(),
                { value: toNano('0.05') },
                { $$type: 'SetPendingTimeout', newTimeout: 3599n } satisfies SetPendingTimeout,
            );

            expect(result.transactions).toHaveTransaction({
                from: owner.address,
                to:   minter.address,
                success: false,
            });
        });

        it('rejects timeout above 7 days', async () => {
            const result = await minter.send(
                owner.getSender(),
                { value: toNano('0.05') },
                { $$type: 'SetPendingTimeout', newTimeout: BigInt(7 * 24 * 3600 + 1) } satisfies SetPendingTimeout,
            );

            expect(result.transactions).toHaveTransaction({
                from: owner.address,
                to:   minter.address,
                success: false,
            });
        });

        it('accepts exactly 1 hour and exactly 7 days', async () => {
            const r1 = await minter.send(
                owner.getSender(),
                { value: toNano('0.05') },
                { $$type: 'SetPendingTimeout', newTimeout: 3600n } satisfies SetPendingTimeout,
            );
            expect(r1.transactions).toHaveTransaction({ from: owner.address, to: minter.address, success: true });

            const r2 = await minter.send(
                owner.getSender(),
                { value: toNano('0.05') },
                { $$type: 'SetPendingTimeout', newTimeout: BigInt(7 * 24 * 3600) } satisfies SetPendingTimeout,
            );
            expect(r2.transactions).toHaveTransaction({ from: owner.address, to: minter.address, success: true });
        });

        it('rejects non-owner', async () => {
            const result = await minter.send(
                user.getSender(),
                { value: toNano('0.05') },
                { $$type: 'SetPendingTimeout', newTimeout: 7200n } satisfies SetPendingTimeout,
            );

            expect(result.transactions).toHaveTransaction({
                from: user.address,
                to:   minter.address,
                success: false,
            });
        });
    });

    // ── SetMinDeposit ────────────────────────────────────────────────────────────

    describe('SetMinDeposit', () => {
        it('owner can set minDeposit within bounds', async () => {
            const result = await minter.send(
                owner.getSender(),
                { value: toNano('0.05') },
                { $$type: 'SetMinDeposit', newMin: toNano('5') } satisfies SetMinDeposit,
            );

            expect(result.transactions).toHaveTransaction({
                from: owner.address,
                to:   minter.address,
                success: true,
            });
        });

        it('rejects minDeposit below 1 TON', async () => {
            const result = await minter.send(
                owner.getSender(),
                { value: toNano('0.05') },
                { $$type: 'SetMinDeposit', newMin: toNano('0.9') } satisfies SetMinDeposit,
            );

            expect(result.transactions).toHaveTransaction({
                from: owner.address,
                to:   minter.address,
                success: false,
            });
        });

        it('rejects minDeposit above 100 TON', async () => {
            const result = await minter.send(
                owner.getSender(),
                { value: toNano('0.05') },
                { $$type: 'SetMinDeposit', newMin: toNano('101') } satisfies SetMinDeposit,
            );

            expect(result.transactions).toHaveTransaction({
                from: owner.address,
                to:   minter.address,
                success: false,
            });
        });

        it('accepts exactly 1 TON and exactly 100 TON', async () => {
            const r1 = await minter.send(
                owner.getSender(),
                { value: toNano('0.05') },
                { $$type: 'SetMinDeposit', newMin: toNano('1') } satisfies SetMinDeposit,
            );
            expect(r1.transactions).toHaveTransaction({ from: owner.address, to: minter.address, success: true });

            const r2 = await minter.send(
                owner.getSender(),
                { value: toNano('0.05') },
                { $$type: 'SetMinDeposit', newMin: toNano('100') } satisfies SetMinDeposit,
            );
            expect(r2.transactions).toHaveTransaction({ from: owner.address, to: minter.address, success: true });
        });

        it('rejects non-owner', async () => {
            const result = await minter.send(
                user.getSender(),
                { value: toNano('0.05') },
                { $$type: 'SetMinDeposit', newMin: toNano('5') } satisfies SetMinDeposit,
            );

            expect(result.transactions).toHaveTransaction({
                from: user.address,
                to:   minter.address,
                success: false,
            });
        });
    });

    // ── Ownership events ─────────────────────────────────────────────────────────

    describe('Ownership events', () => {
        let candidate: SandboxContract<TreasuryContract>;

        beforeEach(async () => {
            candidate = await blockchain.treasury('candidate');
        });

        it('ProposeOwner emits opcode 0x544E5350 with currentOwner and newOwner', async () => {
            const result = await minter.send(
                owner.getSender(),
                { value: toNano('0.05') },
                { $$type: 'ProposeOwner', newOwner: candidate.address } satisfies ProposeOwner,
            );

            expect(result.transactions).toHaveTransaction({
                from: owner.address,
                to:   minter.address,
                success: true,
            });

            // Verify pending owner is set
            const pending = await minter.getGetPendingOwner();
            expect(pending?.toString()).toBe(candidate.address.toString());

            // Check emit in external message logs
            const emitTx = result.transactions.find(
                tx => tx.externals && tx.externals.length > 0
            );
            expect(emitTx).toBeDefined();

            const body = emitTx!.externals![0].body;
            const slice = body.beginParse();
            expect(slice.loadUint(32)).toBe(0x544E5350);
        });

        it('AcceptOwnership emits opcode 0x544E5351 with oldOwner and newOwner', async () => {
            await minter.send(
                owner.getSender(),
                { value: toNano('0.05') },
                { $$type: 'ProposeOwner', newOwner: candidate.address } satisfies ProposeOwner,
            );

            const result = await minter.send(
                candidate.getSender(),
                { value: toNano('0.05') },
                { $$type: 'AcceptOwnership' } satisfies AcceptOwnership,
            );

            expect(result.transactions).toHaveTransaction({
                from: candidate.address,
                to:   minter.address,
                success: true,
            });

            const emitTx = result.transactions.find(
                tx => tx.externals && tx.externals.length > 0
            );
            expect(emitTx).toBeDefined();

            const body = emitTx!.externals![0].body;
            const slice = body.beginParse();
            expect(slice.loadUint(32)).toBe(0x544E5351);
        });

        it('CancelOwnerProposal emits opcode 0x544E5352', async () => {
            await minter.send(
                owner.getSender(),
                { value: toNano('0.05') },
                { $$type: 'ProposeOwner', newOwner: candidate.address } satisfies ProposeOwner,
            );

            const result = await minter.send(
                owner.getSender(),
                { value: toNano('0.05') },
                { $$type: 'CancelOwnerProposal' } satisfies CancelOwnerProposal,
            );

            expect(result.transactions).toHaveTransaction({
                from: owner.address,
                to:   minter.address,
                success: true,
            });

            // Pending owner cleared
            const pending = await minter.getGetPendingOwner();
            expect(pending).toBeNull();

            const emitTx = result.transactions.find(
                tx => tx.externals && tx.externals.length > 0
            );
            expect(emitTx).toBeDefined();

            const body = emitTx!.externals![0].body;
            const slice = body.beginParse();
            expect(slice.loadUint(32)).toBe(0x544E5352);
        });
    });
});
