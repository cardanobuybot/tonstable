# TONSTABLE: A Cross-Chain Collateralized Stablecoin on TON

**Version 0.5 — May 2026**

---

## Abstract

TONSTABLE (TONSTBL) is a USD-pegged stablecoin native to The Open Network (TON) blockchain. Unlike algorithmic stablecoins that rely on reflexive tokenomics, or bridged stablecoins that simply wrap assets from another chain, TONSTABLE maintains its peg through overcollateralized LUSD reserves held on Arbitrum. TON users deposit native TON, which is converted into LUSD on-chain via a decentralized price feed, and receive TONSTBL — a TEP-74-compliant jetton redeemable 1:1 for USD-equivalent TON at any time. This paper describes the system architecture, economic model, security properties, and phased rollout plan.

---

## 1. Problem Statement

### 1.1 The Stablecoin Gap on TON

TON has grown into one of the largest Layer-1 blockchain ecosystems, driven by deep integration with Telegram's 900 million users. Yet TON's DeFi infrastructure lacks a high-quality native stablecoin. Existing options fall into three categories, each with significant drawbacks:

**Bridged USDT/USDC** are centralized by design: a single custodian controls the underlying reserves, creating concentration risk. The bridge itself is a further attack surface.

**Algorithmic stablecoins** (e.g., Luna/UST) have demonstrated catastrophic failure modes when reflexive demand dynamics collapse. Their peg relies on continued growth, not verifiable collateral.

**Wrapped assets** introduce multi-hop bridge risk and do not create native liquidity on TON — they simply relocate assets from elsewhere.

### 1.2 What TONSTABLE Solves

TONSTABLE provides:
- **Verifiable on-chain collateral**: backing is held in LUSD, itself a decentralized overcollateralized stablecoin, on Arbitrum.
- **Native TON UX**: users interact entirely through TON wallets and standard jetton flows; no cross-chain UI complexity.
- **Programmable reserve management**: the insurance fund mechanism (see §3.2) creates a self-reinforcing stability buffer during high-volatility periods.
- **Transparent fee model**: all fees are visible on-chain; there are no hidden withdrawal charges.

---

## 2. System Architecture

### 2.1 Overview

TONSTABLE is a two-layer system:

```
Layer 1 (TON)                         Layer 2 (Arbitrum)
─────────────────────────────────────────────────────────
TonstableMinter (Jetton Master)        Vault Contract
TonstableJettonWallet (per user)  ←→  Oracle Keeper
BridgeAdapter (TON-side)              Bridge Listener
```

The TON layer handles user-facing interactions (deposit, redeem, transfer). The Arbitrum layer holds the economic backing and communicates via an authenticated bridge channel.

### 2.2 TonstableMinter

The central TON contract. It is the Jetton Master (TEP-74 / TEP-89) and implements all protocol logic:

- **Deposit processing**: accepts TON, validates the oracle price, deducts fees, creates a `PendingMint` record, and sends a `BridgeMintRequest`.
- **Mint confirmation**: receives `MintConfirmation` from the bridge with the actual LUSD amount minted, and issues TONSTBL to the user's wallet.
- **Burn/redeem coordination**: receives `JettonBurnNotification`, decrements supply, sends `BridgeRedeemRequest`, and on `RedeemPayout`, charges the redeem fee and sends net TON to the user.
- **Safety features**: oracle guard, deviation cap, circuit breaker, pending timeout, two-step ownership.

### 2.3 TonstableJettonWallet

A standard per-user jetton wallet deployed deterministically from the user's address and the minter's address. It implements:
- `JettonTransfer` — peer-to-peer TONSTBL transfers.
- `JettonBurn` — initiates the redeem flow.
- Bounce handling — if the minter rejects a burn notification (e.g., when paused), the wallet restores the user's balance from the bounced message.

### 2.4 Bridge Communication

Bridge messages use fixed opcodes in the `0x544E53xx` namespace to prevent replay and misrouting:

