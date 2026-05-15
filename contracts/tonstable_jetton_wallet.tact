// ============================================================================
//  TonstableJettonWallet.tact
//  TEP-74 совместимый Jetton Wallet для TONSTBL.
//
//  Деплоится детерминированно мастером (TonstableMinter) через
//  initOf TonstableJettonWallet(owner, master). Адрес каждого кошелька
//  однозначно вычисляется из (owner, master) — критично для безопасности:
//  master при минте посылает в этот адрес, а кошелёк сверяет, что отправитель
//  — это либо master, либо легитимный sibling-wallet.
//
//  В этой итерации реализован только приём (mint flow): JettonTransferInternal.
//  Transfer и Burn — заглушки, будут раскрыты в итерации 4 (redeem flow).
// ============================================================================

import "@stdlib/deploy";


// ─────────────────────────────────────────────────────────────────────────────
//  TEP-74 опкоды (зафиксированы стандартом — не менять)
// ─────────────────────────────────────────────────────────────────────────────

const OP_JETTON_TRANSFER:               Int = 0x0f8a7ea5;
const OP_JETTON_TRANSFER_INTERNAL:      Int = 0x178d4519;
const OP_JETTON_TRANSFER_NOTIFICATION:  Int = 0x7362d09c;
const OP_JETTON_BURN:                   Int = 0x595f07bc;
const OP_JETTON_BURN_NOTIFICATION:      Int = 0x7bdd97de;
const OP_EXCESSES:                      Int = 0xd53276db;

// Минимальные резервы кошелька (на storage rent + базовый газ обработки)
const WALLET_MIN_STORAGE:               Int = 10_000_000;    // 0.01 TON
const WALLET_GAS_CONSUMPTION:           Int = 15_000_000;    // 0.015 TON


// ─────────────────────────────────────────────────────────────────────────────
//  СТАНДАРТНЫЕ TEP-74 СООБЩЕНИЯ
// ─────────────────────────────────────────────────────────────────────────────

message(0x0f8a7ea5) JettonTransfer {
    queryId:             Int as uint64;
    amount:              Int as coins;
    destination:         Address;
    responseDestination: Address;
    customPayload:       Cell?;
    forwardAmount:       Int as coins;
    forwardPayload:      Slice as remaining;
}

message(0x178d4519) JettonTransferInternal {
    queryId:             Int as uint64;
    amount:              Int as coins;
    from:                Address;            // origin owner (либо master при минте)
    responseDestination: Address;
    forwardAmount:       Int as coins;
    forwardPayload:      Slice as remaining;
}

message(0x7362d09c) JettonTransferNotification {
    queryId:        Int as uint64;
    amount:         Int as coins;
    from:           Address;
    forwardPayload: Slice as remaining;
}

message(0x595f07bc) JettonBurn {
    queryId:             Int as uint64;
    amount:              Int as coins;
    responseDestination: Address;
    customPayload:       Cell?;
}

message(0x7bdd97de) JettonBurnNotification {
    queryId:             Int as uint64;
    amount:              Int as coins;
    owner:               Address;
    responseDestination: Address;
}

message(0xd53276db) Excesses {
    queryId: Int as uint64;
}


// ─────────────────────────────────────────────────────────────────────────────
//  GETTER STRUCT (TEP-74)
// ─────────────────────────────────────────────────────────────────────────────

struct JettonWalletData {
    balance:    Int as coins;
    owner:      Address;
    jetton:     Address;
    walletCode: Cell;
}


// ─────────────────────────────────────────────────────────────────────────────
//  CONTRACT
// ─────────────────────────────────────────────────────────────────────────────

contract TonstableJettonWallet with Deployable {
    balance: Int as coins;
    owner:   Address;
    master:  Address;

    init(owner: Address, master: Address) {
        self.balance = 0;
        self.owner   = owner;
        self.master  = master;
    }


    // ═════════════════════════════════════════════════════════════════════════
    //  ВХОДЯЩИЙ ВНУТРЕННИЙ TRANSFER (mint от master ИЛИ перевод от sibling)
    // ═════════════════════════════════════════════════════════════════════════
    //
    //  Авторизация: отправитель должен быть либо master (это mint), либо
    //  легитимный wallet (кошелёк юзера, чей адрес совпадает с детерминированно
    //  посчитанным `initOf TonstableJettonWallet(msg.from, self.master)`).
    //
    //  Это и есть «магия» TEP-74: невозможно подделать transfer от чужого
    //  имени, потому что злоумышленник не сможет задеплоить контракт по
    //  чужому детерминированному адресу.
    // ═════════════════════════════════════════════════════════════════════════

    receive(msg: JettonTransferInternal) {
        let ctx: Context = context();

        // Авторизация
        let fromMaster: Bool = ctx.sender == self.master;
        let siblingInit: StateInit = initOf TonstableJettonWallet(msg.from, self.master);
        let expectedSibling: Address = contractAddress(siblingInit);
        let fromSibling: Bool = ctx.sender == expectedSibling;
        require(fromMaster || fromSibling, "wallet: unauthorized internal transfer");

        // Зачисляем баланс
        self.balance = self.balance + msg.amount;

        // Уведомляем owner'а, если запрошен forwardAmount > 0
        if (msg.forwardAmount > 0) {
            send(SendParameters{
                to:     self.owner,
                value:  msg.forwardAmount,
                bounce: false,
                mode:   SendPayGasSeparately,
                body:   JettonTransferNotification{
                    queryId:        msg.queryId,
                    amount:         msg.amount,
                    from:           msg.from,
                    forwardPayload: msg.forwardPayload,
                }.toCell(),
            });
        }

        // Возвращаем сдачу газа на responseDestination
        let toReturn: Int = ctx.value - msg.forwardAmount - WALLET_GAS_CONSUMPTION;
        if (toReturn > WALLET_MIN_STORAGE && msg.responseDestination != newAddress(0, 0)) {
            send(SendParameters{
                to:     msg.responseDestination,
                value:  toReturn - WALLET_MIN_STORAGE,
                bounce: false,
                mode:   SendIgnoreErrors,
                body:   Excesses{ queryId: msg.queryId }.toCell(),
            });
        }
    }


    // ═════════════════════════════════════════════════════════════════════════
    //  ЗАГЛУШКИ (итерация 4: redeem flow)
    // ═════════════════════════════════════════════════════════════════════════

    receive(msg: JettonTransfer) {
        // TODO итерация 4:
        //   - require sender() == self.owner
        //   - require self.balance >= msg.amount
        //   - self.balance -= msg.amount
        //   - вычислить адрес destination's wallet
        //   - отправить JettonTransferInternal туда с init (auto-deploy)
        require(false, "wallet: transfer not implemented in iteration 3");
    }

    receive(msg: JettonBurn) {
        // TODO итерация 4:
        //   - require sender() == self.owner
        //   - require self.balance >= msg.amount
        //   - self.balance -= msg.amount
        //   - отправить JettonBurnNotification → master (запускает redeem flow)
        require(false, "wallet: burn not implemented in iteration 3");
    }


    // ═════════════════════════════════════════════════════════════════════════
    //  GETTERS
    // ═════════════════════════════════════════════════════════════════════════

    // TEP-74 standard getter name — must be exactly "get_wallet_data"
    get fun get_wallet_data(): JettonWalletData {
        return JettonWalletData{
            balance:    self.balance,
            owner:      self.owner,
            jetton:     self.master,
            walletCode: initOf TonstableJettonWallet(self.owner, self.master).code,
        };
    }

    get fun balance(): Int { return self.balance; }
    get fun owner():   Address { return self.owner; }
    get fun master():  Address { return self.master; }
}
