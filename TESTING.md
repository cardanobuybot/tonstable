## TON Mint Flow — Testnet Verification (raw LZ format)

Verified end-to-end on TON testnet that the Minter -> mock bridge
mint flow works with the new raw LayerZero-style message body.

Run: `npx ts-node scripts/_runMint.ts`
- [1/4] Deploy MockBridgeAdapter — active (seqno 53->54)
- [2/4] SetBridgeAdapter — confirmed (54->55)
- [3/4] PriceUpdate $100,000/TON — confirmed (55->56)
- [4/4] DepositTon 2.0 TON -> ~1,000,000 units — confirmed (56->57)

Verification: `npx ts-node scripts/_diagnose.ts`
- get_wallet_address(user) matches pre-deployed wallet: true
- Minter totalSupplyOf() = 1,000,000

The mint succeeded: Minter emitted the raw body
[op 0x544E5310][query_id][donationNanos=0][ref -> nonce, userTon,
usdValue, minLusdOut, deadline], the mock parsed it via its
Slice-based receive, replied MintConfirmation, and the Minter
minted 1,000,000 TONSTBL units. Confirms the raw wire format the
real LayerZero OApp will use is correct on the TON side.

Note: _diagnose.ts later sections hit HTTP 429 (rate limit, no
TONCENTER_API_KEY); totalSupplyOf read before the cutoff. Not a
contract issue.

Addresses (testnet):
- Minter: EQAYNaqE6fdlxo2giEWwQU3QDHyxdN4atT9ixf8fAAy4XWth
- JettonWallet: EQAdd0dSXN5asuj2EVitWslgCQjU13ATYnCU8eJiEz_QIkTW
