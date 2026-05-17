// ============================================================================
//  TonstableMinter.tact  ·  итерация 3
//  Точка входа TONSTABLE на сети TON + Jetton Master.
//
//  Новое в этой итерации:
//    ─ receive(MintConfirmation)    ← реальный mint TONSTBL юзеру
//    ─ receive(MintFailure)         ← refund при отказе на Arbitrum
//    ─ walletInit / walletAddressOf ← детерминированный адрес кошелька юзера
//    ─ get_wallet_address / get_jetton_data — TEP-74 совместимые getter'ы
//
//  Сохранено из итерации 2:
//    ─ receive(DepositTon), receive(PriceUpdate), bounced<BridgeMintRequest>
//    ─ Вся fee-математика, oracle защиты, admin, circuit breaker
//
//  TEP-74 message-типы импортируются из TonstableJettonWallet.tact —
//  один источник истины, никакой дупликации.
// ============================================================================

import "@stdlib/deploy";
import "@stdlib/ownable";
import "./tonstable_jetton_wallet";

// Two-step ownership transfer: current owner proposes, pending owner accepts.
// This prevents irrecoverable loss of control when migrating to a multisig.
message ProposeOwner        { newOwner: Address; }
message AcceptOwnership     { }
message CancelOwnerProposal { }


// ─────────────────────────────────────────────────────────────────────────────
//  КОНСТАНТЫ
// ─────────────────────────────────────────────────────────────────────────────

const NANO_PER_TON:    Int = 1_000_000_000;
const PRICE_DECIMALS:  Int = 100_000_000;
const TONSTBL_SCALE:   Int = 1_000_000;
const BPS_DENOMINATOR: Int = 10_000;

const DEFAULT_FEE_BPS:           Int = 30;
const DEFAULT_FEE_FLOOR:         Int = 500_000_000;
const DEFAULT_MIN_DEPOSIT:       Int = 2_000_000_000;
const DEFAULT_BRIDGE_GAS:        Int = 300_000_000;
const DEFAULT_MINT_RESERVE:      Int = 150_000_000;
const DEFAULT_ORACLE_MAX_STALE:  Int = 300;
const DEFAULT_PENDING_TIMEOUT:   Int = 48 * 3600;

const MAX_FEE_BPS:               Int = 100;
const MAX_FEE_FLOOR:             Int = 5_000_000_000;
const MAX_PRICE_DEVIATION_PCT:   Int = 50;

// Sanity ceiling на actualLusd при MintConfirmation:
//   реально пришедшее значение НЕ может превышать quote более чем на N%.
//   Защита от багов Arbitrum-стороны / манипуляции моста. При штатном
//   slippage actualLusd всегда МЕНЬШЕ quote, поэтому верхняя граница —
//   именно sanity check, а не slippage-протекшн (этим занимается Vault).
const MINT_QUOTE_CEILING_PCT:    Int = 110;


// ─────────────────────────────────────────────────────────────────────────────
//  СООБЩЕНИЯ
// ─────────────────────────────────────────────────────────────────────────────

message(0x544E5301) DepositTon {
    minTonstblOut: Int as uint128;
    deadline:      Int as uint64;
}

message(0x544E5302) MintConfirmation {
    nonce:      Int as uint64;
    actualLusd: Int as uint128;            // 10^6 шкала (= TONSTBL_SCALE)
    arbTxHash:  Int as uint256;
}

message(0x544E5303) MintFailure {
    nonce:       Int as uint64;
    reasonCode:  Int as uint8;
    refundedTon: Int as coins;             // декларация: сколько ВЕРНУЛОСЬ
                                            // (фактическое = ctx.value)
}

message(0x544E5304) RedeemPayout {
    nonce:     Int as uint64;
    arbTxHash: Int as uint256;
}

message(0x544E5305) RedeemFailure {
    nonce:      Int as uint64;
    reasonCode: Int as uint8;
}

message(0x544E5320) PriceUpdate {
    price:     Int as uint128;
    timestamp: Int as uint64;
}

message SetGuardian       { newGuardian: Address; }
message SetBridgeAdapter  { newAdapter: Address; }
message SetOracleKeeper   { newKeeper: Address; maxStalenessSec: Int as uint32; }
message SetFeeParams      { feeBps: Int as uint16; feeFloor: Int as coins; }
message SetOpReserves     { bridgeForwardGas: Int as coins; internalMintReserve: Int as coins; }
message Pause             { }
message Unpause           { }
message CancelPending     { nonce: Int as uint64; }


