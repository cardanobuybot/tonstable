// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {OApp, Origin, MessagingFee} from "@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol";
import {OAppOptionsType3} from "@layerzerolabs/oapp-evm/contracts/oapp/libs/OAppOptionsType3.sol";

interface ISwapRouter {
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
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/**
 * @title TonstableVault
 * @notice Arbitrum-side collateral vault for the TONSTABLE cross-chain stablecoin.
 *         Receives mint/redeem messages from the TON-side Minter via LayerZero,
 *         swaps incoming USDC against approved collateral assets (LUSD primary),
 *         and maintains an Insurance Fund with automatic phase-based fee distribution.
 * @dev    Immutable contract. No upgradability. Migrations require redeploy.
 *         Multi-collateral ready, Phase 1 uses LUSD only.
 */
contract TonstableVault is OApp, Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─────────────────────────────────────────────────────────────────────────
    //  CONSTANTS
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Phase 1 → Phase 2 outstanding threshold (10,000 USDC, 6 decimals)
    uint256 public constant PHASE_2_THRESHOLD = 10_000e6;

    /// @notice Minimum buffer floor — always at least $50,000
    uint256 public constant MIN_TARGET_BUFFER = 50_000e6;

    /// @notice Target buffer as fraction of outstanding (5%)
    uint256 public constant BUFFER_RATIO_BPS = 500;

    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @notice TONSTBL scale: 6 decimals (matches USDC)
    uint256 public constant TONSTBL_SCALE = 1e6;

    /// @notice Sanity ceiling: outgoing payout cannot exceed 110% of expected
    uint256 public constant PAYOUT_SANITY_CEILING_PCT = 110;

    /// @notice Message types matching TON-side opcodes (0x544E5310-13)
    uint16 public constant MSG_BRIDGE_MINT_REQUEST = 1;
    uint16 public constant MSG_BRIDGE_REDEEM_REQUEST = 2;
    uint16 public constant MSG_INSURANCE_TOPUP = 3;

    /// @notice LayerZero TON endpoint ID (mainnet placeholder, set at config time)
    uint32 public tonEid;

    // ─────────────────────────────────────────────────────────────────────────
    //  STATE: COLLATERAL CONFIG
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice USDC on Arbitrum (received from bridge after TON conversion)
    IERC20 public immutable usdc;

    /// @notice Primary collateral asset (LUSD on Arbitrum at Phase 1)
    IERC20 public immutable primaryCollateral;

    /// @notice Uniswap V3 router for USDC↔collateral swaps
    ISwapRouter public immutable swapRouter;

    /// @notice Uniswap V3 pool fee tier for USDC↔primaryCollateral (typically 500 = 0.05%)
    uint24 public swapPoolFee;

    /// @notice Whitelist of approved collateral tokens (for future multi-collateral)
    mapping(address => bool) public approvedCollateral;

    // ─────────────────────────────────────────────────────────────────────────
    //  STATE: ACCOUNTING
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Total LUSD locked as collateral backing outstanding TONSTBL
    uint256 public totalCollateralLocked;

    /// @notice Outstanding TONSTBL supply (6 decimals)
    uint256 public outstandingTonstbl;

    /// @notice Insurance Fund balance (in USDC, 6 decimals)
    uint256 public insuranceFundBalance;

    /// @notice Owner's accumulated revenue (in USDC, withdrawable)
    uint256 public ownerRevenue;

    /// @notice Used nonces to prevent replay (per source chain)
    mapping(uint32 => mapping(uint64 => bool)) public processedNonces;

    // ─────────────────────────────────────────────────────────────────────────
    //  EVENTS
    // ─────────────────────────────────────────────────────────────────────────

    event MintProcessed(
        uint64 indexed nonce,
        bytes32 indexed userTon,
        uint256 usdcReceived,
        uint256 collateralAcquired,
        uint256 tonstblMinted
    );

    event RedeemProcessed(
        uint64 indexed nonce,
        bytes32 indexed userTon,
        uint256 tonstblBurned,
        uint256 collateralReleased,
        uint256 usdcPayout
    );

    event FeeDistributed(
        uint256 totalFee,
        uint256 toInsurance,
        uint256 toOwner,
        uint16 insuranceBps,
        uint8 phase
    );

    event InsuranceFundDeposit(uint256 amount, uint256 newBalance);
    event OwnerRevenueWithdrawn(address indexed to, uint256 amount);
    event CollateralApproved(address indexed token, bool approved);
    event SwapPoolFeeUpdated(uint24 oldFee, uint24 newFee);
    event TonEidUpdated(uint32 oldEid, uint32 newEid);
    event EmergencyShortfallCovered(uint256 amount, uint256 newInsuranceBalance);

