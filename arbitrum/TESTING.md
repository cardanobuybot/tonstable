# Testing

## Unit tests

Standard Foundry unit tests — no network required.

```bash
cd arbitrum
forge test --no-match-contract TonstableVaultForkTest
```

Current: 35/35 passing.

## Fork tests (Arbitrum Sepolia)

Fork tests pin against a live Arbitrum Sepolia RPC to validate
behavior against real LayerZero endpoint state. RPC is read from
`.env` in the repo root.

```bash
cd arbitrum
forge test --match-contract TonstableVaultForkTest --fork-url $ARB_SEPOLIA_RPC
```

Current: 8/8 passing.

## Coverage

| Test | What it proves |
|------|----------------|
| `testFork_ViewFunctions` | Read-only entrypoints work against live state |
| `testFork_MintFlow_Phase1` | Happy-path mint via simulated LZ delivery |
| `testFork_WrongSrcEid_Reverts` | Vault's own `InvalidSourceChain()` guard fires (defense in depth — peer is registered for `WRONG_EID` to bypass LZ base `NoPeer` and reach vault's check) |
| `testFork_WrongSender_Reverts` | LZ OApp rejects messages from senders not in the peer set (`IOAppCore.OnlyPeer` selector, precise match) |
| `testFork_InsufficientUSDC_Reverts` | Vault with zero USDC reverts mint request (swap fails) |
| `testFork_SlippageExceeded_Reverts` | Router-level slippage check fires when `outputBps = 5000` and `minLusdOut` demands near-full output. Uses `vm.etch` + `setOutputBps` to configure the deployed `MOCK_ROUTER` address. |
| `testFork_BurnFlow_Phase2` | End-to-end mint→burn lifecycle. Uses `vm.etch` to overlay a scale-aware `MockSwapRouterScaled` onto the deployed `MOCK_ROUTER` so swap math respects token decimals (USDC 6 ↔ LUSD 18 at 1:1 economic value). Asserts exact deltas: outstanding decreases by `tonstblBurned`, locked collateral decreases by `tonstblBurned * 1e12`. |
| `testFork_NonceAlreadyProcessed_Reverts` | Replay protection — second `lzReceive` with identical nonce reverts with `NonceAlreadyProcessed.selector`. |

## Known limitations

- **Two swap-router mocks coexist:**
  - `MockSwapRouter` (deployed on Sepolia, address pinned in
    constants) — strict 1:1 raw-amount semantics. Sufficient
    for unit tests and for fork tests that don't exercise the
    mint→burn lifecycle.
  - `MockSwapRouterScaled` (test-only, etched via `vm.etch`
    inside fork tests that need realistic math) — respects
    `decimals()` of `tokenIn` and `tokenOut`, mirrors real
    Uniswap v3 behavior of "1:1 in economic value".
- The scaled variant is **stateless and constructor-less** by
  design. State variables receive their default values from the
  EVM (zero), not from declarations, because `vm.etch` copies
  runtime bytecode only — constructor logic does not execute on
  the etched address. Therefore tests using etch must explicitly
  initialize storage via `vm.store` if non-zero defaults are
  needed.

### Architectural notes discovered during fork testing

**1. `vm.etch` + storage initializers**

State variable defaults written inline (`uint16 public outputBps = 10000;`) are produced by constructor code in the
deployment bytecode, not embedded in the runtime bytecode that
`vm.etch` copies. After etch, every storage slot reads as zero
until explicitly written. `testFork_BurnFlow_Phase2` sets
`outputBps` to 10000 via `vm.store(MOCK_ROUTER, bytes32(0),
bytes32(uint256(10000)))` right after etch. This is a general
pattern for any future test that etches a contract with non-zero
defaults.

**2. Vault uses `usdc.balanceOf(vault)` as swap `amountIn`**

The mint message carries `usdValue` as a *requested* amount, but
the Vault swaps **the vault's entire USDC balance** at execution
time, not the requested amount. This is defensive against
inconsistent message values, but means that:

- Mint tests must fund the vault with the *exact* USDC amount
  the assertions expect to be swapped (no slack)
- Any USDC sitting on the vault before a mint message arrives
  becomes part of that mint's collateral

This is a deliberate design choice and not a bug, but it warrants
documentation. The `usdValue` field of the message is effectively
informational/upper-bound rather than the actual swap input.

## TODOs

- [x] Extend `MockSwapRouter` with configurable output ratio,
      add `testFork_SlippageExceeded_Reverts` (done in v0.3.0)
- [x] Phase 2 fork tests for burn/redeem flow (happy path)
      (done in v0.4.0)
- [x] Replay protection test (`NonceAlreadyProcessed`)
      (done in v0.4.0)
- [ ] Phase 2 negatives: deadline-expired (soft failure via
      `_sendRedeemFailure`, not revert), insufficient locked
      collateral, `PayoutExceedsSanityCeiling`
- [ ] Consider unifying `MockSwapRouter` and `MockSwapRouterScaled`
      — current dual-mock model is honest but adds cognitive load
- [ ] Consider whether `usdValue` field should be removed from
      mint message (currently unused for actual swap amount)
- [ ] Architectural review: `SwapSlippageTooHigh` in Vault may
      be dead code in production path. MockSwapRouter (and real
      Uniswap v3 router) revert first with their own slippage
      check. Vault's guard is reachable only if a future adapter
      lacks `amountOutMinimum` enforcement — verify whether to
      keep it as defense-in-depth or remove.
