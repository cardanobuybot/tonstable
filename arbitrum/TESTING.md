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

Current: 5/5 passing.

## Coverage

| Test | What it proves |
|------|----------------|
| `testFork_ViewFunctions` | Read-only entrypoints work against live state |
| `testFork_MintFlow_Phase1` | Happy-path mint via simulated LZ delivery |
| `testFork_WrongSrcEid_Reverts` | Vault's own `InvalidSourceChain()` guard fires (defense in depth — peer is registered for `WRONG_EID` to bypass LZ base `NoPeer` and reach vault's check) |
| `testFork_WrongSender_Reverts` | LZ OApp rejects messages from senders not in the peer set (`IOAppCore.OnlyPeer` selector, precise match) |
| `testFork_InsufficientUSDC_Reverts` | Vault with zero USDC reverts mint request (swap fails) |

## Known limitations

`MockSwapRouter` is hardcoded 1:1 USDC→LUSD with no setter for
the rate. As a consequence:

- `mintUsdc = 100e6` (100 USDC raw, 6 decimals) yields
  `tonstblMinted = 0` because the LUSD→TONSTBL conversion
  divides by `1e12`. Not a contract bug — a mock-environment
  artifact. Production uses a real Uniswap v3 pool.
- A dedicated `testFork_SlippageExceeded_Reverts` is not yet
  written: requires extending `MockSwapRouter` with a
  configurable output ratio (e.g. `setOutputBps(uint16)`) so
  `minOut` can be exceeded deliberately. Tracked as TODO.

## TODOs

- [ ] Extend `MockSwapRouter` with configurable output ratio,
  add `testFork_SlippageExceeded_Reverts`
- [ ] Phase 2 fork tests for burn/redeem flow (happy path +
  negatives)
- [ ] Replay protection test (`NonceAlreadyProcessed`)
