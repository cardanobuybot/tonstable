import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { beginCell, Message, toNano } from '@ton/core';
import {
    TonstableMinter,
    DepositTon,
    MintConfirmation,
    MintFailure,
    PriceUpdate,
    Pause,
    Unpause,
    SetFeeParams,
    ProposeOwner,
    AcceptOwnership,
    CancelOwnerProposal,
} from '../wrappers/TonstableMinter';
import { TonstableJettonWallet } from '../wrappers/TonstableJettonWallet';
import '@ton/test-utils';

// TON/USD price: $3 per TON, with 10^9 scaling so
//   usdValue = (netNano * price) / 1e9  → result is in 10^9 units (nanoUSD)
const PRICE = 3_000_000_000n;          // $3 * 1e9

// Minimal on-chain metadata cell (empty snake-format content is valid for tests)
function emptyContent() {
    return beginCell().endCell();
}

describe('TonstableMinter', () => {
    let blockchain: Blockchain;
    let owner:         SandboxContract<TreasuryContract>;
    let guardian:      SandboxContract<TreasuryContract>;
    let bridgeAdapter: SandboxContract<TreasuryContract>;
    let oracleKeeper:  SandboxContract<TreasuryContract>;
    let user:          SandboxContract<TreasuryContract>;
    let minter:        SandboxContract<TonstableMinter>;

    const NOW = 1_700_000_000; // fixed unix ts for deterministic tests

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        blockchain.now = NOW;

        owner         = await blockchain.treasury('owner');
        guardian      = await blockchain.treasury('guardian');
        bridgeAdapter = await blockchain.treasury('bridgeAdapter');
        oracleKeeper  = await blockchain.treasury('oracleKeeper');
        user          = await blockchain.treasury('user');

        minter = blockchain.openContract(
            await TonstableMinter.fromInit(
                owner.address,
                guardian.address,
                bridgeAdapter.address,
                oracleKeeper.address,
                emptyContent(),
            ),
        );

        const deployResult = await minter.send(
            owner.getSender(),
            { value: toNano('0.1') },
            { $$type: 'Deploy', queryId: 0n },
        );

        expect(deployResult.transactions).toHaveTransaction({
            from: owner.address,
            to: minter.address,
            deploy: true,
            success: true,
        });
    });

    it('deploys with correct initial state', async () => {
        expect(await minter.getIsPaused()).toBe(false);
        expect(await minter.getTotalSupplyOf()).toBe(0n);
        const data = await minter.getGetJettonData();
        expect(data.mintable).toBe(true);
        expect(data.totalSupply).toBe(0n);
        expect(data.adminAddress.toString()).toBe(owner.address.toString());
    });

    it('oracle keeper can update price', async () => {
        const result = await minter.send(
            oracleKeeper.getSender(),
            { value: toNano('0.05') },
            {
                $$type: 'PriceUpdate',
                price:     PRICE,
                timestamp: BigInt(NOW),
            } satisfies PriceUpdate,
        );
        expect(result.transactions).toHaveTransaction({
            from: oracleKeeper.address,
            to: minter.address,
            success: true,
        });
    });

    it('rejects price update from non-keeper', async () => {
        const result = await minter.send(
            user.getSender(),
            { value: toNano('0.05') },
            {
                $$type: 'PriceUpdate',
                price:     PRICE,
                timestamp: BigInt(NOW),
            } satisfies PriceUpdate,
        );
        expect(result.transactions).toHaveTransaction({
            from: user.address,
            to: minter.address,
            success: false,
        });
    });

    describe('with oracle price set', () => {
        beforeEach(async () => {
            await minter.send(
                oracleKeeper.getSender(),
                { value: toNano('0.05') },
                {
                    $$type: 'PriceUpdate',
                    price:     PRICE,
                    timestamp: BigInt(NOW),
                } satisfies PriceUpdate,
            );
        });

        it('feePreview returns correct fee (floor wins for small deposits)', async () => {
            // For 5 TON: pct = 5e9 * 30 / 10000 = 15_000_000; floor = 500_000_000 → floor wins
            const fee = await minter.getFeePreview(toNano('5'));
            expect(fee).toBe(500_000_000n); // DEFAULT_FEE_FLOOR
        });

        it('feePreview uses bps for large deposits', async () => {
            // For 200 TON: pct = 200e9 * 30 / 10000 = 600_000_000 > 500_000_000 → pct wins
            const fee = await minter.getFeePreview(toNano('200'));
            expect(fee).toBe(600_000_000n);
        });

        it('quotePreview returns nonzero USD value for valid deposit', async () => {
            const quote = await minter.getQuotePreview(toNano('5'));
            // net = 5e9 - 500_000_000 = 4_500_000_000
            // usd  = 4_500_000_000 * 3_000_000_000 / 1_000_000_000 = 13_500_000_000
            expect(quote).toBe(13_500_000_000n);
        });

        it('quotePreview returns 0 when stale price', async () => {
            blockchain.now = NOW + 400; // > DEFAULT_ORACLE_MAX_STALE = 300
            const quote = await minter.getQuotePreview(toNano('5'));
            expect(quote).toBe(0n);
        });

        it('get_wallet_address matches walletAddressOf', async () => {
            const addr1 = await minter.getGetWalletAddress(user.address);
            const addr2 = await minter.getWalletAddressOf(user.address);
            expect(addr1.toString()).toBe(addr2.toString());
        });

        it('DepositTon sends BridgeMintRequest to bridgeAdapter', async () => {
            const deposit: DepositTon = {
                $$type:        'DepositTon',
                minTonstblOut: 0n,
                deadline:      BigInt(NOW + 3600),
            };

            const result = await minter.send(
                user.getSender(),
                { value: toNano('5') },
                deposit,
            );

            // Deposit accepted
            expect(result.transactions).toHaveTransaction({
                from: user.address,
                to: minter.address,
                success: true,
            });

            // BridgeMintRequest forwarded to bridgeAdapter
            expect(result.transactions).toHaveTransaction({
                from: minter.address,
                to: bridgeAdapter.address,
                success: true,
            });
        });

        it('DepositTon rejects expired deadline', async () => {
            const result = await minter.send(
                user.getSender(),
                { value: toNano('5') },
                {
                    $$type:        'DepositTon',
                    minTonstblOut: 0n,
                    deadline:      BigInt(NOW - 1),
                } satisfies DepositTon,
            );
            expect(result.transactions).toHaveTransaction({
                from: user.address,
                to: minter.address,
                success: false,
            });
        });

        it('DepositTon rejects deposit below minimum', async () => {
            const result = await minter.send(
                user.getSender(),
                { value: toNano('1') }, // < DEFAULT_MIN_DEPOSIT = 2 TON
                {
                    $$type:        'DepositTon',
                    minTonstblOut: 0n,
                    deadline:      BigInt(NOW + 3600),
                } satisfies DepositTon,
            );
            expect(result.transactions).toHaveTransaction({
                from: user.address,
                to: minter.address,
                success: false,
            });
        });

        describe('after successful deposit', () => {
            let nonce = 0n;

            beforeEach(async () => {
                nonce = 0n; // first deposit always gets nonce 0
                await minter.send(
                    user.getSender(),
                    { value: toNano('5') },
                    {
                        $$type:        'DepositTon',
                        minTonstblOut: 0n,
                        deadline:      BigInt(NOW + 3600),
                    } satisfies DepositTon,
                );
            });

            it('MintConfirmation from bridge mints TONSTBL to user wallet', async () => {
                const actualLusd = 13_000_000n; // ~13 TONSTBL in 1e6 scale

                const result = await minter.send(
                    bridgeAdapter.getSender(),
                    { value: toNano('0.5') },
                    {
                        $$type:      'MintConfirmation',
                        nonce:       nonce,
                        actualLusd:  actualLusd,
                        arbTxHash:   0xdeadbeefn,
                    } satisfies MintConfirmation,
                );

                expect(result.transactions).toHaveTransaction({
                    from: bridgeAdapter.address,
                    to: minter.address,
                    success: true,
                });

                // Internal transfer sent to user's jetton wallet
                const walletAddr = await minter.getGetWalletAddress(user.address);
                expect(result.transactions).toHaveTransaction({
                    from: minter.address,
                    to: walletAddr,
                    success: true,
                });

                // totalSupply increased
                expect(await minter.getTotalSupplyOf()).toBe(actualLusd);

                // User wallet balance updated
                const walletContract = blockchain.openContract(
                    TonstableJettonWallet.fromAddress(walletAddr),
                );
                expect(await walletContract.getBalance()).toBe(actualLusd);
            });

            it('MintConfirmation rejects actualLusd > 110% of quote', async () => {
                // quotedUsdValue = 13_500_000_000; ceiling = 13_500_000_000 * 110 / 100 = 14_850_000_000
                // actualLusd * 100 must be <= 14_850_000_000
                // so actualLusd > 148_500_000 triggers the guard
                const result = await minter.send(
                    bridgeAdapter.getSender(),
                    { value: toNano('0.5') },
                    {
                        $$type:      'MintConfirmation',
                        nonce:       nonce,
                        actualLusd:  200_000_000n, // 200_000_000 * 100 = 20e9 > 14.85e9
                        arbTxHash:   0n,
                    } satisfies MintConfirmation,
                );
                expect(result.transactions).toHaveTransaction({
                    from: bridgeAdapter.address,
                    to: minter.address,
                    success: false,
                });
            });

            it('MintConfirmation rejects non-bridge sender', async () => {
                const result = await minter.send(
                    user.getSender(),
                    { value: toNano('0.5') },
                    {
                        $$type:      'MintConfirmation',
                        nonce:       nonce,
                        actualLusd:  1_000_000n,
                        arbTxHash:   0n,
                    } satisfies MintConfirmation,
                );
                expect(result.transactions).toHaveTransaction({
                    from: user.address,
                    to: minter.address,
                    success: false,
                });
            });

            it('MintFailure refunds user', async () => {
                const result = await minter.send(
                    bridgeAdapter.getSender(),
                    { value: toNano('4.5') }, // returning the net amount
                    {
                        $$type:       'MintFailure',
                        nonce:        nonce,
                        reasonCode:   1n,
                        refundedTon:  toNano('4.5'),
                    } satisfies MintFailure,
                );

                expect(result.transactions).toHaveTransaction({
                    from: bridgeAdapter.address,
                    to: minter.address,
                    success: true,
                });

                // Refund sent to user
                expect(result.transactions).toHaveTransaction({
                    from: minter.address,
                    to: user.address,
                    success: true,
                });

                // Pending cleared — totalSupply stays 0
                expect(await minter.getTotalSupplyOf()).toBe(0n);
            });
        });
    });

    describe('pause / unpause', () => {
        it('guardian can pause', async () => {
            await minter.send(
                guardian.getSender(),
                { value: toNano('0.05') },
                { $$type: 'Pause' } satisfies Pause,
            );
            expect(await minter.getIsPaused()).toBe(true);
        });

        it('owner can pause', async () => {
            await minter.send(
                owner.getSender(),
                { value: toNano('0.05') },
                { $$type: 'Pause' } satisfies Pause,
            );
            expect(await minter.getIsPaused()).toBe(true);
        });

        it('non-guardian/owner cannot pause', async () => {
            const result = await minter.send(
                user.getSender(),
                { value: toNano('0.05') },
                { $$type: 'Pause' } satisfies Pause,
            );
            expect(result.transactions).toHaveTransaction({
                from: user.address,
                to: minter.address,
                success: false,
            });
        });

        it('owner can unpause', async () => {
            await minter.send(
                guardian.getSender(),
                { value: toNano('0.05') },
                { $$type: 'Pause' } satisfies Pause,
            );
            await minter.send(
                owner.getSender(),
                { value: toNano('0.05') },
                { $$type: 'Unpause' } satisfies Unpause,
            );
            expect(await minter.getIsPaused()).toBe(false);
        });

        it('deposit fails when paused', async () => {
            // Set oracle price first
            await minter.send(
                oracleKeeper.getSender(),
                { value: toNano('0.05') },
                { $$type: 'PriceUpdate', price: PRICE, timestamp: BigInt(NOW) } satisfies PriceUpdate,
            );

            await minter.send(
                guardian.getSender(),
                { value: toNano('0.05') },
                { $$type: 'Pause' } satisfies Pause,
            );

            const result = await minter.send(
                user.getSender(),
                { value: toNano('5') },
                {
                    $$type:        'DepositTon',
                    minTonstblOut: 0n,
                    deadline:      BigInt(NOW + 3600),
                },
            );
            expect(result.transactions).toHaveTransaction({
                from: user.address,
                to: minter.address,
                success: false,
            });
        });
    });

    describe('two-step ownership transfer', () => {
        let newOwner: SandboxContract<TreasuryContract>;

        beforeEach(async () => {
            newOwner = await blockchain.treasury('newOwner');
        });

        it('owner can propose a new owner — pendingOwner is set', async () => {
            const result = await minter.send(
                owner.getSender(),
                { value: toNano('0.05') },
                { $$type: 'ProposeOwner', newOwner: newOwner.address } satisfies ProposeOwner,
            );
            expect(result.transactions).toHaveTransaction({
                from: owner.address,
                to: minter.address,
                success: true,
            });
            const pending = await minter.getGetPendingOwner();
            expect(pending?.toString()).toBe(newOwner.address.toString());
            // owner unchanged until acceptance
            expect((await minter.getOwner()).toString()).toBe(owner.address.toString());
        });

        it('non-owner cannot propose', async () => {
            const result = await minter.send(
                user.getSender(),
                { value: toNano('0.05') },
                { $$type: 'ProposeOwner', newOwner: newOwner.address } satisfies ProposeOwner,
            );
            expect(result.transactions).toHaveTransaction({
                from: user.address,
                to: minter.address,
                success: false,
            });
            expect(await minter.getGetPendingOwner()).toBeNull();
        });

        it('cannot propose minter itself as new owner', async () => {
            const result = await minter.send(
                owner.getSender(),
                { value: toNano('0.05') },
                { $$type: 'ProposeOwner', newOwner: minter.address } satisfies ProposeOwner,
            );
            expect(result.transactions).toHaveTransaction({
                from: owner.address,
                to: minter.address,
                success: false,
            });
        });

        it('pending owner can accept — owner changes, pendingOwner cleared', async () => {
            await minter.send(
                owner.getSender(),
                { value: toNano('0.05') },
                { $$type: 'ProposeOwner', newOwner: newOwner.address } satisfies ProposeOwner,
            );

            const result = await minter.send(
                newOwner.getSender(),
                { value: toNano('0.05') },
                { $$type: 'AcceptOwnership' } satisfies AcceptOwnership,
            );
            expect(result.transactions).toHaveTransaction({
                from: newOwner.address,
                to: minter.address,
                success: true,
            });
            expect((await minter.getOwner()).toString()).toBe(newOwner.address.toString());
            expect(await minter.getGetPendingOwner()).toBeNull();
        });

        it('non-pending-owner cannot accept', async () => {
            await minter.send(
                owner.getSender(),
                { value: toNano('0.05') },
                { $$type: 'ProposeOwner', newOwner: newOwner.address } satisfies ProposeOwner,
            );

            const result = await minter.send(
                user.getSender(),         // wrong address
                { value: toNano('0.05') },
                { $$type: 'AcceptOwnership' } satisfies AcceptOwnership,
            );
            expect(result.transactions).toHaveTransaction({
                from: user.address,
                to: minter.address,
                success: false,
            });
            // owner unchanged
            expect((await minter.getOwner()).toString()).toBe(owner.address.toString());
        });

        it('AcceptOwnership fails when no proposal is pending', async () => {
            const result = await minter.send(
                newOwner.getSender(),
                { value: toNano('0.05') },
                { $$type: 'AcceptOwnership' } satisfies AcceptOwnership,
            );
            expect(result.transactions).toHaveTransaction({
                from: newOwner.address,
                to: minter.address,
                success: false,
            });
        });

        it('owner can cancel a pending proposal — pendingOwner cleared', async () => {
            await minter.send(
                owner.getSender(),
                { value: toNano('0.05') },
                { $$type: 'ProposeOwner', newOwner: newOwner.address } satisfies ProposeOwner,
            );
            expect((await minter.getGetPendingOwner())?.toString()).toBe(newOwner.address.toString());

            const result = await minter.send(
                owner.getSender(),
                { value: toNano('0.05') },
                { $$type: 'CancelOwnerProposal' } satisfies CancelOwnerProposal,
            );
            expect(result.transactions).toHaveTransaction({
                from: owner.address,
                to: minter.address,
                success: true,
            });
            expect(await minter.getGetPendingOwner()).toBeNull();
            // new owner cannot accept after cancellation
            const rejectResult = await minter.send(
                newOwner.getSender(),
                { value: toNano('0.05') },
                { $$type: 'AcceptOwnership' } satisfies AcceptOwnership,
            );
            expect(rejectResult.transactions).toHaveTransaction({
                from: newOwner.address,
                to: minter.address,
                success: false,
            });
        });

        it('non-owner cannot cancel a pending proposal', async () => {
            await minter.send(
                owner.getSender(),
                { value: toNano('0.05') },
                { $$type: 'ProposeOwner', newOwner: newOwner.address } satisfies ProposeOwner,
            );

            const result = await minter.send(
                user.getSender(),
                { value: toNano('0.05') },
                { $$type: 'CancelOwnerProposal' } satisfies CancelOwnerProposal,
            );
            expect(result.transactions).toHaveTransaction({
                from: user.address,
                to: minter.address,
                success: false,
            });
            // proposal still active
            expect((await minter.getGetPendingOwner())?.toString()).toBe(newOwner.address.toString());
        });

        it('new owner can re-use admin privileges immediately after acceptance', async () => {
            await minter.send(
                owner.getSender(),
                { value: toNano('0.05') },
                { $$type: 'ProposeOwner', newOwner: newOwner.address } satisfies ProposeOwner,
            );
            await minter.send(
                newOwner.getSender(),
                { value: toNano('0.05') },
                { $$type: 'AcceptOwnership' } satisfies AcceptOwnership,
            );

            // new owner should be able to pause
            const result = await minter.send(
                newOwner.getSender(),
                { value: toNano('0.05') },
                { $$type: 'Pause' } satisfies Pause,
            );
            expect(result.transactions).toHaveTransaction({
                from: newOwner.address,
                to: minter.address,
                success: true,
            });
            expect(await minter.getIsPaused()).toBe(true);

            // old owner must no longer be able to unpause
            const oldOwnerResult = await minter.send(
                owner.getSender(),
                { value: toNano('0.05') },
                { $$type: 'Unpause' } satisfies Unpause,
            );
            expect(oldOwnerResult.transactions).toHaveTransaction({
                from: owner.address,
                to: minter.address,
                success: false,
            });
        });

        it('old one-step ChangeOwner (stdlib opcode 0x819dbe99) is rejected — no handler', async () => {
            // ChangeOwner is no longer handled (OwnableTransferable removed).
            // The TypeScript wrapper already blocks it at compile time (it's excluded
            // from the send union type). Here we verify the on-chain behaviour too,
            // by bypassing the typed wrapper and sending the raw opcode directly.
            const changeOwnerBody = beginCell()
                .storeUint(0x819dbe99, 32)   // ChangeOwner opcode
                .storeUint(0n, 64)            // queryId
                .storeAddress(newOwner.address)
                .endCell();

            const msg: Message = {
                info: {
                    type:        'internal',
                    ihrDisabled: true,
                    bounce:      true,
                    bounced:     false,
                    src:         owner.address,
                    dest:        minter.address,
                    value:       { coins: toNano('0.05') },
                    ihrFee:      0n,
                    forwardFee:  0n,
                    createdLt:   0n,
                    createdAt:   0,
                },
                body: changeOwnerBody,
            };
            const result = await blockchain.sendMessage(msg);
            expect(result.transactions).toHaveTransaction({
                from: owner.address,
                to: minter.address,
                success: false,
            });
            // owner unchanged — one-step hijack impossible
            expect((await minter.getOwner()).toString()).toBe(owner.address.toString());
        });
    });

    describe('admin functions', () => {
        it('owner can update fee params', async () => {
            const result = await minter.send(
                owner.getSender(),
                { value: toNano('0.05') },
                {
                    $$type:    'SetFeeParams',
                    feeBps:    50n,
                    feeFloor:  toNano('0.6'),
                } satisfies SetFeeParams,
            );
            expect(result.transactions).toHaveTransaction({
                from: owner.address,
                to: minter.address,
                success: true,
            });

            // After price is set, feePreview should reflect new params
            await minter.send(
                oracleKeeper.getSender(),
                { value: toNano('0.05') },
                { $$type: 'PriceUpdate', price: PRICE, timestamp: BigInt(NOW) } satisfies PriceUpdate,
            );
            // 5 TON: pct = 5e9 * 50 / 10000 = 25_000_000 < 600_000_000 → floor wins
            const fee = await minter.getFeePreview(toNano('5'));
            expect(fee).toBe(toNano('0.6'));
        });

        it('non-owner cannot update fee params', async () => {
            const result = await minter.send(
                user.getSender(),
                { value: toNano('0.05') },
                {
                    $$type:    'SetFeeParams',
                    feeBps:    50n,
                    feeFloor:  toNano('0.6'),
                } satisfies SetFeeParams,
            );
            expect(result.transactions).toHaveTransaction({
                from: user.address,
                to: minter.address,
                success: false,
            });
        });
    });
});