// ─────────────────────────────────────────────────────────────────────────────
//  ИСХОДЯЩИЕ
// ─────────────────────────────────────────────────────────────────────────────

message(0x544E5310) BridgeMintRequest {
    nonce:      Int as uint64;            // ← первым, для bounced<>
    userTon:    Address;
    usdValue:   Int as uint128;
    minLusdOut: Int as uint128;
    deadline:   Int as uint64;
}

message(0x544E5311) BridgeRedeemRequest {
    nonce:         Int as uint64;         // ← первым, для bounced<>
    userTon:       Address;
    tonstblBurned: Int as uint128;
    deadline:      Int as uint64;
}


// ─────────────────────────────────────────────────────────────────────────────
//  СТРУКТУРЫ
// ─────────────────────────────────────────────────────────────────────────────

struct PendingMint {
    user:           Address;
    tonDeposited:   Int as coins;
    tonNet:         Int as coins;
    quotedUsdValue: Int as uint128;
    minTonstblOut:  Int as uint128;
    createdAt:      Int as uint64;
    deadline:       Int as uint64;
}

struct PendingRedeem {
    user:          Address;
    tonstblBurned: Int as coins;
    createdAt:     Int as uint64;
}

struct JettonMasterData {
    totalSupply: Int as coins;
    mintable:    Bool;
    adminAddress: Address;
    jettonContent: Cell;
    jettonWalletCode: Cell;
}


// ─────────────────────────────────────────────────────────────────────────────
//  CONTRACT
// ─────────────────────────────────────────────────────────────────────────────

