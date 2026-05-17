# TONSTABLE — Arbitrum Side

Solidity vault contract for the TONSTABLE cross-chain stablecoin protocol.

## Overview

The `TonstableVault` contract is the Arbitrum-side counterpart to the TON-side
Minter (in `../contracts/`). It receives mint/redeem messages from TON via
LayerZero, manages collateral (LUSD), and operates the Insurance Fund with
automatic phase-based fee distribution.

## Status

**Reference implementation — not deployed.**

This codebase represents the complete architectural design of the Arbitrum side.
Deployment requires:
- ~$50-200 in ETH for testnet deployment and integration testing
- Security audit ($500-30K depending on scope) before any mainnet use
- Initial collateral capital for the Insurance Fund bootstrap

The TON-side contracts (`../contracts/tonstable_minter.tact` and
`tonstable_jetton_wallet.tact`) are deployed on TON testnet with 65/65 tests
passing. This Arbitrum side completes the architectural picture.

## Architecture Highlights

- **Immutable** — no upgradability, no admin keys beyond Owner/Pauser
- **Multi-collateral ready** — Phase 1 uses LUSD, future phases can add others
- **Automatic phase transitions** — fee split between Insurance Fund and owner
  changes based on on-chain metrics, not owner discretion
- **Trustless insurance fund** — owner physically cannot withdraw from it
- **LayerZero v2** for cross-chain messaging with TON
- **Uniswap V3** for USDC ↔ LUSD swaps

## Phase-Based Fee Distribution

| Phase | Trigger | Insurance Fund | Owner |
|-------|---------|----------------|-------|
| 1 | outstanding < $10K | 100% | 0% |
| 2 | outstanding ≥ $10K AND buffer < 50% target | 80% | 20% |
| 3 | buffer 50%-100% of target | 50% | 50% |
| 4 | buffer ≥ target | 30% | 70% |

Target buffer = max($50K, outstanding × 5%)

## Setup

### Prerequisites

- Foundry (https://book.getfoundry.sh/getting-started/installation)
- Node.js 18+ (for any helper scripts)

### Installation

```bash
cd arbitrum
forge install
forge build
forge test

## Testing

```bash
# Run all tests
forge test

# Run with verbosity
forge test -vvv

# Run specific test
forge test --match-test test_Mint_HappyPath -vvv

# Gas snapshot
forge snapshot

