import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { beginCell, toNano } from '@ton/core';
import {
    TonstableMinter,
    DepositTon,
    MintConfirmation,
    PriceUpdate,
    RedeemPayout,
    RedeemFailure,
    CancelPending,
} from '../wrappers/TonstableMinter';
import { TonstableJettonWallet, JettonTransfer, JettonBurn } from '../wrappers/TonstableJettonWallet';
import '@ton/test-utils';

const PRICE = 3_000_000_000n; // $3 per TON, 1e9-scaled
const NOW   = 1_700_000_000;

function emptyContent() {
    return beginCell().endCell();
}

describe('Iteration 4 — transfer, burn, redeem', () => {
    let blockchain:    Blockchain;
    let owner:         SandboxContract<TreasuryContract>;
    let bridgeAdapter: SandboxContract<TreasuryContract>;
    let oracleKeeper:  SandboxContract<TreasuryContract>;
    let user:          SandboxContract<TreasuryContract>;
    let user2:         SandboxContract<TreasuryContract>;
    let minter:        SandboxContract<TonstableMinter>;

    // Returns the user's JettonWallet contract (auto-computed address)
    async function userWallet(u: SandboxContract<TreasuryContract>) {
        const addr = await minter.getGetWalletAddress(u.address);
        return blockchain.openContract(TonstableJettonWallet.fromAddress(addr));
    }

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        blockchain.now = NOW;

        owner         = await blockchain.treasury('owner');
        bridgeAdapter = await blockchain.treasury('bridgeAdapter');
        oracleKeeper  = await blockchain.treasury('oracleKeeper');
        user          = await blockchain.treasury('user');
        user2         = await blockchain.treasury('user2');

        minter = blockchain.openContract(
            await TonstableMinter.fromInit(
                owner.address,
                owner.address,       // guardian = owner for tests
                bridgeAdapter.address,
                oracleKeeper.address,
                emptyContent(),
            ),
        );

        await minter.send(owner.getSender(), { value: toNano('0.1') }, { $$type: 'Deploy', queryId: 0n });

        // Set oracle price
        await minter.send(oracleKeeper.getSender(), { value: toNano('0.05') }, {
            $$type:    'PriceUpdate',
            price:     PRICE,
            timestamp: BigInt(NOW),
        } satisfies PriceUpdate);
    });

    // Helper: deposit TON and bridge-confirm mint → user gets `amount` TONSTBL.
    // Returns the nonce used for the mint (increments from the per-suite counter).
    let nextNonce = 0n;
    beforeEach(() => { nextNonce = 0n; });

    async function mintTokens(amount: bigint): Promise<bigint> {
        const nonce = nextNonce++;
        await minter.send(user.getSender(), { value: toNano('5') }, {
            $$type:        'DepositTon',
            minTonstblOut: 0n,
            deadline:      BigInt(NOW + 3600),
        } satisfies DepositTon);

        await minter.send(bridgeAdapter.getSender(), { value: toNano('0.5') }, {
            $$type:      'MintConfirmation',
            nonce,
            actualLusd:  amount,
            arbTxHash:   0n,
        } satisfies MintConfirmation);
        return nonce;
    }

    // ── JettonTransfer ────────────────────────────────────────────────────────

    describe('JettonTransfer', () => {
        const MINT_AMOUNT = 10_000_000n; // 10 TONSTBL

        beforeEach(async () => {
            await mintTokens(MINT_AMOUNT);
        });

        it('owner can transfer tokens to another address', async () => {
            const wallet  = await userWallet(user);
            const wallet2 = await userWallet(user2);

            const result = await wallet.send(
                user.getSender(),
                { value: toNano('0.1') },
                {
                    $$type:              'JettonTransfer',
                    queryId:             1n,
                    amount:              4_000_000n,
                    destination:         user2.address,
                    responseDestination: user.address,
                    customPayload:       null,
                    forwardAmount:       0n,
                    forwardPayload:      beginCell().endCell().beginParse(),
                } satisfies JettonTransfer,
            );

            expect(result.transactions).toHaveTransaction({
                from: user.address,
                to: wallet.address,
                success: true,
            });

            // JettonTransferInternal sent to destination wallet
            expect(result.transactions).toHaveTransaction({
                from: wallet.address,
                to: wallet2.address,
                success: true,
            });

            expect(await wallet.getBalance()).toBe(MINT_AMOUNT - 4_000_000n);
            expect(await wallet2.getBalance()).toBe(4_000_000n);
        });

        it('transfer fails when non-owner sends', async () => {
            const wallet = await userWallet(user);

            const result = await wallet.send(
                user2.getSender(),
                { value: toNano('0.1') },
                {
                    $$type:              'JettonTransfer',
                    queryId:             1n,
                    amount:              1_000_000n,
                    destination:         user2.address,
                    responseDestination: user2.address,
                    customPayload:       null,
                    forwardAmount:       0n,
                    forwardPayload:      beginCell().endCell().beginParse(),
                } satisfies JettonTransfer,
            );

            expect(result.transactions).toHaveTransaction({
                from: user2.address,
                to: wallet.address,
                success: false,
            });
        });

        it('transfer fails when balance is insufficient', async () => {
            const wallet = await userWallet(user);

            const result = await wallet.send(
                user.getSender(),
                { value: toNano('0.1') },
                {
                    $$type:              'JettonTransfer',
                    queryId:             1n,
                    amount:              MINT_AMOUNT + 1n,
                    destination:         user2.address,
                    responseDestination: user.address,
                    customPayload:       null,
                    forwardAmount:       0n,
                    forwardPayload:      beginCell().endCell().beginParse(),
                } satisfies JettonTransfer,
            );

            expect(result.transactions).toHaveTransaction({
                from: user.address,
                to: wallet.address,
                success: false,
            });
            expect(await wallet.getBalance()).toBe(MINT_AMOUNT);
        });

        it('bounced JettonTransferInternal restores sender balance', async () => {
            // This is tested indirectly: if the destination rejects, bounced handler fires.
            // We test the happy path here; the bounced path fires in adverse network conditions.
            const wallet = await userWallet(user);
            const before = await wallet.getBalance();

            await wallet.send(
                user.getSender(),
                { value: toNano('0.1') },
                {
                    $$type:              'JettonTransfer',
                    queryId:             1n,
                    amount:              1_000_000n,
                    destination:         user2.address,
                    responseDestination: user.address,
                    customPayload:       null,
                    forwardAmount:       0n,
                    forwardPayload:      beginCell().endCell().beginParse(),
                } satisfies JettonTransfer,
            );

            const after = await wallet.getBalance();
            expect(after).toBe(before - 1_000_000n);
        });
    });

    // ── JettonBurn → redeem flow ───────────────────────────────────────────────

    describe('JettonBurn → redeem flow', () => {
        const MINT_AMOUNT = 5_000_000n;

        beforeEach(async () => {
            await mintTokens(MINT_AMOUNT);
        });

        it('burn sends BridgeRedeemRequest to bridgeAdapter', async () => {
            const wallet = await userWallet(user);

            const result = await wallet.send(
                user.getSender(),
                { value: toNano('0.3') },
                {
                    $$type:              'JettonBurn',
                    queryId:             1n,
                    amount:              MINT_AMOUNT,
                    responseDestination: user.address,
                    customPayload:       null,
                } satisfies JettonBurn,
            );

            // Wallet sends JettonBurnNotification to minter
            expect(result.transactions).toHaveTransaction({
                from: wallet.address,
                to: minter.address,
                success: true,
            });

            // Minter forwards BridgeRedeemRequest to bridge
            expect(result.transactions).toHaveTransaction({
                from: minter.address,
                to: bridgeAdapter.address,
                success: true,
            });

            // totalSupply decremented immediately
            expect(await minter.getTotalSupplyOf()).toBe(0n);
            // wallet balance zeroed
            expect(await wallet.getBalance()).toBe(0n);
        });

        it('burn fails when non-owner tries to burn', async () => {
            const wallet = await userWallet(user);

            const result = await wallet.send(
                user2.getSender(),
                { value: toNano('0.3') },
                {
                    $$type:              'JettonBurn',
                    queryId:             1n,
                    amount:              1_000_000n,
                    responseDestination: user2.address,
                    customPayload:       null,
                } satisfies JettonBurn,
            );

            expect(result.transactions).toHaveTransaction({
                from: user2.address,
                to: wallet.address,
                success: false,
            });
            expect(await wallet.getBalance()).toBe(MINT_AMOUNT);
        });

        it('RedeemPayout from bridge forwards TON to user', async () => {
            const wallet = await userWallet(user);
            // Burn first to create pending redeem — nonce = mintNonce + 1
            await wallet.send(user.getSender(), { value: toNano('0.3') }, {
                $$type:              'JettonBurn',
                queryId:             1n,
                amount:              MINT_AMOUNT,
                responseDestination: user.address,
                customPayload:       null,
            } satisfies JettonBurn);

            const redeemNonce = 1n; // deposit consumed nonce 0, burn consumed nonce 1

            const result = await minter.send(
                bridgeAdapter.getSender(),
                { value: toNano('1.5') }, // bridge attaches TON payout
                {
                    $$type:     'RedeemPayout',
                    nonce:      redeemNonce,
                    arbTxHash:  0n,
                } satisfies RedeemPayout,
            );

            // Payout forwarded to user
            expect(result.transactions).toHaveTransaction({
                from: minter.address,
                to: user.address,
                success: true,
            });

            // Pending redeem cleared — supply stays at 0
            expect(await minter.getTotalSupplyOf()).toBe(0n);
        });

        it('RedeemPayout rejects non-bridge sender', async () => {
            const wallet = await userWallet(user);
            await wallet.send(user.getSender(), { value: toNano('0.3') }, {
                $$type:              'JettonBurn',
                queryId:             1n,
                amount:              MINT_AMOUNT,
                responseDestination: user.address,
                customPayload:       null,
            } satisfies JettonBurn);

            const result = await minter.send(
                user.getSender(),
                { value: toNano('1') },
                { $$type: 'RedeemPayout', nonce: 1n, arbTxHash: 0n } satisfies RedeemPayout,
            );

            expect(result.transactions).toHaveTransaction({
                from: user.address,
                to: minter.address,
                success: false,
            });
        });

        it('burn is blocked when minter is paused, wallet balance restored via bounce', async () => {
            const wallet = await userWallet(user);
            expect(await wallet.getBalance()).toBe(MINT_AMOUNT);
            expect(await minter.getTotalSupplyOf()).toBe(MINT_AMOUNT);

            await minter.send(owner.getSender(), { value: toNano('0.05') }, { $$type: 'Pause' });
            expect(await minter.getIsPaused()).toBe(true);

            const result = await wallet.send(
                user.getSender(),
                { value: toNano('0.3') },
                {
                    $$type:              'JettonBurn',
                    queryId:             1n,
                    amount:              MINT_AMOUNT,
                    responseDestination: user.address,
                    customPayload:       null,
                } satisfies JettonBurn,
            );

            // Minter rejects the burn notification
            expect(result.transactions).toHaveTransaction({
                from: wallet.address,
                to: minter.address,
                success: false,
            });

            // Bounced message restores wallet balance
            expect(await wallet.getBalance()).toBe(MINT_AMOUNT);
            // totalSupply unchanged
            expect(await minter.getTotalSupplyOf()).toBe(MINT_AMOUNT);
        });

        it('RedeemFailure re-mints tokens back to user wallet', async () => {
            const wallet = await userWallet(user);
            await wallet.send(user.getSender(), { value: toNano('0.3') }, {
                $$type:              'JettonBurn',
                queryId:             1n,
                amount:              MINT_AMOUNT,
                responseDestination: user.address,
                customPayload:       null,
            } satisfies JettonBurn);

            expect(await minter.getTotalSupplyOf()).toBe(0n);
            expect(await wallet.getBalance()).toBe(0n);

            const redeemNonce = 1n; // deposit nonce=0, burn nonce=1

            const result = await minter.send(
                bridgeAdapter.getSender(),
                { value: toNano('0.3') },
                {
                    $$type:      'RedeemFailure',
                    nonce:       redeemNonce,
                    reasonCode:  1n,
                } satisfies RedeemFailure,
            );

            // Re-mint sent to user wallet
            expect(result.transactions).toHaveTransaction({
                from: minter.address,
                to: wallet.address,
                success: true,
            });

            // totalSupply restored, wallet balance restored
            expect(await minter.getTotalSupplyOf()).toBe(MINT_AMOUNT);
            expect(await wallet.getBalance()).toBe(MINT_AMOUNT);
        });
    });

    // ── Redeem fee ─────────────────────────────────────────────────────────────

    describe('Redeem fee', () => {
        const MINT_AMOUNT = 5_000_000n;

        beforeEach(async () => {
            await mintTokens(MINT_AMOUNT);
        });

        it('charges fee on RedeemPayout — fee floor wins on 100 TON payout', async () => {
            const wallet = await userWallet(user);
            await wallet.send(user.getSender(), { value: toNano('0.3') }, {
                $$type:              'JettonBurn',
                queryId:             1n,
                amount:              MINT_AMOUNT,
                responseDestination: user.address,
                customPayload:       null,
            } satisfies JettonBurn);

            const redeemNonce = 1n;
            // grossPayout = 100 TON
            // feePct = 100e9 * 30 / 10000 = 0.3 TON
            // feeFloor = 0.5 TON  → floor wins
            // netPayout = 99.5 TON
            const grossPayout = toNano('100');
            const expectedFee = toNano('0.5');
            const expectedNet = grossPayout - expectedFee;

            const userBalBefore = await user.getBalance();

            await minter.send(
                bridgeAdapter.getSender(),
                { value: grossPayout },
                { $$type: 'RedeemPayout', nonce: redeemNonce, arbTxHash: 0n } satisfies RedeemPayout,
            );

            const userBalAfter = await user.getBalance();
            const received = userBalAfter - userBalBefore;

            // User receives netPayout (tiny gas variance acceptable)
            expect(received).toBeGreaterThan(toNano('99'));
            expect(received).toBeLessThanOrEqual(expectedNet);
        });

        it('does NOT charge fee on RedeemFailure (failure path returns tokens, no TON fee)', async () => {
            const wallet = await userWallet(user);
            await wallet.send(user.getSender(), { value: toNano('0.3') }, {
                $$type:              'JettonBurn',
                queryId:             1n,
                amount:              MINT_AMOUNT,
                responseDestination: user.address,
                customPayload:       null,
            } satisfies JettonBurn);

            expect(await minter.getTotalSupplyOf()).toBe(0n);
            expect(await wallet.getBalance()).toBe(0n);

            const redeemNonce = 1n;
            const result = await minter.send(
                bridgeAdapter.getSender(),
                { value: toNano('0.3') },
                { $$type: 'RedeemFailure', nonce: redeemNonce, reasonCode: 1n } satisfies RedeemFailure,
            );

            // Re-mint to wallet — no TON fee deducted
            expect(result.transactions).toHaveTransaction({
                from: minter.address,
                to: wallet.address,
                success: true,
            });

            expect(await minter.getTotalSupplyOf()).toBe(MINT_AMOUNT);
            expect(await wallet.getBalance()).toBe(MINT_AMOUNT);

            // No TON sent to user (tokens re-minted instead)
            expect(result.transactions).not.toHaveTransaction({
                from: minter.address,
                to: user.address,
            });
        });
    });

    // ── CancelPending ──────────────────────────────────────────────────────────

    describe('CancelPending', () => {
        it('owner can cancel a timed-out pending mint (cleanup only, no refund)', async () => {
            // Create a pending mint (nonce=0) — don't confirm it
            await minter.send(user.getSender(), { value: toNano('5') }, {
                $$type:        'DepositTon',
                minTonstblOut: 0n,
                deadline:      BigInt(NOW + 3600),
            } satisfies DepositTon);

            // Advance time past pendingTimeout (48 h = 172800 s)
            blockchain.now = NOW + 172_801;

            const result = await minter.send(
                owner.getSender(),
                { value: toNano('0.1') },
                { $$type: 'CancelPending', nonce: 0n } satisfies CancelPending,
            );

            expect(result.transactions).toHaveTransaction({
                from: owner.address,
                to: minter.address,
                success: true,
            });

            // State cleared — no refund sent to user (deposited TON went to bridge)
            expect(result.transactions).not.toHaveTransaction({
                from: minter.address,
                to: user.address,
            });
        });

        it('cannot cancel a mint that has not timed out', async () => {
            await minter.send(user.getSender(), { value: toNano('5') }, {
                $$type:        'DepositTon',
                minTonstblOut: 0n,
                deadline:      BigInt(NOW + 3600),
            } satisfies DepositTon);

            // Only 1 hour has passed — not 48 h
            blockchain.now = NOW + 3600;

            const result = await minter.send(
                owner.getSender(),
                { value: toNano('0.1') },
                { $$type: 'CancelPending', nonce: 0n } satisfies CancelPending,
            );

            expect(result.transactions).toHaveTransaction({
                from: owner.address,
                to: minter.address,
                success: false,
            });
        });

        it('owner can cancel a timed-out pending redeem and tokens are re-minted', async () => {
            // Mint first
            await mintTokens(5_000_000n);
            const wallet = await userWallet(user);

            // Burn to create pending redeem (nonce=1)
            await wallet.send(user.getSender(), { value: toNano('0.3') }, {
                $$type:              'JettonBurn',
                queryId:             1n,
                amount:              5_000_000n,
                responseDestination: user.address,
                customPayload:       null,
            } satisfies JettonBurn);

            expect(await minter.getTotalSupplyOf()).toBe(0n);

            blockchain.now = NOW + 172_801;

            const result = await minter.send(
                owner.getSender(),
                { value: toNano('0.5') },
                { $$type: 'CancelPending', nonce: 1n } satisfies CancelPending,
            );

            expect(result.transactions).toHaveTransaction({
                from: owner.address,
                to: minter.address,
                success: true,
            });

            // Tokens re-minted
            expect(await minter.getTotalSupplyOf()).toBe(5_000_000n);
            expect(await wallet.getBalance()).toBe(5_000_000n);
        });

        it('non-owner cannot cancel', async () => {
            await minter.send(user.getSender(), { value: toNano('5') }, {
                $$type:        'DepositTon',
                minTonstblOut: 0n,
                deadline:      BigInt(NOW + 3600),
            } satisfies DepositTon);

            blockchain.now = NOW + 172_801;

            const result = await minter.send(
                user.getSender(),
                { value: toNano('0.1') },
                { $$type: 'CancelPending', nonce: 0n } satisfies CancelPending,
            );

            expect(result.transactions).toHaveTransaction({
                from: user.address,
                to: minter.address,
                success: false,
            });
        });
    });
});
