// ============================================================================
//  MockBridgeAdapter.tact  —  testnet-only stub
//
//  Replaces the real Arbitrum bridge adapter.  When TonstableMinter sends a
//  BridgeMintRequest here, this contract immediately replies with a
//  MintConfirmation so the Minter can credit the user's JettonWallet.
//
//  NEVER deploy on mainnet.
// ============================================================================

import "@stdlib/deploy";

// ─── message copies (identical opcodes as in TonstableMinter) ─────────────────

message(0x544E5302) MintConfirmation {
    nonce:      Int as uint64;
    actualLusd: Int as uint128;
    arbTxHash:  Int as uint256;
}

message(0x544E5311) BridgeRedeemRequest {
    nonce:         Int as uint64;
    userTon:       Address;
    tonstblBurned: Int as uint128;
    deadline:      Int as uint64;
}

message(0x544E5304) RedeemPayout {
    nonce:     Int as uint64;
    arbTxHash: Int as uint256;
}

// Fixed mint amount per confirmation: 1,000,000 raw units.
// At 6-decimal display (TONSTBL_SCALE = 10^6) this shows as 1.000000 TONSTBL,
// which comfortably passes the 110 % ceiling check against any realistic usdValue.
const MOCK_ACTUAL_LUSD: Int = 1_000_000;

contract MockBridgeAdapter with Deployable {
    minter: Address;

    init(minter: Address) {
        self.minter = minter;
    }

    // Absorb the bridge request and immediately confirm the mint.
    // Minter now wraps the request in a raw LZ-style body:
    //   [op uint32][query_id uint64][donationNanos coins][ref → fields]
    receive(slice: Slice) {
        let op: Int = slice.loadUint(32);

        // Only react to BRIDGE_MINT_REQUEST; ignore anything else so a
        // stray message can't crash this stub.
        if (op == 0x544E5310) {
            slice.loadUint(64);   // query_id — unused by the mock
            slice.loadCoins();    // donationNanos — unused
            let body: Slice = slice.loadRef().asSlice();

            let nonce: Int = body.loadUint(64);
            // userTon / usdValue / minLusdOut / deadline are present in
            // the ref but the mock doesn't need them to reply.

            send(SendParameters{
                to:     self.minter,
                value:  0,
                bounce: false,
                mode:   SendRemainingValue,
                body:   MintConfirmation{
                    nonce:      nonce,
                    actualLusd: MOCK_ACTUAL_LUSD,
                    arbTxHash:  0,
                }.toCell(),
            });
        }
    }

    // Absorb the redeem request and immediately confirm the payout.
    // The remaining gas from the burn chain is forwarded back to the Minter
    // as the "payout" value; on mainnet the bridge would attach real TON here.
    receive(msg: BridgeRedeemRequest) {
        send(SendParameters{
            to:     self.minter,
            value:  0,
            bounce: false,
            mode:   SendRemainingValue,
            body:   RedeemPayout{
                nonce:     msg.nonce,
                arbTxHash: 0,
            }.toCell(),
        });
    }
}
