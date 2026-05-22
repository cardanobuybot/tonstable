import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, toNano } from '@ton/core';
import {
    TonstableMinter,
    AllowlistAdd,
    AllowlistRemove,
    SetAllowlistEnabled,
    DepositTon,
    MintConfirmation,
    PriceUpdate,
    JettonBurnNotification,
} from '../wrappers/TonstableMinter';
import { TonstableJettonWallet, JettonBurn } from '../wrappers/TonstableJettonWallet';
import '@ton/test-utils';

const PRICE          = 3_000_000_000n; // $3/TON × 1e9
const NOW            = 1_700_000_000;
const DEPOSIT_AMOUNT = toNano('5');
const DEADLINE       = BigInt(NOW + 3600);
const ACTUAL_LUSD    = 13_000_000n;    // ~13 TONSTBL in 1e6 scale

function emptyContent() {
    return beginCell().endCell();
}

describe('Allowlist guard', () => {
    let blockchain:    Blockchain;
    let owner:         SandboxContract<TreasuryContract>;
    let guardian:      SandboxContract<TreasuryContract>;
    let bridgeAdapter: SandboxContract<TreasuryContract>;
    let oracleKeeper:  SandboxContract<TreasuryContract>;
    let user:          SandboxContract<TreasuryContract>;
    let stranger:      SandboxContract<TreasuryContract>;
    let minter:        SandboxContract<TonstableMinter>;

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        blockchain.now = NOW;

        owner         = await blockchain.treasury('owner');
        guardian      = await blockchain.treasury('guardian');
        bridgeAdapter = await blockchain.treasury('bridgeAdapter');
        oracleKeeper  = await blockchain.treasury('oracleKeeper');
        user          = await blockchain.treasury('user');
        stranger      = await blockchain.treasury('stranger');

        minter = blockchain.openContract(
            await TonstableMinter.fromInit(
                owner.address,
                guardian.address,
                bridgeAdapter.address,
                oracleKeeper.address,
                emptyContent(),
            ),
        );

        await minter.send(
            owner.getSender(),
            { value: toNano('0.1') },
            { $$type: 'Deploy', queryId: 0n },
        );

        await minter.send(
            oracleKeeper.getSender(),
            { value: toNano('0.05') },
            { $$type: 'PriceUpdate', price: PRICE, timestamp: BigInt(NOW) } satisfies PriceUpdate,
        );
    });

    // ── shared helpers ────────────────────────────────────────────────────────

    async function allowlistAdd(addr: Address) {
        await minter.send(owner.getSender(), { value: toNano('0.05') }, {
            $$type: 'AllowlistAdd', addr,
        } satisfies AllowlistAdd);
    }

    async function allowlistRemove(addr: Address) {
        await minter.send(owner.getSender(), { value: toNano('0.05') }, {
            $$type: 'AllowlistRemove', addr,
        } satisfies AllowlistRemove);
    }

    // Adds user to allowlist, does DepositTon → returns nonce 0n
    async function doAllowlistedDeposit(): Promise<bigint> {
        await allowlistAdd(user.address);
        await minter.send(user.getSender(), { value: DEPOSIT_AMOUNT }, {
            $$type: 'DepositTon', minTonstblOut: 0n, deadline: DEADLINE,
        } satisfies DepositTon);
        return 0n;
    }

    async function doMintConfirmation(nonce: bigint) {
        return minter.send(bridgeAdapter.getSender(), { value: toNano('0.5') }, {
            $$type:      'MintConfirmation',
            nonce,
            actualLusd:  ACTUAL_LUSD,
            arbTxHash:   0xdeadbeefn,
        } satisfies MintConfirmation);
    }

    // ── A. allowlistEnabled=true (default) ───────────────────────────────────

    describe('A. allowlistEnabled=true (default)', () => {
        it('A1. DepositTon от non-allowlisted user → revert', async () => {
            const result = await minter.send(user.getSender(), { value: DEPOSIT_AMOUNT }, {
                $$type: 'DepositTon', minTonstblOut: 0n, deadline: DEADLINE,
            } satisfies DepositTon);

            expect(result.transactions).toHaveTransaction({
                from: user.address, to: minter.address, success: false,
            });
        });

        it('A2. AllowlistAdd(user) → DepositTon passes', async () => {
            await allowlistAdd(user.address);

            const result = await minter.send(user.getSender(), { value: DEPOSIT_AMOUNT }, {
                $$type: 'DepositTon', minTonstblOut: 0n, deadline: DEADLINE,
            } satisfies DepositTon);

            expect(result.transactions).toHaveTransaction({
                from: user.address, to: minter.address, success: true,
            });
        });

        it('A3. AllowlistRemove(user) → снова revert', async () => {
            await allowlistAdd(user.address);

            const passResult = await minter.send(user.getSender(), { value: DEPOSIT_AMOUNT }, {
                $$type: 'DepositTon', minTonstblOut: 0n, deadline: DEADLINE,
            } satisfies DepositTon);
            expect(passResult.transactions).toHaveTransaction({
                from: user.address, to: minter.address, success: true,
            });

            await allowlistRemove(user.address);

            const revertResult = await minter.send(user.getSender(), { value: DEPOSIT_AMOUNT }, {
                $$type: 'DepositTon', minTonstblOut: 0n, deadline: DEADLINE,
            } satisfies DepositTon);
            expect(revertResult.transactions).toHaveTransaction({
                from: user.address, to: minter.address, success: false,
            });
        });
    });

    // ── B. allowlistEnabled=false ─────────────────────────────────────────────

    describe('B. allowlistEnabled=false', () => {
        beforeEach(async () => {
            await minter.send(owner.getSender(), { value: toNano('0.05') }, {
                $$type: 'SetAllowlistEnabled', enabled: false,
            } satisfies SetAllowlistEnabled);
        });

        it('B1. DepositTon от stranger (никогда не в allowlist) → passes', async () => {
            const result = await minter.send(stranger.getSender(), { value: DEPOSIT_AMOUNT }, {
                $$type: 'DepositTon', minTonstblOut: 0n, deadline: DEADLINE,
            } satisfies DepositTon);

            expect(result.transactions).toHaveTransaction({
                from: stranger.address, to: minter.address, success: true,
            });
        });
    });

    // ── C. Admin access control ───────────────────────────────────────────────

    describe('C. Admin access control', () => {
        it('C1. AllowlistAdd от non-owner → revert', async () => {
            const result = await minter.send(user.getSender(), { value: toNano('0.05') }, {
                $$type: 'AllowlistAdd', addr: user.address,
            } satisfies AllowlistAdd);
            expect(result.transactions).toHaveTransaction({
                from: user.address, to: minter.address, success: false,
            });
        });

        it('C2. AllowlistRemove от non-owner → revert', async () => {
            await allowlistAdd(user.address);

            const result = await minter.send(user.getSender(), { value: toNano('0.05') }, {
                $$type: 'AllowlistRemove', addr: user.address,
            } satisfies AllowlistRemove);
            expect(result.transactions).toHaveTransaction({
                from: user.address, to: minter.address, success: false,
            });
        });

        it('C3. SetAllowlistEnabled от non-owner → revert', async () => {
            const result = await minter.send(user.getSender(), { value: toNano('0.05') }, {
                $$type: 'SetAllowlistEnabled', enabled: false,
            } satisfies SetAllowlistEnabled);
            expect(result.transactions).toHaveTransaction({
                from: user.address, to: minter.address, success: false,
            });
        });

        it('C4. owner AllowlistAdd → getter allowlistInfo.isAllowed = true', async () => {
            let info = await minter.getAllowlistInfo(user.address);
            expect(info.isAllowed).toBe(false);
            expect(info.enabled).toBe(true);

            await allowlistAdd(user.address);

            info = await minter.getAllowlistInfo(user.address);
            expect(info.isAllowed).toBe(true);
            expect(info.enabled).toBe(true);
        });

        it('C5. owner AllowlistRemove → getter allowlistInfo.isAllowed = false', async () => {
            await allowlistAdd(user.address);
            expect((await minter.getAllowlistInfo(user.address)).isAllowed).toBe(true);

            await allowlistRemove(user.address);

            expect((await minter.getAllowlistInfo(user.address)).isAllowed).toBe(false);
        });

        it('C6. owner SetAllowlistEnabled(false) → getter allowlistInfo.enabled = false', async () => {
            expect((await minter.getAllowlistInfo(user.address)).enabled).toBe(true);

            await minter.send(owner.getSender(), { value: toNano('0.05') }, {
                $$type: 'SetAllowlistEnabled', enabled: false,
            } satisfies SetAllowlistEnabled);

            expect((await minter.getAllowlistInfo(user.address)).enabled).toBe(false);
        });
    });

    // ── D. Inbound mint не заперт allowlist'ом ────────────────────────────────

    describe('D. Inbound mint не заперт allowlist\'ом', () => {
        let nonce: bigint;

        beforeEach(async () => {
            nonce = await doAllowlistedDeposit(); // creates pendingMints[0]
        });

        it('D1. MintConfirmation от bridgeAdapter при allowlistEnabled=true → passes, totalSupply растёт', async () => {
            const result = await doMintConfirmation(nonce);

            expect(result.transactions).toHaveTransaction({
                from: bridgeAdapter.address, to: minter.address, success: true,
            });
            expect(await minter.getTotalSupplyOf()).toBe(ACTUAL_LUSD);
        });

        it('D2. MintConfirmation от non-bridge (user) → revert "minter: bridge only"', async () => {
            const result = await minter.send(user.getSender(), { value: toNano('0.5') }, {
                $$type:      'MintConfirmation',
                nonce,
                actualLusd:  ACTUAL_LUSD,
                arbTxHash:   0n,
            } satisfies MintConfirmation);

            expect(result.transactions).toHaveTransaction({
                from: user.address, to: minter.address, success: false,
            });
            expect(await minter.getTotalSupplyOf()).toBe(0n);
        });

        it('D3. retroactive: AllowlistRemove после DepositTon → MintConfirmation всё равно passes', async () => {
            // pendingMints[nonce] уже создан в beforeEach — снимаем юзера
            await allowlistRemove(user.address);
            expect((await minter.getAllowlistInfo(user.address)).isAllowed).toBe(false);

            // in-flight mint проходит — AllowlistRemove не ретроактивен
            const result = await doMintConfirmation(nonce);
            expect(result.transactions).toHaveTransaction({
                from: bridgeAdapter.address, to: minter.address, success: true,
            });
            expect(await minter.getTotalSupplyOf()).toBe(ACTUAL_LUSD);
        });
    });

    // ── E. JettonBurnNotification — guard по msg.owner, не sender() ───────────

    describe('E. JettonBurnNotification — guard по msg.owner, не sender()', () => {
        let userWallet: SandboxContract<TonstableJettonWallet>;

        beforeEach(async () => {
            const nonce = await doAllowlistedDeposit();
            await doMintConfirmation(nonce);

            const walletAddr = await minter.getGetWalletAddress(user.address);
            userWallet = blockchain.openContract(TonstableJettonWallet.fromAddress(walletAddr));
            expect(await userWallet.getBalance()).toBe(ACTUAL_LUSD);
        });

        it('E1. msg.owner НЕ в allowlist (enabled=true) → revert, wallet восстанавливает баланс', async () => {
            await allowlistRemove(user.address);
            expect((await minter.getAllowlistInfo(user.address)).isAllowed).toBe(false);

            // user sends JettonBurn → wallet sends JettonBurnNotification → minter reverts
            const result = await userWallet.send(
                user.getSender(),
                { value: toNano('0.3') },
                {
                    $$type:              'JettonBurn',
                    queryId:             1n,
                    amount:              ACTUAL_LUSD,
                    responseDestination: user.address,
                    customPayload:       null,
                } satisfies JettonBurn,
            );

            // minter rejects JettonBurnNotification
            expect(result.transactions).toHaveTransaction({
                from: userWallet.address, to: minter.address, success: false,
            });
            // bounced<JettonBurnNotification> → wallet restores balance
            expect(await userWallet.getBalance()).toBe(ACTUAL_LUSD);
            // totalSupply unchanged
            expect(await minter.getTotalSupplyOf()).toBe(ACTUAL_LUSD);
        });

        it('E2. msg.owner В allowlist, sender — рандомный адрес → revert "minter: invalid wallet"', async () => {
            // user IS still allowlisted. stranger sends JettonBurnNotification directly.
            // Allowlist check passes (msg.owner=user ∈ allowlist), wallet check fails.
            const result = await minter.send(
                stranger.getSender(),
                { value: toNano('0.1') },
                {
                    $$type:              'JettonBurnNotification',
                    queryId:             1n,
                    amount:              ACTUAL_LUSD,
                    owner:               user.address,
                    responseDestination: user.address,
                } satisfies JettonBurnNotification,
            );

            expect(result.transactions).toHaveTransaction({
                from: stranger.address, to: minter.address, success: false,
            });
            // totalSupply unchanged — fake burn rejected
            expect(await minter.getTotalSupplyOf()).toBe(ACTUAL_LUSD);
        });

        it('E3. msg.owner В allowlist, sender — легитимный JettonWallet → passes, totalSupply падает', async () => {
            expect(await minter.getTotalSupplyOf()).toBe(ACTUAL_LUSD);

            const result = await userWallet.send(
                user.getSender(),
                { value: toNano('0.3') },
                {
                    $$type:              'JettonBurn',
                    queryId:             2n,
                    amount:              ACTUAL_LUSD,
                    responseDestination: user.address,
                    customPayload:       null,
                } satisfies JettonBurn,
            );

            // wallet → minter: accepted
            expect(result.transactions).toHaveTransaction({
                from: userWallet.address, to: minter.address, success: true,
            });
            // minter → bridgeAdapter: BridgeRedeemRequest sent
            expect(result.transactions).toHaveTransaction({
                from: minter.address, to: bridgeAdapter.address, success: true,
            });
            expect(await minter.getTotalSupplyOf()).toBe(0n);
            expect(await userWallet.getBalance()).toBe(0n);
        });
    });
});
