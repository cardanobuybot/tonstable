// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test, console} from "forge-std/Test.sol";
import {TonstableVault} from "../src/TonstableVault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Origin} from "@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol";

// ─────────────────────────────────────────────────────────────────────────────
//  MOCK CONTRACTS
// ─────────────────────────────────────────────────────────────────────────────

contract MockERC20 is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_)
        ERC20(name_, symbol_)
    {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Mock Uniswap V3 router with configurable price for deterministic tests
contract MockSwapRouter {
    using stdStorage for StdStorage;

    /// @notice price: how much tokenOut you get per 1e18 of tokenIn (scaled to tokenOut decimals)
    /// e.g. 1 USDC (1e6) → 0.997 LUSD (0.997e18): price = 0.997e18 * 1e18 / 1e6 = 0.997e30
    mapping(address => mapping(address => uint256)) public priceQ;

    /// @notice Failure mode for negative tests
    bool public shouldRevert;
    bool public returnZero;

    function setPrice(address tokenIn, address tokenOut, uint256 amountOutPerUnit) external {
        priceQ[tokenIn][tokenOut] = amountOutPerUnit;
    }

    function setShouldRevert(bool v) external {
        shouldRevert = v;
    }

    function setReturnZero(bool v) external {
        returnZero = v;
    }

    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external returns (uint256) {
        if (shouldRevert) revert("MockRouter: forced revert");

        require(block.timestamp <= params.deadline, "MockRouter: deadline");

        if (returnZero) return 0;

        // Transfer in
        IERC20(params.tokenIn).transferFrom(msg.sender, address(this), params.amountIn);

        // Calculate output
        uint256 price = priceQ[params.tokenIn][params.tokenOut];
        require(price > 0, "MockRouter: no price set");

        uint256 amountOut = (params.amountIn * price) / 1e18;
        require(amountOut >= params.amountOutMinimum, "MockRouter: slippage");

        // Mint to recipient (mock has unlimited supply)
        MockERC20(params.tokenOut).mint(params.recipient, amountOut);

        return amountOut;
    }
}

/// @notice Mock LayerZero endpoint for unit testing message receipt
contract MockEndpoint {
    function setDelegate(address) external {}

    function send(
        address,
        bytes calldata,
        bytes calldata,
        bytes calldata,
        bytes calldata
    ) external payable returns (bytes32 guid, uint64 nonce, uint256 fee) {
        return (bytes32(0), 0, 0);
    }

    function eid() external pure returns (uint32) {
        return 30110; // Arbitrum endpoint ID
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  TEST HARNESS — exposes internals for testing
// ─────────────────────────────────────────────────────────────────────────────

contract TonstableVaultHarness is TonstableVault {
    constructor(
        address _endpoint,
        address _owner,
        address _usdc,
        address _collateral,
        address _router,
        uint24 _poolFee,
        uint32 _tonEid
    ) TonstableVault(_endpoint, _owner, _usdc, _collateral, _router, _poolFee, _tonEid) {}

    /// @notice Test helper: directly inject an inbound message
    function harnessReceive(uint32 srcEid, bytes calldata message) external {
        this.exposedLzReceive(
            Origin({srcEid: srcEid, sender: bytes32(0), nonce: 0}),
            bytes32(0),
            message,
            address(0),
            bytes("")
        );
    }

    function exposedLzReceive(
        Origin calldata origin,
        bytes32 guid,
        bytes calldata message,
        address executor,
        bytes calldata extraData
    ) external {
        require(msg.sender == address(this), "harness only");
        _lzReceive(origin, guid, message, executor, extraData);
    }

    /// @notice Expose internal fee distribution for direct testing
    function harnessDistributeFee(uint256 amount) external {
        _distributeFee(amount);
    }

    /// @notice Set outstanding TONSTBL directly (test setup)
    function harnessSetOutstanding(uint256 amount) external {
        outstandingTonstbl = amount;
    }

    /// @notice Set insurance fund balance directly (test setup)
    function harnessSetInsurance(uint256 amount) external {
        insuranceFundBalance = amount;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  TESTS
// ─────────────────────────────────────────────────────────────────────────────

contract TonstableVaultTest is Test {
    TonstableVaultHarness public vault;
    MockERC20 public usdc;
    MockERC20 public lusd;
    MockSwapRouter public router;
    MockEndpoint public endpoint;

    address public owner = address(0x1111);
    address public user = address(0x2222);
    address public attacker = address(0x3333);

    uint32 public constant TON_EID = 30343;
    uint32 public constant ARB_EID = 30110;
    bytes32 public constant USER_TON = bytes32(uint256(0xCAFE));

    uint256 public constant PRICE_USDC_TO_LUSD = 0.997e30; // 0.997 LUSD per USDC
    uint256 public constant PRICE_LUSD_TO_USDC = 1.003e6;  // 1.003 USDC per LUSD (inverse, scaled)

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        lusd = new MockERC20("Liquity USD", "LUSD", 18);
        router = new MockSwapRouter();
        endpoint = new MockEndpoint();

        vault = new TonstableVaultHarness(
            address(endpoint),
            owner,
            address(usdc),
            address(lusd),
            address(router),
            500, // 0.05% pool fee
            TON_EID
        );

        // Configure swap prices
        router.setPrice(address(usdc), address(lusd), PRICE_USDC_TO_LUSD);
        router.setPrice(address(lusd), address(usdc), PRICE_LUSD_TO_USDC);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  [1] DEPLOYMENT & CONFIG
    // ═════════════════════════════════════════════════════════════════════════

    function test_Deployment_StateInitialized() public view {
        assertEq(address(vault.usdc()), address(usdc));
        assertEq(address(vault.primaryCollateral()), address(lusd));
        assertEq(vault.owner(), owner);
        assertEq(vault.tonEid(), TON_EID);
        assertEq(vault.swapPoolFee(), 500);
        assertTrue(vault.approvedCollateral(address(lusd)));
    }

    function test_Deployment_RevertOnInvalidPoolFee() public {
        vm.expectRevert(TonstableVault.InvalidPoolFee.selector);
        new TonstableVaultHarness(
            address(endpoint), owner, address(usdc), address(lusd),
            address(router), 1234, TON_EID
        );
    }

    function test_Deployment_RevertOnZeroAddress() public {
        vm.expectRevert(TonstableVault.ZeroAmount.selector);
        new TonstableVaultHarness(
            address(endpoint), owner, address(0), address(lusd),
            address(router), 500, TON_EID
        );
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  [2] MINT FLOW
    // ═════════════════════════════════════════════════════════════════════════

    function test_Mint_HappyPath() public {
        // Simulate USDC delivered by canonical bridge
        usdc.mint(address(vault), 100e6);

        // Construct mint message
        bytes memory payload = abi.encode(
            uint64(1),           // nonce
            USER_TON,            // userTon
            uint128(100e6),      // usdValue
            uint128(99e18),      // minLusdOut (99 LUSD with 18 decimals)
            uint64(block.timestamp + 3600) // deadline
        );
        bytes memory message = abi.encode(uint16(1), payload); // MSG_BRIDGE_MINT_REQUEST

        vault.harnessReceive(TON_EID, message);

        // Should have swapped 100 USDC → 99.7 LUSD
        assertEq(vault.totalCollateralLocked(), 99.7e18);
        // TONSTBL minted = collateral / 1e12 = 99.7e6
        assertEq(vault.outstandingTonstbl(), 99.7e6);
        assertTrue(vault.processedNonces(TON_EID, 1));
    }

    function test_Mint_NoncesPreventReplay() public {
        usdc.mint(address(vault), 100e6);
        bytes memory payload = abi.encode(
            uint64(1), USER_TON, uint128(100e6), uint128(99e18), uint64(block.timestamp + 3600)
        );
        bytes memory message = abi.encode(uint16(1), payload);

        vault.harnessReceive(TON_EID, message);

        // Second attempt with same nonce
        usdc.mint(address(vault), 100e6);
        vm.expectRevert(TonstableVault.NonceAlreadyProcessed.selector);
        vault.harnessReceive(TON_EID, message);
    }

    function test_Mint_RejectsInvalidSourceChain() public {
        bytes memory payload = abi.encode(
            uint64(1), USER_TON, uint128(100e6), uint128(99e18), uint64(block.timestamp + 3600)
        );
        bytes memory message = abi.encode(uint16(1), payload);

        vm.expectRevert(TonstableVault.InvalidSourceChain.selector);
        vault.harnessReceive(99999, message); // Wrong chain
    }

    function test_Mint_RejectsUnknownMessageType() public {
        bytes memory message = abi.encode(uint16(99), bytes(""));
        vm.expectRevert(TonstableVault.UnknownMessageType.selector);
        vault.harnessReceive(TON_EID, message);
    }

    function test_Mint_ExpiredDeadlineEmitsFailure() public {
        usdc.mint(address(vault), 100e6);
        bytes memory payload = abi.encode(
            uint64(1), USER_TON, uint128(100e6), uint128(99e18),
            uint64(block.timestamp - 1) // expired
        );
        bytes memory message = abi.encode(uint16(1), payload);

        vault.harnessReceive(TON_EID, message);

        // No collateral locked, no TONSTBL minted, but nonce marked processed
        assertEq(vault.totalCollateralLocked(), 0);
        assertEq(vault.outstandingTonstbl(), 0);
        assertTrue(vault.processedNonces(TON_EID, 1));
    }

    function test_Mint_NoUsdcAvailableEmitsFailure() public {
        // Don't mint USDC to vault — bridge didn't deliver
        bytes memory payload = abi.encode(
            uint64(1), USER_TON, uint128(100e6), uint128(99e18), uint64(block.timestamp + 3600)
        );
        bytes memory message = abi.encode(uint16(1), payload);

        vault.harnessReceive(TON_EID, message);

        assertEq(vault.outstandingTonstbl(), 0);
        assertTrue(vault.processedNonces(TON_EID, 1));
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  [3] REDEEM FLOW
    // ═════════════════════════════════════════════════════════════════════════

    function test_Redeem_HappyPath() public {
        // Set up state: as if there was a successful mint
        usdc.mint(address(vault), 100e6);
        bytes memory mintPayload = abi.encode(
            uint64(1), USER_TON, uint128(100e6), uint128(99e18), uint64(block.timestamp + 3600)
        );
        vault.harnessReceive(TON_EID, abi.encode(uint16(1), mintPayload));

        uint256 outstandingBefore = vault.outstandingTonstbl();
        uint256 collateralBefore = vault.totalCollateralLocked();

        // Now redeem 50 TONSTBL
        bytes memory redeemPayload = abi.encode(
            uint64(2), USER_TON, uint128(50e6), uint128(block.timestamp + 3600)
        );
        bytes memory message = abi.encode(uint16(2), redeemPayload);

        vault.harnessReceive(TON_EID, message);

        // 50e6 TONSTBL × 1e12 = 50e18 LUSD released
        assertEq(vault.totalCollateralLocked(), collateralBefore - 50e18);
        assertEq(vault.outstandingTonstbl(), outstandingBefore - 50e6);
    }

    function test_Redeem_FeeAppliedAndDistributed() public {
        // Set up large position to be in Phase 1 (outstanding < 10k, all fee → insurance)
        usdc.mint(address(vault), 1000e6);
        bytes memory mintPayload = abi.encode(
            uint64(1), USER_TON, uint128(1000e6), uint128(990e18), uint64(block.timestamp + 3600)
        );
        vault.harnessReceive(TON_EID, abi.encode(uint16(1), mintPayload));

        // Redeem 100 TONSTBL
        bytes memory redeemPayload = abi.encode(
            uint64(2), USER_TON, uint128(100e6), uint128(block.timestamp + 3600)
        );
        vault.harnessReceive(TON_EID, abi.encode(uint16(2), redeemPayload));

        // Phase 1: 100% to insurance, 0% to owner
        assertGt(vault.insuranceFundBalance(), 0);
        assertEq(vault.ownerRevenue(), 0);
    }

    function test_Redeem_RejectsExpiredDeadline() public {
        bytes memory payload = abi.encode(
            uint64(1), USER_TON, uint128(50e6), uint128(block.timestamp - 1)
        );
        bytes memory message = abi.encode(uint16(2), payload);

        vault.harnessReceive(TON_EID, message);

        assertEq(vault.outstandingTonstbl(), 0);
        assertTrue(vault.processedNonces(TON_EID, 1));
    }

    function test_Redeem_InsufficientCollateralFails() public {
        // Try to redeem with no collateral locked
        bytes memory payload = abi.encode(
            uint64(1), USER_TON, uint128(100e6), uint128(block.timestamp + 3600)
        );
        bytes memory message = abi.encode(uint16(2), payload);

        vault.harnessReceive(TON_EID, message);

        assertEq(vault.outstandingTonstbl(), 0);
        assertEq(vault.totalCollateralLocked(), 0);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  [4] FEE DISTRIBUTION & PHASE TRANSITIONS
    // ═════════════════════════════════════════════════════════════════════════

    function test_Phase1_AllFeeToInsurance() public {
        // outstanding < 10k → Phase 1
        vault.harnessSetOutstanding(5_000e6);

        vault.harnessDistributeFee(1_000e6);

        assertEq(vault.insuranceFundBalance(), 1_000e6);
        assertEq(vault.ownerRevenue(), 0);
    }

    function test_Phase2_80_20_Split() public {
        // outstanding >= 10k AND bufferRatio < 50%
        vault.harnessSetOutstanding(20_000e6);
        // target = max(50k, 20k * 5%) = 50k; bufferRatio = insurance / 50k
        // Set insurance to 10k → ratio = 20% → Phase 2
        vault.harnessSetInsurance(10_000e6);

        vault.harnessDistributeFee(1_000e6);

        assertEq(vault.insuranceFundBalance(), 10_000e6 + 800e6);
        assertEq(vault.ownerRevenue(), 200e6);
    }

    function test_Phase3_50_50_Split() public {
        // outstanding >= 10k AND bufferRatio between 50% and 100%
        vault.harnessSetOutstanding(20_000e6);
        vault.harnessSetInsurance(30_000e6); // ratio = 60% → Phase 3

        vault.harnessDistributeFee(1_000e6);

        assertEq(vault.insuranceFundBalance(), 30_000e6 + 500e6);
        assertEq(vault.ownerRevenue(), 500e6);
    }

    function test_Phase4_30_70_Split() public {
        // bufferRatio >= 100% → Phase 4
        vault.harnessSetOutstanding(20_000e6);
        vault.harnessSetInsurance(60_000e6); // target=50k, ratio=120% → Phase 4

        vault.harnessDistributeFee(1_000e6);

        assertEq(vault.insuranceFundBalance(), 60_000e6 + 300e6);
        assertEq(vault.ownerRevenue(), 700e6);
    }

    function test_TargetBuffer_FloorAndScaling() public {
        // Small outstanding → floor applies
        vault.harnessSetOutstanding(100_000e6); // 100k outstanding, 5% = 5k → floor wins
        assertEq(vault.getTargetBuffer(), 50_000e6);

        // Large outstanding → ratio applies
        vault.harnessSetOutstanding(10_000_000e6); // 10M outstanding, 5% = 500k > floor
        assertEq(vault.getTargetBuffer(), 500_000e6);
    }

    function test_GetCurrentPhase_ReturnsCorrectSplit() public {
        vault.harnessSetOutstanding(5_000e6);
        (uint8 phase, uint16 insuranceBps, uint16 ownerBps) = vault.getCurrentPhase();
        assertEq(phase, 1);
        assertEq(insuranceBps, 10_000);
        assertEq(ownerBps, 0);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  [5] OWNER REVENUE
    // ═════════════════════════════════════════════════════════════════════════

    function test_Owner_CanWithdrawRevenue() public {
        // Manufacture some owner revenue via Phase 3 setup
        vault.harnessSetOutstanding(20_000e6);
        vault.harnessSetInsurance(30_000e6);
        vault.harnessDistributeFee(1_000e6);

        // Need to have USDC in vault to transfer
        usdc.mint(address(vault), 500e6);

        vm.prank(owner);
        vault.withdrawOwnerRevenue(owner, 500e6);

        assertEq(vault.ownerRevenue(), 0);
        assertEq(usdc.balanceOf(owner), 500e6);
    }

    function test_Owner_CannotWithdrawMoreThanRevenue() public {
        vm.prank(owner);
        vm.expectRevert(TonstableVault.InsufficientOwnerRevenue.selector);
        vault.withdrawOwnerRevenue(owner, 1e6);
    }

    function test_NonOwner_CannotWithdrawRevenue() public {
        vm.prank(attacker);
        vm.expectRevert();
        vault.withdrawOwnerRevenue(attacker, 1e6);
    }

    function test_InsuranceFund_CannotBeWithdrawn() public {
        vm.prank(owner);
        vm.expectRevert(TonstableVault.CannotWithdrawInsuranceFund.selector);
        vault.withdrawInsuranceFund(owner, 1e6);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  [6] PAUSE
    // ═════════════════════════════════════════════════════════════════════════

    function test_Pause_BlocksMessageProcessing() public {
        vm.prank(owner);
        vault.pause();

        bytes memory payload = abi.encode(
            uint64(1), USER_TON, uint128(100e6), uint128(99e18), uint64(block.timestamp + 3600)
        );
        bytes memory message = abi.encode(uint16(1), payload);

        vm.expectRevert();
        vault.harnessReceive(TON_EID, message);
    }

    function test_Unpause_RestoresProcessing() public {
        vm.prank(owner);
        vault.pause();

        vm.prank(owner);
        vault.unpause();

        usdc.mint(address(vault), 100e6);
        bytes memory payload = abi.encode(
            uint64(1), USER_TON, uint128(100e6), uint128(99e18), uint64(block.timestamp + 3600)
        );
        vault.harnessReceive(TON_EID, abi.encode(uint16(1), payload));

        assertGt(vault.outstandingTonstbl(), 0);
    }

    function test_NonOwner_CannotPause() public {
        vm.prank(attacker);
        vm.expectRevert();
        vault.pause();
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  [7] ADMIN FUNCTIONS
    // ═════════════════════════════════════════════════════════════════════════

    function test_Owner_CanSetSwapPoolFee() public {
        vm.prank(owner);
        vault.setSwapPoolFee(3000);
        assertEq(vault.swapPoolFee(), 3000);
    }

    function test_Owner_CannotSetInvalidPoolFee() public {
        vm.prank(owner);
        vm.expectRevert(TonstableVault.InvalidPoolFee.selector);
        vault.setSwapPoolFee(1234);
    }

    function test_Owner_CanApproveAdditionalCollateral() public {
        MockERC20 dai = new MockERC20("DAI", "DAI", 18);
        vm.prank(owner);
        vault.setApprovedCollateral(address(dai), true);
        assertTrue(vault.approvedCollateral(address(dai)));
    }

    function test_Owner_CanUpdateTonEid() public {
        vm.prank(owner);
        vault.setTonEid(99999);
        assertEq(vault.tonEid(), 99999);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  [8] VIEW FUNCTIONS
    // ═════════════════════════════════════════════════════════════════════════

    function test_CollateralizationRatio_NoOutstanding() public view {
        assertEq(vault.getCollateralizationRatioBps(), type(uint256).max);
    }

    function test_CollateralizationRatio_PerfectlyCollateralized() public {
        usdc.mint(address(vault), 100e6);
        bytes memory payload = abi.encode(
            uint64(1), USER_TON, uint128(100e6), uint128(99e18), uint64(block.timestamp + 3600)
        );
        vault.harnessReceive(TON_EID, abi.encode(uint16(1), payload));

        // collateral 99.7 LUSD ≈ 99.7 USDC value, outstanding = 99.7e6 TONSTBL
        // Ratio = 100% (10000 bps)
        uint256 ratio = vault.getCollateralizationRatioBps();
        assertEq(ratio, 10_000);
    }

    function test_PreviewFeeDistribution() public {
        vault.harnessSetOutstanding(5_000e6); // Phase 1

        (uint256 toInsurance, uint256 toOwner, uint8 phase) =
            vault.previewFeeDistribution(1_000e6);

        assertEq(toInsurance, 1_000e6);
        assertEq(toOwner, 0);
        assertEq(phase, 1);
    }

    function test_BufferRatio_ZeroOutstanding() public view {
        // outstanding = 0 → target = floor (50k), insurance = 0 → ratio = 0
        assertEq(vault.getBufferRatioBps(), 0);
    }

    function test_BufferRatio_AtTarget() public {
        vault.harnessSetOutstanding(20_000e6);
        vault.harnessSetInsurance(50_000e6); // exactly target (floor)
        assertEq(vault.getBufferRatioBps(), 10_000);
    }
}

// Required for MockSwapRouter
import {stdStorage, StdStorage} from "forge-std/Test.sol";