| Opcode | Message | Direction |
|--------|---------|-----------|
| `0x544E5301` | `DepositTon` | User → Minter |
| `0x544E5310` | `BridgeMintRequest` | Minter → Bridge |
| `0x544E5302` | `MintConfirmation` | Bridge → Minter |
| `0x544E5303` | `MintFailure` | Bridge → Minter |
| `0x544E5311` | `BridgeRedeemRequest` | Minter → Bridge |
| `0x544E5304` | `RedeemPayout` | Bridge → Minter |
| `0x544E5305` | `RedeemFailure` | Bridge → Minter |

All state-changing events emit external messages (TON's equivalent of EVM logs) so they can be indexed off-chain without relying on transaction tracing.

---

## 3. Economic Model

### 3.1 Fee Structure

Two fee levers govern protocol revenue:

**Deposit fee**: charged on the incoming TON value.
- Fee = `max(depositTon × feeBps / 10000, feeFloor)`
- Default: 0.30% (30 bps) with a 0.5 TON floor.
- The fee covers: bridge forward gas, internal mint reserve, and protocol revenue.

**Redeem fee**: charged on the TON payout from Arbitrum.
- Same `feeBps / feeFloor` formula applied to the gross TON returned.
- The fee is deducted from the gross payout; the user receives the net amount.

Collected fees accumulate in the minter contract. The owner can withdraw them via `WithdrawFees`, subject to a 2 TON minimum operational reserve.

### 3.2 Insurance Fund Mechanism

LUSD, the collateral asset, is overcollateralized (minimum 110% collateral ratio at Liquity protocol). When TON price falls sharply, the minted LUSD value remains stable, which means the system is naturally over-backed in dollar terms even as TON/USD drops.

The insurance fund operates in three phases:

**Phase 1 — Growth (normal conditions)**
Protocol fees accumulate. The fund grows proportionally to volume. Target: 5% of outstanding TONSTBL supply.

**Phase 2 — Buffer (high volatility)**
When the oracle detects sustained TON price decline (>30% in 24h), the circuit breaker is manually activatable by the guardian. New deposits are paused; existing TONSTBL holders can redeem without fee. The fund absorbs any TON shortfall on redemptions.

**Phase 3 — Recovery (post-stress)**
After peg stabilizes, deposits reopen with temporarily elevated fees (up to 100 bps) to rebuild the insurance fund. Phase 3 automatically reverts to Phase 1 when the fund exceeds 5% of supply.

Phase transitions are currently manual (guardian-controlled). Automated phase transitions based on on-chain price feeds are planned for v2.

### 3.3 Price Oracle

The TON/USD price feed is maintained by a trusted `oracleKeeper` address that submits signed price updates on-chain. The contract applies two independent guards:

1. **Staleness check**: the price must be updated at least once per `oracleMaxStaleness` (default 5 minutes). If the keeper goes offline, all deposits are suspended until the price is refreshed.

2. **Deviation cap**: a single price update cannot deviate more than 50% from the previous value. This prevents a compromised keeper from instantly setting an adversarial price.

Multi-oracle aggregation (e.g., median of three independent keepers) is planned for mainnet to eliminate single-keeper trust.

---

## 4. Security Considerations

### 4.1 Threat Model

We consider the following adversarial scenarios:

**Oracle manipulation**: A malicious or compromised oracle keeper submits false prices to extract value at mint or redeem time. Mitigated by: the deviation cap (50% per update), the staleness window, and planned multi-oracle aggregation.

**Bridge message spoofing**: An attacker sends a `MintConfirmation` from an address other than the registered bridge adapter. Mitigated by: strict sender authentication (`require(sender() == self.bridgeAdapter)`).

**Slippage attack**: The Arbitrum-side vault returns more LUSD than quoted (e.g., due to a bug or manipulation). Mitigated by: the 110% `MINT_QUOTE_CEILING_PCT` check on `actualLusd`.

**Pending nonce abuse**: Deposits or burns that never get confirmed accumulate stuck nonces and lock funds. Mitigated by: the `CancelPending` mechanism with a `pendingTimeout` (default 48 hours).

**Admin key compromise**: If the `owner` key is compromised, an attacker can withdraw fees, change parameters, or propose a new owner. Mitigated by: multi-sig migration via the two-step `ProposeOwner` / `AcceptOwnership` flow, and planned Safe integration.

**Reentrancy**: TON's actor model processes messages sequentially; a receive handler cannot be re-entered while executing. The architecture is inherently safe from classical reentrancy.

### 4.2 Audit Plan

Prior to mainnet deployment:
1. Internal code review (complete for iterations 1–5).
2. External audit by a TON-specialized security firm (Trail of Bits, CertiK, or equivalent).
3. Testnet deployment with a bug bounty program (Immunefi) for 60 days.
4. Formal mainnet launch with capped TVL ($500K) that scales with time and audit confidence.

### 4.3 Upgrade Path

The contracts are not upgradeable by default (no proxy pattern). Upgrades require:
1. Deploying a new Minter contract.
2. Transferring ownership of the new contract to the multisig.
3. Migrating the bridge adapter to point to the new Minter.
4. Optional: providing a migration path for existing TONSTBL holders.

This design trades upgrade flexibility for reduced upgrade attack surface.

---

## 5. Implementation Status

All TON-side contracts are implemented in Tact 1.6 and tested against `@ton/sandbox`.

| Module | Lines of Tact | Tests | Status |
|--------|--------------|-------|--------|
| `TonstableMinter` | ~700 | 65 | Complete |
| `TonstableJettonWallet` | ~200 | included above | Complete |
| `MockBridgeAdapter` | ~50 | — | Dev only |
| Arbitrum Vault | — | — | In design |
| Bridge Listener | — | — | In design |
| Oracle Keeper | — | — | Prototype |

---

## 6. Roadmap

| Quarter | Milestone |
|---------|-----------|
| Q2 2026 | TON contracts complete (this release) |
| Q3 2026 | Arbitrum Vault + bridge listener implementation |
| Q3 2026 | External security audit |
| Q3 2026 | Testnet deployment + bug bounty launch |
| Q4 2026 | Mainnet launch with $500K TVL cap |
| Q1 2027 | Multi-oracle aggregation |
| Q1 2027 | Automated phase transitions for insurance fund |
| Q2 2027 | Governance token and DAO migration |

---

## 7. Token Economics

**Token**: TONSTBL
**Standard**: TEP-74 (TON Jetton)
**Decimals**: 6 (1 TONSTBL = 1,000,000 units)
**Peg**: 1 TONSTBL ≈ 1 USD

TONSTBL is not pre-minted. All tokens are minted on demand when users deposit TON, and burned when they redeem. There is no team allocation or investor pre-sale for TONSTBL — it is a utility token whose supply is 100% backed by deposited collateral.

A separate governance token may be introduced in a future phase for protocol parameter voting (fee rates, oracle selection, phase transition thresholds). This paper does not specify governance token economics.

---

## 8. Conclusion

TONSTABLE provides the TON ecosystem with a decentralized, overcollateralized, and auditable stablecoin. By anchoring TON-side issuance to LUSD reserves on Arbitrum and communicating through an authenticated bridge, the system avoids both the centralization of custodial stablecoins and the reflexive risk of algorithmic approaches. The phased insurance fund mechanism creates a self-reinforcing stability buffer appropriate for TON's volatile market conditions.

The TON-side smart contracts are complete, fully tested, and ready for external audit. We invite the community to review the open-source code and contribute to the security review process.

---

## References

1. Liquity Protocol whitepaper — https://liquity.org/liquity_wp.pdf
2. TON blockchain documentation — https://docs.ton.org
3. Tact language reference — https://docs.tact-lang.org
4. TEP-74 Fungible Token Standard — https://github.com/ton-blockchain/TEPs/blob/master/text/0074-jettons-standard.md
5. TEP-89 Discoverable Jettons Wallets — https://github.com/ton-blockchain/TEPs/blob/master/text/0089-jetton-wallet-discovery.md

---

*TONSTABLE is experimental software. This document is for informational purposes only and does not constitute financial advice or an offer of securities. Use at your own risk.*
