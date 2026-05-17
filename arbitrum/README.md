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

##Deployment
###Testnet (Arbitrum Sepolia)
1.Get Arbitrum Sepolia ETH from a faucet
2.Deploy test USDC and LUSD MockERC20 tokens
3.Configure environment variables in .env:

''' bash
PRIVATE_KEY=0x...
ARB_LZ_ENDPOINT=0x6EDCE65403992e310A62460808c4b910D972f10f
USDC_ADDRESS=<deployed_mock_usdc>
LUSD_ADDRESS=<deployed_mock_lusd>
UNISWAP_V3_ROUTER=<test_router_or_mock>
POOL_FEE=500
TON_EID=40343
INITIAL_OWNER=<your_address>

4.Deploy:
'''bash
source .env
forge script script/Deploy.s.sol \
  --rpc-url https://sepolia-rollup.arbitrum.io/rpc \
  --broadcast \
  --verify
##Mainnet
##Do not deploy to mainnet without:
•Completed security audit
•LayerZero peer configuration with TON •Minter
•Verified DVN configuration
•Multisig owner setup
•Bootstrap capital plan
##Integration with TON Side
###After deployment, configure peer relationship:
'''Solidity
// On Arbitrum (this vault)
vault.setPeer(TON_EID, bytes32(uint256(uint160(TON_MINTER_ADDRESS))));

// On TON (Minter contract via admin message)
// Set bridgeAdapter to point at the LayerZero TON endpoint OApp

## Security Considerations
### This code is not audited. Before mainnet:
1. Professional audit covering:
•LayerZero message handling and replay protection
•Uniswap V3 swap slippage edge cases
•Insurance fund accounting integrity
•Phase transition math
•Pause/unpause flows
•Reentrancy across cross-chain message handling
2. Bug bounty program
3.Gradual mainnet rollout with hard caps:
•Max deposit per user
•Max total outstanding
•Auto-pause on volatility triggers
## License
### MIT — see ../LICENSE