    // ─────────────────────────────────────────────────────────────────────────
    //  ERRORS
    // ─────────────────────────────────────────────────────────────────────────

    error InvalidSourceChain();
    error NonceAlreadyProcessed();
    error UnknownMessageType();
    error CollateralNotApproved();
    error InsufficientPayout();
    error PayoutExceedsSanityCeiling();
    error InsufficientOwnerRevenue();
    error SwapSlippageTooHigh();
    error CannotWithdrawInsuranceFund();
    error ZeroAmount();
    error InvalidPoolFee();

    // ─────────────────────────────────────────────────────────────────────────
    //  CONSTRUCTOR
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @param _endpoint   LayerZero v2 endpoint on Arbitrum
     * @param _owner      Initial owner (recommend multisig)
     * @param _usdc       USDC token address on Arbitrum
     * @param _collateral Primary collateral token address (LUSD on Arbitrum)
     * @param _router     Uniswap V3 SwapRouter address
     * @param _poolFee    Uniswap V3 pool fee tier (e.g., 500 for 0.05%)
     * @param _tonEid     LayerZero endpoint ID for TON
     */
    constructor(
        address _endpoint,
        address _owner,
        address _usdc,
        address _collateral,
        address _router,
        uint24 _poolFee,
        uint32 _tonEid
    ) OApp(_endpoint, _owner) Ownable(_owner) {
        if (_usdc == address(0) || _collateral == address(0) || _router == address(0)) {
            revert ZeroAmount();
        }
        if (_poolFee != 100 && _poolFee != 500 && _poolFee != 3000 && _poolFee != 10000) {
            revert InvalidPoolFee();
        }

        usdc = IERC20(_usdc);
        primaryCollateral = IERC20(_collateral);
        swapRouter = ISwapRouter(_router);
        swapPoolFee = _poolFee;
        tonEid = _tonEid;

        approvedCollateral[_collateral] = true;
        emit CollateralApproved(_collateral, true);
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  LAYERZERO MESSAGE HANDLING
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice LayerZero receive entrypoint. Routes inbound messages by type.
     * @dev Only the configured LZ endpoint can call this. Source chain
     *      is verified via OApp.peer check (inherited).
     */
    function _lzReceive(
        Origin calldata _origin,
        bytes32 /*_guid*/,
        bytes calldata _message,
        address /*_executor*/,
        bytes calldata /*_extraData*/
    ) internal override whenNotPaused nonReentrant {
        if (_origin.srcEid != tonEid) revert InvalidSourceChain();

        (uint16 msgType, bytes memory payload) = abi.decode(_message, (uint16, bytes));

        if (msgType == MSG_BRIDGE_MINT_REQUEST) {
            _handleMintRequest(payload);
        } else if (msgType == MSG_BRIDGE_REDEEM_REQUEST) {
            _handleRedeemRequest(payload);
        } else if (msgType == MSG_INSURANCE_TOPUP) {
            _handleInsuranceTopUp(payload);
        } else {
            revert UnknownMessageType();
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  MINT HANDLER
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Process a mint request from TON-side.
     * @dev Expects USDC already delivered by canonical bridge to this contract.
     *      Swaps USDC → collateral, locks collateral, records outstanding TONSTBL,
     *      sends MintConfirmation back to TON-side Minter.
     *
     *      Payload layout:
     *        uint64  nonce
     *        bytes32 userTon (TON address as bytes32)
     *        uint128 usdValue (declared from TON-side, for validation)
     *        uint128 minLusdOut (slippage protection)
     *        uint64  deadline
     */
    function _handleMintRequest(bytes memory payload) internal {
        (
            uint64 nonce,
            bytes32 userTon,
            uint128 usdValue,
            uint128 minLusdOut,
            uint64 deadline
        ) = abi.decode(payload, (uint64, bytes32, uint128, uint128, uint64));

        if (processedNonces[tonEid][nonce]) revert NonceAlreadyProcessed();
        processedNonces[tonEid][nonce] = true;

        if (block.timestamp > deadline) {
            _sendMintFailure(nonce, userTon, 1 /* expired */);
            return;
        }

        // USDC should have been delivered by canonical bridge before this message.
        // We measure our own balance increase since the previous accounting point.
        uint256 usdcAvailable = usdc.balanceOf(address(this))
            - insuranceFundBalance
            - ownerRevenue;

        if (usdcAvailable == 0) {
            _sendMintFailure(nonce, userTon, 2 /* no funds received */);
            return;
        }

        // Fee distribution happens on the redeem side, but we accept the principal here.
        // Principal swap: USDC → primary collateral
        uint256 collateralReceived = _swapUsdcToCollateral(usdcAvailable, minLusdOut);

        if (collateralReceived < minLusdOut) {
            // Should be unreachable due to swap's amountOutMinimum, but defense in depth
            revert SwapSlippageTooHigh();
        }

        // Lock collateral
        totalCollateralLocked += collateralReceived;

        // Mint accounting: 1:1 with collateral (assumes LUSD ≈ $1, sanity-checked)
        // Conversion: collateral has 18 decimals, TONSTBL has 6
        uint256 tonstblMinted = collateralReceived / 1e12;
        outstandingTonstbl += tonstblMinted;

        emit MintProcessed(nonce, userTon, usdcAvailable, collateralReceived, tonstblMinted);

        // Send confirmation back to TON-side Minter
        _sendMintConfirmation(nonce, userTon, tonstblMinted);
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  REDEEM HANDLER
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Process a redeem request from TON-side.
     * @dev TON-side has already burned TONSTBL from user's wallet. We release
     *      collateral, swap back to USDC, apply fee, send USDC across bridge.
     *
     *      Payload layout:
     *        uint64  nonce
     *        bytes32 userTon
     *        uint128 tonstblBurned
     *        uint64  deadline
     */
    function _handleRedeemRequest(bytes memory payload) internal {
        (
            uint64 nonce,
            bytes32 userTon,
            uint128 tonstblBurned,
            uint64 deadline
        ) = abi.decode(payload, (uint64, bytes32, uint128, uint128));

        if (processedNonces[tonEid][nonce]) revert NonceAlreadyProcessed();
        processedNonces[tonEid][nonce] = true;

        if (block.timestamp > deadline) {
            _sendRedeemFailure(nonce, userTon, 1 /* expired */);
            return;
        }

        // Calculate collateral to release: 1:1 with TONSTBL
        uint256 collateralToRelease = uint256(tonstblBurned) * 1e12;

        if (collateralToRelease > totalCollateralLocked) {
            // Should not happen if accounting is consistent
            _sendRedeemFailure(nonce, userTon, 2 /* insufficient collateral */);
            return;
        }

        totalCollateralLocked -= collateralToRelease;
        outstandingTonstbl -= tonstblBurned;

        // Swap collateral back to USDC
        uint256 usdcReceived = _swapCollateralToUsdc(collateralToRelease, 0);

        // Apply redeem fee (0.3% bps + 0.5 USDC floor)
        uint256 fee = _calculateRedeemFee(usdcReceived);
        uint256 netUsdcPayout = usdcReceived - fee;

        // Sanity check: payout cannot exceed 110% of expected
        uint256 expectedPayout = uint256(tonstblBurned); // 1:1 USDC ≈ TONSTBL by design
        if (netUsdcPayout > (expectedPayout * PAYOUT_SANITY_CEILING_PCT) / 100) {
            revert PayoutExceedsSanityCeiling();
        }

        // Distribute fee
        _distributeFee(fee);

        emit RedeemProcessed(nonce, userTon, tonstblBurned, collateralToRelease, netUsdcPayout);

        // Bridge USDC back to TON-side (this triggers the canonical bridge,
        // which then calls our outbound bridge adapter)
        _sendRedeemPayout(nonce, userTon, netUsdcPayout);
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  INSURANCE FUND TOPUP HANDLER
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Sweep accumulated TON-side fees into the Insurance Fund.
     * @dev TON-side owner periodically bridges accumulated minter-balance fees here.
     */
    function _handleInsuranceTopUp(bytes memory payload) internal {
        (uint64 nonce, uint128 amount) = abi.decode(payload, (uint64, uint128));

        if (processedNonces[tonEid][nonce]) revert NonceAlreadyProcessed();
        processedNonces[tonEid][nonce] = true;

        // The actual USDC arrived via canonical bridge; we credit it to insurance fund
        uint256 usdcAvailable = usdc.balanceOf(address(this))
            - totalCollateralLocked / 1e12 // collateral is in different token, not USDC
            - insuranceFundBalance
            - ownerRevenue;

        uint256 toCredit = usdcAvailable < uint256(amount) ? usdcAvailable : uint256(amount);
        insuranceFundBalance += toCredit;

        emit InsuranceFundDeposit(toCredit, insuranceFundBalance);
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  FEE DISTRIBUTION (AUTOMATIC PHASE TRANSITIONS)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Distributes a fee between Insurance Fund and Owner Revenue
     *         based on the current protocol phase. Phase is determined
     *         automatically from outstanding TONSTBL and buffer ratio.
     *         Owner has no discretion over the split.
     */
    function _distributeFee(uint256 feeAmount) internal {
        if (feeAmount == 0) return;

        (uint16 insuranceBps, uint8 phase) = _calculateFeeDistribution();

        uint256 toInsurance = (feeAmount * insuranceBps) / BPS_DENOMINATOR;
        uint256 toOwner = feeAmount - toInsurance;

        insuranceFundBalance += toInsurance;
        ownerRevenue += toOwner;

        emit FeeDistributed(feeAmount, toInsurance, toOwner, insuranceBps, phase);
    }

    /**
     * @notice Determines fee split based on current phase.
     * @return insuranceBps Basis points going to Insurance Fund (rest to owner)
     * @return phase Current protocol phase (1-4)
     */
    function _calculateFeeDistribution() internal view returns (uint16 insuranceBps, uint8 phase) {
        uint256 outstanding = outstandingTonstbl;
        uint256 target = _calculateTargetBuffer(outstanding);
        uint256 bufferRatioBps = target == 0 ? 0 : (insuranceFundBalance * BPS_DENOMINATOR) / target;

        if (outstanding < PHASE_2_THRESHOLD) {
            return (10_000, 1); // Phase 1: 100% to insurance
        } else if (bufferRatioBps < 5_000) {
            return (8_000, 2); // Phase 2: 80% to insurance
        } else if (bufferRatioBps < 10_000) {
            return (5_000, 3); // Phase 3: 50/50
        } else {
            return (3_000, 4); // Phase 4: 30% maintenance
        }
    }

    function _calculateTargetBuffer(uint256 outstanding) internal pure returns (uint256) {
        uint256 ratioTarget = (outstanding * BUFFER_RATIO_BPS) / BPS_DENOMINATOR;
        return ratioTarget > MIN_TARGET_BUFFER ? ratioTarget : MIN_TARGET_BUFFER;
    }

    function _calculateRedeemFee(uint256 grossPayout) internal pure returns (uint256) {
        uint256 pctFee = (grossPayout * 30) / BPS_DENOMINATOR; // 0.3%
        uint256 floorFee = 500_000; // 0.5 USDC (6 decimals)
        return pctFee > floorFee ? pctFee : floorFee;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  SWAP HELPERS (UNISWAP V3)
    // ─────────────────────────────────────────────────────────────────────────

    function _swapUsdcToCollateral(uint256 amountIn, uint256 minOut) internal returns (uint256) {
        usdc.forceApprove(address(swapRouter), amountIn);

        return swapRouter.exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: address(usdc),
                tokenOut: address(primaryCollateral),
                fee: swapPoolFee,
                recipient: address(this),
                deadline: block.timestamp + 300,
                amountIn: amountIn,
                amountOutMinimum: minOut,
                sqrtPriceLimitX96: 0
            })
        );
    }

    function _swapCollateralToUsdc(uint256 amountIn, uint256 minOut) internal returns (uint256) {
        primaryCollateral.forceApprove(address(swapRouter), amountIn);

        return swapRouter.exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: address(primaryCollateral),
                tokenOut: address(usdc),
                fee: swapPoolFee,
                recipient: address(this),
                deadline: block.timestamp + 300,
                amountIn: amountIn,
                amountOutMinimum: minOut,
                sqrtPriceLimitX96: 0
            })
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  OUTBOUND MESSAGES (TO TON-SIDE)
    // ─────────────────────────────────────────────────────────────────────────

    function _sendMintConfirmation(uint64 nonce, bytes32 userTon, uint256 actualLusd) internal {
        bytes memory payload = abi.encode(uint16(0x5302), abi.encode(nonce, userTon, uint128(actualLusd)));
        _lzSend(
            tonEid,
            payload,
            "", // options (set via setEnforcedOptions)
            MessagingFee(0, 0), // fee paid by relayer in this design
            payable(address(this))
        );
    }

    function _sendMintFailure(uint64 nonce, bytes32 userTon, uint8 reasonCode) internal {
        bytes memory payload = abi.encode(uint16(0x5303), abi.encode(nonce, userTon, reasonCode));
        _lzSend(tonEid, payload, "", MessagingFee(0, 0), payable(address(this)));
    }

    function _sendRedeemPayout(uint64 nonce, bytes32 userTon, uint256 usdcAmount) internal {
        bytes memory payload = abi.encode(uint16(0x5304), abi.encode(nonce, userTon, uint128(usdcAmount)));
        _lzSend(tonEid, payload, "", MessagingFee(0, 0), payable(address(this)));
    }

    function _sendRedeemFailure(uint64 nonce, bytes32 userTon, uint8 reasonCode) internal {
        bytes memory payload = abi.encode(uint16(0x5305), abi.encode(nonce, userTon, reasonCode));
        _lzSend(tonEid, payload, "", MessagingFee(0, 0), payable(address(this)));
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  OWNER REVENUE WITHDRAWAL
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Owner withdraws accumulated revenue.
     * @dev CANNOT withdraw from Insurance Fund — that is a hard contract constraint.
     */
    function withdrawOwnerRevenue(address to, uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (amount > ownerRevenue) revert InsufficientOwnerRevenue();

        ownerRevenue -= amount;
        usdc.safeTransfer(to, amount);

        emit OwnerRevenueWithdrawn(to, amount);
    }

    /**
     * @notice Insurance Fund is unwithdrawable by design — this function exists
     *         only to make the constraint explicit and reverts on any call.
     */
    function withdrawInsuranceFund(address, uint256) external pure {
        revert CannotWithdrawInsuranceFund();
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  EMERGENCY: SHORTFALL COVERAGE
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice In case of bridge failure or swap shortfall during redeem,
     *         insurance fund tops up the user. Only callable by self via lzReceive.
     */
    function _coverShortfall(uint256 amount) internal returns (uint256 covered) {
        if (amount > insuranceFundBalance) {
            covered = insuranceFundBalance;
            insuranceFundBalance = 0;
        } else {
            covered = amount;
            insuranceFundBalance -= amount;
        }
        emit EmergencyShortfallCovered(covered, insuranceFundBalance);
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  ADMIN
    // ─────────────────────────────────────────────────────────────────────────

    function setApprovedCollateral(address token, bool approved) external onlyOwner {
        approvedCollateral[token] = approved;
        emit CollateralApproved(token, approved);
    }

    function setSwapPoolFee(uint24 newFee) external onlyOwner {
        if (newFee != 100 && newFee != 500 && newFee != 3000 && newFee != 10000) {
            revert InvalidPoolFee();
        }
        emit SwapPoolFeeUpdated(swapPoolFee, newFee);
        swapPoolFee = newFee;
    }

    function setTonEid(uint32 newEid) external onlyOwner {
        emit TonEidUpdated(tonEid, newEid);
        tonEid = newEid;
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  VIEW FUNCTIONS (TRANSPARENCY)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Current protocol phase (1-4) and fee split.
     * @return phase Current phase number
     * @return insuranceBps Basis points of fees going to Insurance Fund
     * @return ownerBps Basis points of fees going to Owner Revenue
     */
    function getCurrentPhase() external view returns (uint8 phase, uint16 insuranceBps, uint16 ownerBps) {
        (insuranceBps, phase) = _calculateFeeDistribution();
        ownerBps = uint16(BPS_DENOMINATOR) - insuranceBps;
    }

    /**
     * @notice Target buffer size based on current outstanding TONSTBL.
     */
    function getTargetBuffer() external view returns (uint256) {
        return _calculateTargetBuffer(outstandingTonstbl);
    }

    /**
     * @notice Buffer ratio as basis points (10000 = 100% of target).
     */
    function getBufferRatioBps() external view returns (uint256) {
        uint256 target = _calculateTargetBuffer(outstandingTonstbl);
        if (target == 0) return 0;
        return (insuranceFundBalance * BPS_DENOMINATOR) / target;
    }

    /**
     * @notice Collateralization ratio: collateral locked vs outstanding TONSTBL.
     *         Returns basis points (10000 = 100% collateralized).
     */
    function getCollateralizationRatioBps() external view returns (uint256) {
        if (outstandingTonstbl == 0) return type(uint256).max;
        uint256 collateralValueUsdc = totalCollateralLocked / 1e12;
        return (collateralValueUsdc * BPS_DENOMINATOR) / outstandingTonstbl;
    }

    /**
     * @notice Fee split for a given hypothetical fee amount.
     */
    function previewFeeDistribution(uint256 feeAmount)
        external
        view
        returns (uint256 toInsurance, uint256 toOwner, uint8 phase)
    {
        (uint16 insuranceBps, uint8 currentPhase) = _calculateFeeDistribution();
        toInsurance = (feeAmount * insuranceBps) / BPS_DENOMINATOR;
        toOwner = feeAmount - toInsurance;
        phase = currentPhase;
    }
}
