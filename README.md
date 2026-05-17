# TONSTABLE — TON-Native Stablecoin Protocol

TONSTABLE (TONSTBL) is a cross-chain collateralized stablecoin system that allows users to deposit TON and receive a USD-pegged token on the TON blockchain, backed by LUSD collateral managed on Arbitrum.

## Table of Contents

- [Architecture](#architecture)
- [Contract Diagram](#contract-diagram)
- [Getting Started](#getting-started)
- [Testing](#testing)
- [Security Considerations](#security-considerations)
- [Roadmap](#roadmap)
- [License](#license)

---

## Architecture

The system consists of two layers:

**TON Layer (this repository)**
- `TonstableMinter` — Jetton Master contract (TEP-74 compliant). Accepts TON deposits, communicates with the bridge adapter, mints and burns TONSTBL tokens.
- `TonstableJettonWallet` — Standard Jetton wallet (TEP-74 / TEP-89) deployed per-user.
- `MockBridgeAdapter` — Test stub that simulates the Arbitrum bridge for local development.

**Arbitrum Layer (separate repository)**
- Vault contract that holds ETH/LUSD collateral.
- Bridge listener that processes `BridgeMintRequest` and `BridgeRedeemRequest` messages from TON.
- Oracle keeper that pushes signed TON/USD prices on-chain.

### Key Data Flows

**Deposit (TON → TONSTBL)**
1. User sends `DepositTon` + TON to `TonstableMinter`.
2. Minter deducts fee, stores a `PendingMint`, sends `BridgeMintRequest` to `BridgeAdapter`.
3. Arbitrum bridge converts TON value → LUSD, calls `MintConfirmation` back on TON.
4. Minter mints TONSTBL to user's jetton wallet.

**Redeem (TONSTBL → TON)**
1. User burns TONSTBL via their `TonstableJettonWallet` (`JettonBurn`).
2. `JettonBurnNotification` arrives at `TonstableMinter`; supply decremented immediately.
3. Minter sends `BridgeRedeemRequest` to bridge with the burned amount.
4. Arbitrum bridge sells LUSD → ETH → TON; sends `RedeemPayout` back.
5. Minter deducts redeem fee and forwards net TON to user.

### Safety Mechanisms

| Mechanism | Description |
|-----------|-------------|
| Oracle staleness guard | Price updates rejected if older than `oracleMaxStaleness` (default 5 min) |
| Price deviation cap | Single price update cannot deviate >50% from prior value |
| Circuit breaker | Guardian or owner can pause all deposits and burns instantly |
| Pending timeout | Owner can clean up stuck nonces after `pendingTimeout` (default 48 h) |
| Minimum operational reserve | Fee withdrawals leave ≥ 2 TON in the contract for gas |
| Two-step ownership transfer | New owner must explicitly accept to prevent key-loss accidents |
| Slippage protection | Mint ceiling: `actualLusd` cannot exceed 110% of the quoted value |

---

## Contract Diagram

```
  User
   │  DepositTon (TON)
   ▼
TonstableMinter ──BridgeMintRequest──► BridgeAdapter (Arbitrum bridge)
   │                                        │
   │◄──────────MintConfirmation─────────────┘
   │
   ▼  JettonTransferInternal
TonstableJettonWallet (per user)
   │
   │  JettonBurn → JettonBurnNotification
   ▼
TonstableMinter ──BridgeRedeemRequest──► BridgeAdapter
   │                                        │
   │◄──────────RedeemPayout (TON)───────────┘
   │
   ▼
  User (TON)
```

---

## Getting Started

### Prerequisites

- Node.js ≥ 18
- npm ≥ 9

### Install

```bash
git clone https://github.com/your-org/tonstable
cd tonstable
npm install
```

### Configure Environment

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

Required variables:
| Variable | Description |
|----------|-------------|
| `TONCENTER_API_KEY` | Toncenter API key (testnet or mainnet) |
| `MNEMONIC` | Deployer wallet mnemonic (24 words) |

### Build

```bash
npx blueprint build
```

### Deploy

```bash
# Testnet
npx blueprint run deployTonstableMinter --testnet

# Mainnet (requires review)
npx blueprint run deployTonstableMinter --mainnet
```

---

## Testing

All tests run against the `@ton/sandbox` local blockchain — no network access required.

```bash
# Run all tests
npx blueprint test

# Run a specific suite
npx blueprint test -- --testPathPattern Iteration5
```

### Test Suites

| File | Coverage |
|------|---------|
| `TonstableMinter.spec.ts` | Deploy, oracle, deposits, mint/fail, pause, fee params, ownership |
| `Iteration4.spec.ts` | Jetton transfer, burn, redeem payout/failure, cancel pending |
| `Iteration5.spec.ts` | Admin functions (WithdrawFees, SetPendingTimeout, SetMinDeposit), ownership events |

Current status: **65 tests, 65 passing**.

---

## Security Considerations

1. **Oracle manipulation** — The on-chain price cache has a staleness window and a 50% per-update deviation cap. Multi-oracle aggregation is planned for mainnet.

2. **Bridge trust** — The current design trusts a single `bridgeAdapter` address. A future upgrade will integrate with a decentralized bridge (LayerZero or Hyperlane) with message verification.

3. **Key custody** — The `owner` role controls all admin functions. We recommend migrating ownership to a multi-signature wallet (e.g., Safe on Arbitrum side, TON multisig on TON side) before mainnet launch. Two-step ownership transfer is already enforced in the contract.

4. **Reentrancy** — TON's actor model prevents classical reentrancy. All state is committed before outbound messages are sent.

5. **Integer arithmetic** — All amounts use 257-bit signed integers (Tact default). No external math libraries are used; all fee/price arithmetic is done with integer division with rounding behavior documented in code.

6. **Minimum reserve** — `WithdrawFees` enforces a 2 TON minimum operational reserve so the contract can always pay for storage and respond to incoming messages.

7. **Audit status** — The contracts have not yet been audited by an external security firm. Audits are planned before mainnet deployment.

---

## Roadmap

| Phase | Milestone | Status |
|-------|-----------|--------|
| 1 | Core Jetton Master + deposit/mint flow | ✅ Done |
| 2 | Oracle integration + fee math + circuit breaker | ✅ Done |
| 3 | TEP-74 compliant Jetton wallet + burn/redeem flow | ✅ Done |
| 4 | Transfer, redeem fee, CancelPending, ownership transfer | ✅ Done |
| 5 | Admin functions, ownership events, portfolio prep | ✅ Done |
| 6 | External security audit | Planned |
| 7 | Arbitrum Vault + bridge integration | Planned |
| 8 | Mainnet deployment | Planned |

---

## License

MIT — see [LICENSE](LICENSE).
