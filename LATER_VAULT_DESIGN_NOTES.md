# Vault.sol Design Notes — Future Arbitrum Implementation

This file tracks design decisions for the Arbitrum-side Vault contract.
It is a living document; delete entries when implemented.

---

## Vault.sol Phase Transition Logic

### Context

The WHITEPAPER §3.2 specifies automatic, owner-discretion-free phase
transitions for insurance fund fee distribution. This section provides
the reference implementation for `Vault.sol`.

### Function: `_distributeFee(uint256 feeAmount)`

Called internally every time a deposit or redeem fee is collected.

```solidity
/// @dev Distributes `feeAmount` between the insurance fund and owner
///      revenue according to the current phase. Phase is determined
///      automatically from on-chain state — no owner input required.
function _distributeFee(uint256 feeAmount) internal {
    uint256 outstanding = totalOutstandingTonstbl();
    uint256 target      = _calculateTargetBuffer(outstanding);
    // bufferRatio is scaled by 1e18 to allow fractional comparison.
    uint256 bufferRatio = target > 0
        ? (insuranceFundBalance * 1e18) / target
        : type(uint256).max;

    uint16 insuranceBps;

    if (outstanding < 10_000e6) {
        insuranceBps = 10_000;  // Phase 1: 100% to insurance
    } else if (bufferRatio < 0.5e18) {
        insuranceBps = 8_000;   // Phase 2: 80% to insurance
    } else if (bufferRatio < 1.0e18) {
        insuranceBps = 5_000;   // Phase 3: 50% to insurance
    } else {
        insuranceBps = 3_000;   // Phase 4: 30% to insurance
    }

    uint256 toInsurance = (feeAmount * insuranceBps) / 10_000;
    uint256 toOwner     = feeAmount - toInsurance;

    insuranceFundBalance += toInsurance;
    ownerRevenue         += toOwner;

    emit FeeDistributed(feeAmount, toInsurance, toOwner, insuranceBps);
}
```

### Helper: `_calculateTargetBuffer(uint256 outstanding)`

```solidity
uint256 constant MIN_BUFFER_USDC = 50_000e6; // 50,000 USDC (6 decimals)
uint256 constant BUFFER_BPS      = 500;       // 5% of outstanding

function _calculateTargetBuffer(uint256 outstanding) internal pure returns (uint256) {
    uint256 pctTarget = (outstanding * BUFFER_BPS) / 10_000;
    return pctTarget > MIN_BUFFER_USDC ? pctTarget : MIN_BUFFER_USDC;
}
```

### View Functions (required by WHITEPAPER §3.2)

```solidity
function getCurrentPhase() external view returns (uint8 phase) {
    uint256 outstanding = totalOutstandingTonstbl();
    if (outstanding < 10_000e6) return 1;
    uint256 target      = _calculateTargetBuffer(outstanding);
    uint256 bufferRatio = target > 0
        ? (insuranceFundBalance * 1e18) / target
        : type(uint256).max;
    if (bufferRatio < 0.5e18)  return 2;
    if (bufferRatio < 1.0e18)  return 3;
    return 4;
}

function getFeeDistribution() external view returns (
    uint8  phase,
    uint16 insuranceBps,
    uint16 ownerBps
) {
    phase = getCurrentPhase();
    if (phase == 1) insuranceBps = 10_000;
    else if (phase == 2) insuranceBps = 8_000;
    else if (phase == 3) insuranceBps = 5_000;
    else insuranceBps = 3_000;
    ownerBps = 10_000 - insuranceBps;
}
```

### Events

```solidity
event FeeDistributed(
    uint256 indexed totalFee,
    uint256         toInsurance,
    uint256         toOwner,
    uint16          insuranceBps
);
```

---

## TODO: Insurance Fund Drawdown Logic

When a redeem payout cannot be covered by available LUSD (e.g., during
extreme TON price appreciation making buyback expensive), the vault
should draw from `insuranceFundBalance` to cover the shortfall before
reverting. Sketch:

```solidity
function _coverShortfall(uint256 shortfall) internal returns (bool covered) {
    if (insuranceFundBalance >= shortfall) {
        insuranceFundBalance -= shortfall;
        emit InsuranceFundDrawdown(shortfall, insuranceFundBalance);
        return true;
    }
    return false; // escalate: trigger circuit breaker on TON side
}
```

---

## TODO: Bridge Message Verification

Before processing any `BridgeMintRequest` or `BridgeRedeemRequest`, the
Vault must verify:
1. Message originates from the registered TON bridge contract.
2. Nonce has not been processed before (replay protection).
3. Deadline has not passed (`block.timestamp <= msg.deadline`).

Reference: LayerZero `lzReceive` pattern or Hyperlane `handle` pattern.

---

## TODO: Circuit Breaker Integration

If `_coverShortfall` returns `false`, the Vault should send a
`BridgePause` message back to `TonstableMinter` on TON to halt new
deposits while the team investigates. The TON-side contract already
supports the `Pause` message; the bridge just needs to be authorised
as a guardian.
