// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test, console} from "forge-std/Test.sol";
import {TonstableVault} from "../src/TonstableVault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Origin} from "@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol";
import {IOAppCore} from "@layerzerolabs/oapp-evm/contracts/oapp/interfaces/IOAppCore.sol";
import {MockSwapRouter} from "../src/mocks/MockSwapRouter.sol";
import {MockSwapRouterScaled} from "../src/mocks/MockSwapRouterScaled.sol";

// ─────────────────────────────────────────────────────────────────────────────
//  FORK TESTS — Arbitrum Sepolia deployed contracts
//  Run with: forge test --match-contract TonstableVaultForkTest \
//              --fork-url $ARB_SEPOLIA_RPC -vvv
// ─────────────────────────────────────────────────────────────────────────────

contract TonstableVaultForkTest is Test {
    // ── Deployed addresses (Arbitrum Sepolia) ────────────────────────────────
    address constant VAULT_ADDR    = 0xAc997b1723b497Aa7694D4a402Dd34943df81B20;
    address constant MOCK_USDC     = 0x790666FCC2b2B7984EE21C933930c047A2deEf32;
    address constant MOCK_LUSD     = 0x6E413f5eef1889b765F60f196C98896F89cC1422;
    address constant MOCK_ROUTER   = 0xFB5b9C2d70d207dA77e1e878EeF87F79391eEd4d;
    address constant LZ_ENDPOINT   = 0x6EDCE65403992e310A62460808c4b910D972f10f;
    uint32  constant TON_EID       = 40343;

    TonstableVault vault;
    IERC20 usdc;
    IERC20 lusd;

    function setUp() public {
        vault = TonstableVault(VAULT_ADDR);
        usdc  = IERC20(MOCK_USDC);
        lusd  = IERC20(MOCK_LUSD);
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  TEST 1: View functions — read-only, no state changes
    // ─────────────────────────────────────────────────────────────────────────

    function testFork_ViewFunctions() public view {
        // Token addresses match constructor args
        assertEq(address(vault.usdc()), MOCK_USDC, "usdc address mismatch");
        assertEq(address(vault.primaryCollateral()), MOCK_LUSD, "collateral address mismatch");
        assertEq(address(vault.swapRouter()), MOCK_ROUTER, "router address mismatch");

        // TON endpoint ID is set correctly
        uint32 eid = vault.tonEid();
        assertEq(eid, TON_EID, "tonEid mismatch");
        console.log("tonEid:", eid);

        // LUSD is approved collateral
        bool lusdApproved = vault.approvedCollateral(MOCK_LUSD);
        assertTrue(lusdApproved, "LUSD not approved as collateral");
        console.log("LUSD approved:", lusdApproved);

        // Pool fee is a valid Uniswap tier
        uint24 fee = vault.swapPoolFee();
        assertTrue(fee == 100 || fee == 500 || fee == 3000 || fee == 10000, "invalid pool fee");
        console.log("swapPoolFee:", fee);

        // Accounting starts at zero on fresh deploy
        uint256 locked     = vault.totalCollateralLocked();
        uint256 outstanding = vault.outstandingTonstbl();
        uint256 insurance  = vault.insuranceFundBalance();
        uint256 revenue    = vault.ownerRevenue();
        console.log("totalCollateralLocked:", locked);
        console.log("outstandingTonstbl:", outstanding);
        console.log("insuranceFundBalance:", insurance);
        console.log("ownerRevenue:", revenue);

        // Phase view functions
        (uint8 phase, uint16 insBps, uint16 ownerBps) = vault.getCurrentPhase();
        console.log("phase:", phase);
        console.log("insuranceBps:", insBps);
        console.log("ownerBps:", ownerBps);
        assertEq(insBps + ownerBps, 10_000, "bps must sum to 10000");

        uint256 targetBuf = vault.getTargetBuffer();
        console.log("targetBuffer:", targetBuf);
        assertGe(targetBuf, vault.MIN_TARGET_BUFFER(), "buffer below minimum");

        // getBufferRatioBps() = insuranceFundBalance / targetBuffer — 0 on fresh deploy
        uint256 bufRatio = vault.getBufferRatioBps();
        console.log("bufferRatioBps (current fill):", bufRatio);

        uint256 collRatio = vault.getCollateralizationRatioBps();
        console.log("collateralizationRatioBps:", collRatio);

        // Constants
        assertEq(vault.PHASE_2_THRESHOLD(), 10_000e6);
        assertEq(vault.MIN_TARGET_BUFFER(), 50_000e6);
        assertEq(vault.BUFFER_RATIO_BPS(), 500);
        assertEq(vault.BPS_DENOMINATOR(), 10_000);
        assertEq(vault.TONSTBL_SCALE(), 1e6);
        assertEq(vault.PAYOUT_SANITY_CEILING_PCT(), 110);
        assertEq(vault.MSG_BRIDGE_MINT_REQUEST(), 1);
        assertEq(vault.MSG_BRIDGE_REDEEM_REQUEST(), 2);
        assertEq(vault.MSG_INSURANCE_TOPUP(), 3);

        console.log("testFork_ViewFunctions: ALL PASSED");
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  TEST 2: Full mint flow via lzReceive prank
    //  Pranks LZ endpoint → calls lzReceive on vault
    //  Pre-funds vault with USDC so mint handler has funds
    // ─────────────────────────────────────────────────────────────────────────

    function testFork_MintFlow_Phase1() public {
        // MockRouter mints LUSD 1:1 in raw units (not decimal-adjusted).
        // Vault converts: tonstblMinted = collateralReceived / 1e12.
        // Need collateralReceived >= 1e12, so mintUsdc >= 1e12 (= 1,000,000 USDC).
        uint256 mintUsdc = 2_000_000e6; // 2,000,000 USDC → 2e12 LUSD raw → 2 TONSTBL

        // Fund vault with USDC by pranking MockERC20.mint
        // MockERC20 exposes a public mint() — call it as any EOA
        (bool ok,) = MOCK_USDC.call(abi.encodeWithSignature("mint(address,uint256)", VAULT_ADDR, mintUsdc));
        require(ok, "usdc mint failed");

        uint256 vaultUsdcBefore = usdc.balanceOf(VAULT_ADDR);
        console.log("vault USDC before:", vaultUsdcBefore);
        assertEq(vaultUsdcBefore, mintUsdc, "vault not funded");

        // Build MintRequest payload
        uint64  nonce      = 1;
        bytes32 userTon    = bytes32(uint256(0xDEADBEEF));
        uint128 usdValue   = uint128(mintUsdc);
        uint128 minLusdOut = 0; // no slippage protection in test
        uint64  deadline   = uint64(block.timestamp + 3600);

        bytes memory payload = abi.encode(nonce, userTon, usdValue, minLusdOut, deadline);
        bytes memory message  = abi.encode(uint16(1) /* MSG_BRIDGE_MINT_REQUEST */, payload);

        Origin memory origin = Origin({
            srcEid: TON_EID,
            sender: bytes32(uint256(uint160(address(0x1)))), // arbitrary TON peer
            nonce:  nonce
        });

        // OApp requires peer to be registered for srcEid before lzReceive
        // sender in Origin must match the registered peer bytes32
        address VAULT_OWNER = 0x43fd49Ed1B329936589bf711194809009491215e;
        vm.prank(VAULT_OWNER);
        vault.setPeer(TON_EID, origin.sender);

        // Mock outbound LZ send: endpoint.send() cannot route to TON in fork env.
        // The actual send (SendLib error 0x6592671c) would only fail because there
        // is no active DVN/executor route to TON on the testnet fork snapshot.
        // Vault mint logic has already completed before the send is attempted.
        // MessagingReceipt abi layout: (bytes32 guid, uint64 nonce, uint256 nativeFee, uint256 lzTokenFee)
        bytes memory mockReceipt = abi.encode(bytes32(0), uint64(0), uint256(0), uint256(0));
        vm.mockCall(
            LZ_ENDPOINT,
            abi.encodeWithSelector(bytes4(keccak256("send((uint32,bytes32,bytes,bytes,bool),address)"))),
            mockReceipt
        );

        uint256 lockedBefore     = vault.totalCollateralLocked();
        uint256 outstandingBefore = vault.outstandingTonstbl();

        // Prank as LZ endpoint to call lzReceive
        vm.prank(LZ_ENDPOINT);
        vault.lzReceive(origin, bytes32(0), message, address(0), bytes(""));

        uint256 lockedAfter     = vault.totalCollateralLocked();
        uint256 outstandingAfter = vault.outstandingTonstbl();

        console.log("collateral locked delta:", lockedAfter - lockedBefore);
        console.log("outstanding TONSTBL delta:", outstandingAfter - outstandingBefore);

        assertGt(lockedAfter, lockedBefore, "no collateral locked");
        assertGt(outstandingAfter, outstandingBefore, "no TONSTBL minted");
        assertTrue(vault.processedNonces(TON_EID, nonce), "nonce not marked");

        console.log("testFork_MintFlow_Phase1: PASSED");
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  TEST 3: Wrong srcEid should revert InvalidSourceChain
    // ─────────────────────────────────────────────────────────────────────────

    function testFork_WrongSrcEid_Reverts() public {
        uint32 WRONG_EID = 99999;

        bytes memory payload = abi.encode(uint64(42), bytes32(0), uint128(0), uint128(0), uint64(block.timestamp + 1));
        bytes memory message  = abi.encode(uint16(1), payload);

        Origin memory origin = Origin({
            srcEid: WRONG_EID,
            sender: bytes32(uint256(1)),
            nonce:  42
        });

        // Register peer for WRONG_EID to bypass LZ base NoPeer check.
        // Goal: reach vault's InvalidSourceChain() guard, which is the
        // real defense-in-depth being tested here.
        address VAULT_OWNER = 0x43fd49Ed1B329936589bf711194809009491215e;
        vm.prank(VAULT_OWNER);
        vault.setPeer(WRONG_EID, origin.sender);

        vm.prank(LZ_ENDPOINT);
        vm.expectRevert(TonstableVault.InvalidSourceChain.selector);
        vault.lzReceive(origin, bytes32(0), message, address(0), bytes(""));

        console.log("testFork_WrongSrcEid_Reverts: PASSED");
    }

    function testFork_WrongSender_Reverts() public {
        // Setup: register CORRECT peer for TON_EID
        address VAULT_OWNER = 0x43fd49Ed1B329936589bf711194809009491215e;
        bytes32 correctSender = bytes32(uint256(uint160(address(0xCAFE))));
        bytes32 wrongSender   = bytes32(uint256(uint160(address(0xBEEF))));

        vm.prank(VAULT_OWNER);
        vault.setPeer(TON_EID, correctSender);

        // Craft origin with WRONG sender (not the registered peer)
        Origin memory origin = Origin({
            srcEid: TON_EID,
            sender: wrongSender,
            nonce: 1
        });

        // Build a valid-looking mint payload (won't be reached anyway)
        bytes memory payload = abi.encode(
            uint64(1),              // nonce
            bytes32(uint256(42)),   // userTon (placeholder)
            uint256(100e6),         // usdValue
            uint256(0),             // minLusdOut
            block.timestamp + 1 hours
        );
        bytes memory message = abi.encode(uint16(1), payload);

        vm.prank(LZ_ENDPOINT);
        vm.expectRevert(
            abi.encodeWithSelector(
                IOAppCore.OnlyPeer.selector,
                TON_EID,
                wrongSender
            )
        );
        vault.lzReceive(origin, bytes32(0), message, address(0), bytes(""));
    }

    function testFork_InsufficientUSDC_Reverts() public {
        // Setup: register correct peer, no USDC funded to vault
        address VAULT_OWNER = 0x43fd49Ed1B329936589bf711194809009491215e;
        bytes32 senderPeer = bytes32(uint256(uint160(address(0xCAFE))));

        vm.prank(VAULT_OWNER);
        vault.setPeer(TON_EID, senderPeer);

        // Sanity: confirm vault has zero USDC at start
        uint256 vaultUsdc = IERC20(MOCK_USDC).balanceOf(VAULT_ADDR);
        assertEq(vaultUsdc, 0, "vault should start with 0 USDC for this test");

        Origin memory origin = Origin({
            srcEid: TON_EID,
            sender: senderPeer,
            nonce: 1
        });

        uint256 usdValue = 100e6;  // request to mint against 100 USDC
        bytes memory payload = abi.encode(
            uint64(1),
            bytes32(uint256(42)),
            usdValue,
            uint256(0),
            block.timestamp + 1 hours
        );
        bytes memory message = abi.encode(uint16(1), payload);

        // Expect revert — vault has no USDC, swap should fail
        // (MockSwapRouter will try transferFrom and fail, or vault
        // guard fires first; either way: revert)
        vm.prank(LZ_ENDPOINT);
        vm.expectRevert();
        vault.lzReceive(origin, bytes32(0), message, address(0), bytes(""));
    }

    function testFork_SlippageExceeded_Reverts() public {
        // MOCK_ROUTER deployed bytecode on Sepolia predates setOutputBps.
        // Etch the locally compiled MockSwapRouter bytecode onto the same
        // address so we can configure slippage. This is local-only — does
        // not modify on-chain state.
        MockSwapRouter freshRouter = new MockSwapRouter();
        vm.etch(MOCK_ROUTER, address(freshRouter).code);

        // Setup: register peer for TON_EID, fund vault with USDC
        address VAULT_OWNER = 0x43fd49Ed1B329936589bf711194809009491215e;
        bytes32 senderPeer = bytes32(uint256(uint160(address(0xCAFE))));

        vm.prank(VAULT_OWNER);
        vault.setPeer(TON_EID, senderPeer);

        // Fund vault with USDC so swap input side works
        (bool ok,) = MOCK_USDC.call(
            abi.encodeWithSignature("mint(address,uint256)", VAULT_ADDR, 1000e6)
        );
        require(ok, "mint usdc failed");

        // Configure router to return only 50% of input — guaranteed slippage
        (bool ok2,) = MOCK_ROUTER.call(
            abi.encodeWithSignature("setOutputBps(uint16)", uint16(5000))
        );
        require(ok2, "setOutputBps failed");

        // Build mint request with strict minLusdOut so swap fails the check
        uint64 nonce = 1;
        uint256 usdValue = 100e6;
        uint256 minLusdOut = 99e18;  // demand near-perfect rate; router gives 50%

        bytes memory payload = abi.encode(
            nonce,
            bytes32(uint256(42)),
            usdValue,
            minLusdOut,
            block.timestamp + 1 hours
        );
        bytes memory message = abi.encode(uint16(1), payload);

        Origin memory origin = Origin({
            srcEid: TON_EID,
            sender: senderPeer,
            nonce: nonce
        });

        vm.prank(LZ_ENDPOINT);
        // MockSwapRouter has built-in slippage check (mirrors real
        // Uniswap v3 router behavior). It reverts first with this
        // string; Vault's own SwapSlippageTooHigh acts as defense in
        // depth for adapters that lack the check, but in production
        // path (and here) the router-level revert fires first.
        vm.expectRevert(bytes("Mock: insufficient output"));
        vault.lzReceive(origin, bytes32(0), message, address(0), bytes(""));

        // Reset outputBps for any subsequent tests in same run
        (bool ok3,) = MOCK_ROUTER.call(
            abi.encodeWithSignature("setOutputBps(uint16)", uint16(10000))
        );
        require(ok3, "reset outputBps failed");
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  TEST 6: Full burn lifecycle — mint then redeem via real lzReceive
    // ─────────────────────────────────────────────────────────────────────────

    function testFork_BurnFlow_Phase2() public {
        // ── Etch scale-aware router onto deployed MOCK_ROUTER ───
        // Deployed mock is 1:1-raw which makes mint→burn lifecycle
        // produce zero TONSTBL (LUSD / 1e12 = 0). We overlay a
        // scale-aware version that mirrors real Uniswap behavior:
        // USDC (6 dec) <-> LUSD (18 dec) at 1:1 economic value.
        MockSwapRouterScaled scaled = new MockSwapRouterScaled();
        vm.etch(MOCK_ROUTER, address(scaled).code);
        // Slot 0 (outputBps) is 0 on the fork — the original deployed router
        // predates this variable. Initialise to 100% after etch.
        vm.store(MOCK_ROUTER, bytes32(0), bytes32(uint256(10000)));

        // ── Setup: register peer ────────────────────────────────
        address VAULT_OWNER = 0x43fd49Ed1B329936589bf711194809009491215e;
        bytes32 senderPeer = bytes32(uint256(uint160(address(0xCAFE))));

        vm.prank(VAULT_OWNER);
        vault.setPeer(TON_EID, senderPeer);

        // ── Mock outbound LZ send ───────────────────────────────
        vm.mockCall(
            LZ_ENDPOINT,
            abi.encodeWithSignature(
                "send((uint32,bytes32,bytes,bytes,bool),address)"
            ),
            abi.encode(bytes32(uint256(1)), uint64(1), uint256(0), uint256(0))
        );

        // ── Fund vault with exactly 100 USDC ────────────────────
        // Vault uses usdc.balanceOf(vault) as amountIn — fund exactly
        // usdValue so the swap produces the expected 100e18 LUSD.
        (bool ok,) = MOCK_USDC.call(
            abi.encodeWithSignature(
                "mint(address,uint256)", VAULT_ADDR, 100e6
            )
        );
        require(ok, "fund usdc failed");

        // ── Step 1: mint via simulated LZ delivery ──────────────
        bytes32 userTon = bytes32(uint256(42));
        uint256 usdValue = 100e6;       // 100 USDC — realistic scale
        uint256 minLusdOut = 99e18;     // expect ~100 LUSD, allow 1% slippage

        bytes memory mintPayload = abi.encode(
            uint64(1),
            userTon,
            usdValue,
            minLusdOut,
            block.timestamp + 1 hours
        );
        bytes memory mintMessage = abi.encode(uint16(1), mintPayload);

        Origin memory mintOrigin = Origin({
            srcEid: TON_EID,
            sender: senderPeer,
            nonce: 1
        });

        vm.prank(LZ_ENDPOINT);
        vault.lzReceive(
            mintOrigin, bytes32(0), mintMessage, address(0), bytes("")
        );

        uint256 outstandingAfterMint = vault.outstandingTonstbl();
        uint256 lockedAfterMint = vault.totalCollateralLocked();

        // With scaled router: 100 USDC → 100e18 LUSD → 100e6 TONSTBL
        assertEq(outstandingAfterMint, 100e6, "expected 100 TONSTBL minted");
        assertEq(lockedAfterMint, 100e18, "expected 100 LUSD locked");

        // ── Step 2: redeem half of minted TONSTBL ───────────────
        uint128 tonstblToBurn = uint128(outstandingAfterMint / 2);  // 50 TONSTBL

        bytes memory burnPayload = abi.encode(
            uint64(2),
            userTon,
            tonstblToBurn,
            uint64(block.timestamp + 1 hours)
        );
        bytes memory burnMessage = abi.encode(uint16(2), burnPayload);

        Origin memory burnOrigin = Origin({
            srcEid: TON_EID,
            sender: senderPeer,
            nonce: 2
        });

        vm.prank(LZ_ENDPOINT);
        vault.lzReceive(
            burnOrigin, bytes32(0), burnMessage, address(0), bytes("")
        );

        // ── Assertions ──────────────────────────────────────────
        // outstandingTonstbl decreased by exactly tonstblToBurn
        assertEq(
            outstandingAfterMint - vault.outstandingTonstbl(),
            tonstblToBurn,
            "outstanding delta != tonstblBurned"
        );

        // totalCollateralLocked decreased by tonstblBurned * 1e12
        assertEq(
            lockedAfterMint - vault.totalCollateralLocked(),
            uint256(tonstblToBurn) * 1e12,
            "collateral delta != tonstblBurned * 1e12"
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  TEST 7: Replay protection — duplicate nonce must revert
    // ─────────────────────────────────────────────────────────────────────────

    function testFork_NonceAlreadyProcessed_Reverts() public {
        // Setup
        address VAULT_OWNER = 0x43fd49Ed1B329936589bf711194809009491215e;
        bytes32 senderPeer = bytes32(uint256(uint160(address(0xCAFE))));

        vm.prank(VAULT_OWNER);
        vault.setPeer(TON_EID, senderPeer);

        vm.mockCall(
            LZ_ENDPOINT,
            abi.encodeWithSignature(
                "send((uint32,bytes32,bytes,bytes,bool),address)"
            ),
            abi.encode(bytes32(uint256(1)), uint64(1), uint256(0), uint256(0))
        );

        // Use scaled router so first mint produces non-zero state —
        // makes the test scenario realistic (real replay attempts
        // would target a mint that produced actual TONSTBL)
        MockSwapRouterScaled scaled = new MockSwapRouterScaled();
        vm.etch(MOCK_ROUTER, address(scaled).code);
        vm.store(MOCK_ROUTER, bytes32(0), bytes32(uint256(10000)));

        (bool ok,) = MOCK_USDC.call(
            abi.encodeWithSignature(
                "mint(address,uint256)", VAULT_ADDR, 1000e6
            )
        );
        require(ok, "fund usdc failed");

        uint64 nonce = 1;
        bytes memory payload = abi.encode(
            nonce,
            bytes32(uint256(42)),
            uint256(100e6),
            uint256(99e18),
            block.timestamp + 1 hours
        );
        bytes memory message = abi.encode(uint16(1), payload);

        Origin memory origin = Origin({
            srcEid: TON_EID,
            sender: senderPeer,
            nonce: nonce
        });

        // First mint — succeeds
        vm.prank(LZ_ENDPOINT);
        vault.lzReceive(origin, bytes32(0), message, address(0), bytes(""));

        // Sanity: confirm first mint actually produced TONSTBL
        assertGt(vault.outstandingTonstbl(), 0, "first mint produced nothing");

        // Second mint with SAME nonce — must revert
        vm.prank(LZ_ENDPOINT);
        vm.expectRevert(TonstableVault.NonceAlreadyProcessed.selector);
        vault.lzReceive(origin, bytes32(0), message, address(0), bytes(""));
    }
}