contract TonstableMinter with Deployable, Ownable {
    owner:               Address;
    pendingOwner:        Address?;
    guardian:            Address;
    bridgeAdapter:       Address;
    oracleKeeper:        Address;

    feeBps:              Int as uint16;
    feeFloor:            Int as coins;
    minDepositTon:       Int as coins;
    oracleMaxStaleness:  Int as uint32;
    bridgeForwardGas:    Int as coins;
    internalMintReserve: Int as coins;

    cachedTonUsdPrice:   Int as uint128;
    cachedTonUsdPriceTs: Int as uint64;

    totalSupply:    Int as coins;
    jettonContent:  Cell;
    mintable:       Bool;

    nextNonce:       Int as uint64;
    pendingMints:    map<Int as uint64, PendingMint>;
    pendingRedeems:  map<Int as uint64, PendingRedeem>;

    paused:         Bool;
    pendingTimeout: Int as uint32;


    init(
        owner:         Address,
        guardian:      Address,
        bridgeAdapter: Address,
        oracleKeeper:  Address,
        jettonContent: Cell,
    ) {
        self.owner               = owner;
        self.pendingOwner        = null;
        self.guardian            = guardian;
        self.bridgeAdapter       = bridgeAdapter;
        self.oracleKeeper        = oracleKeeper;
        self.feeBps              = DEFAULT_FEE_BPS;
        self.feeFloor            = DEFAULT_FEE_FLOOR;
        self.minDepositTon       = DEFAULT_MIN_DEPOSIT;
        self.oracleMaxStaleness  = DEFAULT_ORACLE_MAX_STALE;
        self.bridgeForwardGas    = DEFAULT_BRIDGE_GAS;
        self.internalMintReserve = DEFAULT_MINT_RESERVE;
        self.cachedTonUsdPrice   = 0;
        self.cachedTonUsdPriceTs = 0;
        self.totalSupply         = 0;
        self.jettonContent       = jettonContent;
        self.mintable            = true;
        self.nextNonce           = 0;
        self.pendingMints        = emptyMap();
        self.pendingRedeems      = emptyMap();
        self.paused              = false;
        self.pendingTimeout      = DEFAULT_PENDING_TIMEOUT;
    }


    fun walletInitOf(owner: Address): StateInit {
        return initOf TonstableJettonWallet(owner, myAddress());
    }

    fun _walletAddress(owner: Address): Address {
        return contractAddress(self.walletInitOf(owner));
    }


    receive(msg: DepositTon) {
        require(!self.paused, "minter: paused");
        require(msg.deadline > now(), "minter: deadline expired");

        let ctx: Context = context();
        let depositTon: Int = ctx.value;
        let user: Address = ctx.sender;

        require(depositTon >= self.minDepositTon, "minter: below min deposit");

        let feePct: Int = (depositTon * self.feeBps) / BPS_DENOMINATOR;
        let fee: Int = feePct > self.feeFloor ? feePct : self.feeFloor;
        require(fee >= self.bridgeForwardGas + self.internalMintReserve,
                "minter: fee < op reserves (misconfig)");

        let net: Int = depositTon - fee;
        require(net > 0, "minter: net <= 0");

        require(self.cachedTonUsdPriceTs > 0, "oracle: not initialized");
        let age: Int = now() - self.cachedTonUsdPriceTs;
        require(age >= 0, "oracle: future timestamp");
        require(age <= self.oracleMaxStaleness, "oracle: price stale");
        let price: Int = self.cachedTonUsdPrice;
        require(price > 0, "oracle: invalid price");

        let usdValue: Int = (net * price) / NANO_PER_TON;
        require(usdValue > 0, "minter: usd value rounds to 0");

        let nonce: Int = self.nextNonce;
        self.nextNonce = nonce + 1;

        self.pendingMints.set(nonce, PendingMint{
            user:           user,
            tonDeposited:   depositTon,
            tonNet:         net,
            quotedUsdValue: usdValue,
            minTonstblOut:  msg.minTonstblOut,
            createdAt:      now(),
            deadline:       msg.deadline,
        });

        let bridgeMsgValue: Int = net + self.bridgeForwardGas;

        send(SendParameters{
            to:     self.bridgeAdapter,
            value:  bridgeMsgValue,
            bounce: true,
            mode:   0,
            body:   BridgeMintRequest{
                nonce:      nonce,
                userTon:    user,
                usdValue:   usdValue,
                minLusdOut: msg.minTonstblOut,
                deadline:   msg.deadline,
            }.toCell(),
        });

        emit(beginCell()
            .storeUint(0x544E5301, 32)
            .storeUint(nonce, 64)
            .storeAddress(user)
            .storeCoins(depositTon)
            .storeCoins(fee)
            .storeCoins(net)
            .storeUint(usdValue, 128)
            .endCell());
    }


    receive(msg: MintConfirmation) {
        require(sender() == self.bridgeAdapter, "minter: bridge only");
        require(self.mintable, "minter: minting disabled");

        let pendingOpt: PendingMint? = self.pendingMints.get(msg.nonce);
        require(pendingOpt != null, "minter: unknown nonce");
        let p: PendingMint = pendingOpt!!;

        require(msg.actualLusd > 0, "mint: zero actualLusd");

        let actualScaled: Int = msg.actualLusd * 100;
        let maxAllowed: Int = (p.quotedUsdValue * MINT_QUOTE_CEILING_PCT) / 100;
        require(actualScaled <= maxAllowed, "mint: actualLusd > 110% quote (suspicious)");

        self.pendingMints.del(msg.nonce);
        self.totalSupply = self.totalSupply + msg.actualLusd;

        let walletInit: StateInit = self.walletInitOf(p.user);
        let walletAddr: Address = self._walletAddress(p.user);

        send(SendParameters{
            to:     walletAddr,
            value:  self.internalMintReserve,
            bounce: true,
            mode:   0,
            body:   JettonTransferInternal{
                queryId:             msg.nonce,
                amount:              msg.actualLusd,
                from:                myAddress(),
                responseDestination: p.user,
                forwardAmount:       0,
                forwardPayload:      emptySlice(),
            }.toCell(),
            code: walletInit.code,
            data: walletInit.data,
        });

        emit(beginCell()
            .storeUint(0x544E5302, 32)
            .storeUint(msg.nonce, 64)
            .storeAddress(p.user)
            .storeCoins(msg.actualLusd)
            .storeUint(msg.arbTxHash, 256)
            .endCell());
    }


    receive(msg: MintFailure) {
        require(sender() == self.bridgeAdapter, "minter: bridge only");

        let pendingOpt: PendingMint? = self.pendingMints.get(msg.nonce);
        require(pendingOpt != null, "minter: unknown nonce");
        let p: PendingMint = pendingOpt!!;

        let ctx: Context = context();
        let actualRefund: Int = ctx.value;

        self.pendingMints.del(msg.nonce);

        send(SendParameters{
            to:     p.user,
            value:  0,
            bounce: false,
            mode:   SendRemainingValue + SendIgnoreErrors,
            body:   "TONSTBL: deposit refunded (mint failed on Arbitrum)".asComment(),
        });

        emit(beginCell()
            .storeUint(0x544E5303, 32)
            .storeUint(msg.nonce, 64)
            .storeAddress(p.user)
            .storeUint(msg.reasonCode, 8)
            .storeCoins(msg.refundedTon)
            .storeCoins(actualRefund)
            .endCell());
    }


    bounced(msg: bounced<BridgeMintRequest>) {
        let pending: PendingMint? = self.pendingMints.get(msg.nonce);
        if (pending == null) { return; }

        let p: PendingMint = pending!!;
        self.pendingMints.del(msg.nonce);

        send(SendParameters{
            to:     p.user,
            value:  0,
            bounce: false,
            mode:   SendRemainingValue + SendIgnoreErrors,
            body:   "TONSTBL: deposit refunded (bridge unreachable)".asComment(),
        });

        emit(beginCell()
            .storeUint(0x544E53F1, 32)
            .storeUint(msg.nonce, 64)
            .storeAddress(p.user)
            .storeCoins(p.tonNet)
            .endCell());
    }


    receive(msg: PriceUpdate) {
        require(sender() == self.oracleKeeper, "oracle: keeper only");
        require(msg.price > 0, "oracle: invalid price");
        require(msg.timestamp > self.cachedTonUsdPriceTs, "oracle: not newer");
        require(msg.timestamp <= now() + 60, "oracle: future timestamp");
        require(now() - msg.timestamp <= self.oracleMaxStaleness * 2,
                "oracle: update is itself too old");

        if (self.cachedTonUsdPrice > 0) {
            let prev: Int = self.cachedTonUsdPrice;
            let delta: Int = msg.price > prev ? msg.price - prev : prev - msg.price;
            let maxDelta: Int = (prev * MAX_PRICE_DEVIATION_PCT) / 100;
            require(delta <= maxDelta, "oracle: deviation > 50%");
        }

        self.cachedTonUsdPrice   = msg.price;
        self.cachedTonUsdPriceTs = msg.timestamp;
    }


    // ── Two-step ownership transfer ──────────────────────────────────────────

    receive(msg: ProposeOwner) {
        self.requireOwner();
        require(msg.newOwner != myAddress(), "ownership: cannot propose self");
        self.pendingOwner = msg.newOwner;
    }

    receive(_: AcceptOwnership) {
        let pending: Address? = self.pendingOwner;
        require(pending != null, "ownership: no pending proposal");
        require(sender() == pending!!, "ownership: not pending owner");
        self.owner        = pending!!;
        self.pendingOwner = null;
    }

    receive(_: CancelOwnerProposal) {
        self.requireOwner();
        self.pendingOwner = null;
    }

    // ─────────────────────────────────────────────────────────────────────────

    receive(msg: SetFeeParams) {
        self.requireOwner();
        require(msg.feeBps <= MAX_FEE_BPS, "fee: bps > cap");
        require(msg.feeFloor <= MAX_FEE_FLOOR, "fee: floor > cap");
        require(msg.feeFloor >= self.bridgeForwardGas + self.internalMintReserve,
                "fee: floor < op reserves");
        self.feeBps   = msg.feeBps;
        self.feeFloor = msg.feeFloor;
    }

    receive(msg: SetOpReserves) {
        self.requireOwner();
        require(msg.bridgeForwardGas <= ton("1"), "op: bridge gas > 1 TON");
        require(msg.internalMintReserve <= ton("1"), "op: mint reserve > 1 TON");
        require(self.feeFloor >= msg.bridgeForwardGas + msg.internalMintReserve,
                "op: feeFloor cannot cover new reserves");
        self.bridgeForwardGas    = msg.bridgeForwardGas;
        self.internalMintReserve = msg.internalMintReserve;
    }

    receive(msg: SetOracleKeeper) {
        self.requireOwner();
        self.oracleKeeper       = msg.newKeeper;
        self.oracleMaxStaleness = msg.maxStalenessSec;
    }

    receive(msg: SetGuardian)      { self.requireOwner(); self.guardian = msg.newGuardian; }
    receive(msg: SetBridgeAdapter) { self.requireOwner(); self.bridgeAdapter = msg.newAdapter; }

    receive(msg: Pause) {
        require(sender() == self.guardian || sender() == self.owner, "auth: guardian/owner");
        self.paused = true;
    }
    receive(msg: Unpause) { self.requireOwner(); self.paused = false; }


    receive(msg: JettonBurnNotification) {
        require(!self.paused, "minter: paused");
        // Verify the sender is the legitimate JettonWallet for msg.owner
        require(sender() == self._walletAddress(msg.owner), "minter: invalid wallet");
        require(msg.amount > 0, "minter: zero burn");

        let nonce: Int = self.nextNonce;
        self.nextNonce = nonce + 1;

        self.pendingRedeems.set(nonce, PendingRedeem{
            user:          msg.owner,
            tonstblBurned: msg.amount,
            createdAt:     now(),
        });
        self.totalSupply = self.totalSupply - msg.amount;

        send(SendParameters{
            to:     self.bridgeAdapter,
            value:  0,
            bounce: true,
            mode:   SendRemainingValue,
            body:   BridgeRedeemRequest{
                nonce:         nonce,
                userTon:       msg.owner,
                tonstblBurned: msg.amount,
                deadline:      now() + self.pendingTimeout,
            }.toCell(),
        });

        emit(beginCell()
            .storeUint(0x544E5306, 32)
            .storeUint(nonce, 64)
            .storeAddress(msg.owner)
            .storeCoins(msg.amount)
            .endCell());
    }

    bounced(msg: bounced<BridgeRedeemRequest>) {
        let p: PendingRedeem? = self.pendingRedeems.get(msg.nonce);
        if (p == null) { return; }
        let redeem: PendingRedeem = p!!;

        self.pendingRedeems.del(msg.nonce);
        self.totalSupply = self.totalSupply + redeem.tonstblBurned;

        // Re-mint the burned tokens so the user doesn't lose them
        let walletInit: StateInit = self.walletInitOf(redeem.user);
        send(SendParameters{
            to:     contractAddress(walletInit),
            value:  self.internalMintReserve,
            bounce: false,
            mode:   SendPayGasSeparately,
            body:   JettonTransferInternal{
                queryId:             msg.nonce,
                amount:              redeem.tonstblBurned,
                from:                myAddress(),
                responseDestination: redeem.user,
                forwardAmount:       0,
                forwardPayload:      emptySlice(),
            }.toCell(),
            code:   walletInit.code,
            data:   walletInit.data,
        });

        emit(beginCell()
            .storeUint(0x544E53F2, 32)
            .storeUint(msg.nonce, 64)
            .storeCoins(redeem.tonstblBurned)
            .endCell());
    }

    receive(msg: RedeemPayout) {
        require(sender() == self.bridgeAdapter, "minter: bridge only");

        let p: PendingRedeem? = self.pendingRedeems.get(msg.nonce);
        require(p != null, "minter: unknown nonce");
        let redeem: PendingRedeem = p!!;

        self.pendingRedeems.del(msg.nonce);

        let ctx: Context = context();
        let grossPayout: Int = ctx.value;

        let feePct: Int = (grossPayout * self.feeBps) / BPS_DENOMINATOR;
        let fee: Int = feePct > self.feeFloor ? feePct : self.feeFloor;
        require(grossPayout > fee, "redeem: payout below fee floor");
        let netPayout: Int = grossPayout - fee;

        send(SendParameters{
            to:     redeem.user,
            value:  netPayout,
            bounce: false,
            mode:   SendPayGasSeparately + SendIgnoreErrors,
            body:   "TONSTBL: redeem confirmed".asComment(),
        });

        emit(beginCell()
            .storeUint(0x544E5304, 32)
            .storeUint(msg.nonce, 64)
            .storeAddress(redeem.user)
            .storeCoins(redeem.tonstblBurned)
            .storeCoins(fee)
            .storeUint(msg.arbTxHash, 256)
            .endCell());
    }

    receive(msg: RedeemFailure) {
        require(sender() == self.bridgeAdapter, "minter: bridge only");

        let p: PendingRedeem? = self.pendingRedeems.get(msg.nonce);
        require(p != null, "minter: unknown nonce");
        let redeem: PendingRedeem = p!!;

        self.pendingRedeems.del(msg.nonce);
        self.totalSupply = self.totalSupply + redeem.tonstblBurned;

        // Re-mint the burned tokens back to the user's wallet
        let walletInit: StateInit = self.walletInitOf(redeem.user);
        send(SendParameters{
            to:     contractAddress(walletInit),
            value:  self.internalMintReserve,
            bounce: false,
            mode:   SendPayGasSeparately,
            body:   JettonTransferInternal{
                queryId:             msg.nonce,
                amount:              redeem.tonstblBurned,
                from:                myAddress(),
                responseDestination: redeem.user,
                forwardAmount:       0,
                forwardPayload:      emptySlice(),
            }.toCell(),
            code:   walletInit.code,
            data:   walletInit.data,
        });

        emit(beginCell()
            .storeUint(0x544E5305, 32)
            .storeUint(msg.nonce, 64)
            .storeAddress(redeem.user)
            .storeCoins(redeem.tonstblBurned)
            .storeUint(msg.reasonCode, 8)
            .endCell());
    }

    receive(msg: CancelPending) {
        self.requireOwner();

        // Check pending mints first
        let pm: PendingMint? = self.pendingMints.get(msg.nonce);
        if (pm != null) {
            let mint: PendingMint = pm!!;
            require(now() >= mint.createdAt + self.pendingTimeout, "minter: not timed out");
            self.pendingMints.del(msg.nonce);

            // Deposited TON already forwarded to the bridge; we cannot refund here.
            // Real recovery flows through RedeemFailure or bounced<BridgeMintRequest>.
            emit(beginCell()
                .storeUint(0x544E53F3, 32)
                .storeUint(msg.nonce, 64)
                .storeAddress(mint.user)
                .storeCoins(mint.tonNet)
                .endCell());
            return;
        }

        // Then check pending redeems
        let pr: PendingRedeem? = self.pendingRedeems.get(msg.nonce);
        require(pr != null, "minter: nonce not found");
        let redeem: PendingRedeem = pr!!;
        require(now() >= redeem.createdAt + self.pendingTimeout, "minter: not timed out");

        self.pendingRedeems.del(msg.nonce);
        self.totalSupply = self.totalSupply + redeem.tonstblBurned;

        let walletInit: StateInit = self.walletInitOf(redeem.user);
        send(SendParameters{
            to:     contractAddress(walletInit),
            value:  self.internalMintReserve,
            bounce: false,
            mode:   SendPayGasSeparately,
            body:   JettonTransferInternal{
                queryId:             msg.nonce,
                amount:              redeem.tonstblBurned,
                from:                myAddress(),
                responseDestination: redeem.user,
                forwardAmount:       0,
                forwardPayload:      emptySlice(),
            }.toCell(),
            code:   walletInit.code,
            data:   walletInit.data,
        });
    }


    get fun get_jetton_data(): JettonMasterData {
        return JettonMasterData{
            totalSupply:      self.totalSupply,
            mintable:         self.mintable,
            adminAddress:     self.owner,
            jettonContent:    self.jettonContent,
            jettonWalletCode: initOf TonstableJettonWallet(myAddress(), myAddress()).code,
        };
    }

    get fun get_wallet_address(owner: Address): Address {
        return self.walletAddressOf(owner);
    }

    get fun walletAddressOf(owner: Address): Address {
        return contractAddress(initOf TonstableJettonWallet(owner, myAddress()));
    }

    get fun feePreview(amount: Int): Int {
        let pct: Int = (amount * self.feeBps) / BPS_DENOMINATOR;
        return pct > self.feeFloor ? pct : self.feeFloor;
    }

    get fun quotePreview(amount: Int): Int {
        if (self.cachedTonUsdPriceTs == 0) { return 0; }
        if (now() - self.cachedTonUsdPriceTs > self.oracleMaxStaleness) { return 0; }
        let pct: Int = (amount * self.feeBps) / BPS_DENOMINATOR;
        let fee: Int = pct > self.feeFloor ? pct : self.feeFloor;
        if (amount <= fee) { return 0; }
        let net: Int = amount - fee;
        return (net * self.cachedTonUsdPrice) / NANO_PER_TON;
    }

    get fun pendingMint(nonce: Int): PendingMint {
        return self.pendingMints.get(nonce)!!;
    }

    get fun totalSupplyOf(): Int { return self.totalSupply; }
    get fun isPaused(): Bool { return self.paused; }
    get fun getPendingOwner(): Address? { return self.pendingOwner; }
}
