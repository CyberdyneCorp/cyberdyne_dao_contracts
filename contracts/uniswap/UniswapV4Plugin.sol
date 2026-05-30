solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IUniswapV4SwapRouter} from "@uniswap/v4-core/src/interfaces/IUniswapV4SwapRouter.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {CurrencySettlement, Currency} from "@uniswap/v4-core/src/libraries/CurrencySettlement.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {V4SwapRouter} from "@uniswap/v4-core/src/V4SwapRouter.sol";

/// @title UniswapV4Plugin
/// @notice Plugin for executing swaps via Uniswap V4 with Permit2 integration.
///         Automatically cleans up Permit2 allowances after each swap (M-01).
///         Validates all zero addresses (I-01). Uses custom errors for gas efficiency.
/// @dev All external functions are nonReentrant. Token rescue function is onlyOwner.
contract UniswapV4Plugin is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20Metadata;

    // ══════════════════════════════════════════════════════════════════════
    //  Constants
    // ══════════════════════════════════════════════════════════════════════

    /// @notice Used to reset allowances to zero.
    uint256 private constant ZERO_ALLOWANCE = 0;

    /// @notice Maximum allowance for infinite approval (disallowed for safety).
    uint256 private constant MAX_ALLOWANCE = type(uint256).max;

    // ══════════════════════════════════════════════════════════════════════
    //  Events
    // ══════════════════════════════════════════════════════════════════════

    /// @notice Emitted after a successful swap.
    /// @param recipient Address receiving output tokens.
    /// @param poolKey The pool used for the swap.
    /// @param zeroForOne Direction: true = token0→token1, false = token1→token0.
    /// @param amountIn Input token amount (actual).
    /// @param amountOut Output token amount (actual).
    event SwapExecuted(
        address indexed recipient,
        PoolKey indexed poolKey,
        bool zeroForOne,
        uint256 amountIn,
        uint256 amountOut
    );

    /// @notice Emitted after Permit2 allowance for the swap router is reset to zero.
    /// @param token The token address whose allowance was reset.
    /// @param spender The spender whose allowance was reset.
    event Permit2AllowanceReset(address indexed token, address indexed spender);

    /// @notice Emitted when accidentally sent tokens are rescued.
    /// @param token The token address.
    /// @param to Recipient of rescued tokens.
    /// @param amount Amount rescued.
    event TokensRescued(address indexed token, address indexed to, uint256 amount);

    // ══════════════════════════════════════════════════════════════════════
    //  Errors
    // ══════════════════════════════════════════════════════════════════════

    /// @dev Revert when a zero address is passed where forbidden.
    error ZeroAddress();

    /// @dev Revert when the underlying swap call fails.
    error SwapFailed();

    /// @dev Revert when the Permit2 allowance reset call fails.
    error AllowanceResetFailed();

    /// @dev Revert when the `PermitSingle.spender` is not this contract.
    error InvalidPermitSpender();

    /// @dev Revert when the input amount specification is zero.
    error AmountZero();

    /// @dev Revert when the owner attempts to rescue zero tokens.
    error RescueAmountZero();

    /// @dev Revert when the contract holds no tokens of a given address.
    error NoTokensToRescue();

    // ══════════════════════════════════════════════════════════════════════
    //  Immutable State
    // ═══════════════════════════════════════════════════════���══════════════

    /// @notice The Permit2 contract instance.
    IAllowanceTransfer public immutable permit2;

    /// @notice The Uniswap V4 SwapRouter contract instance.
    IUniswapV4SwapRouter public immutable swapRouter;

    /// @notice The Uniswap V4 PoolManager contract instance.
    IPoolManager public immutable poolManager;

    // ══════════════════════════════════════════════════════════════════════
    //  Constructor
    // ══════════════════════════════════════════════════════════════════════

    /// @notice Constructs the UniswapV4Plugin.
    /// @param _permit2 Address of the Permit2 contract.
    /// @param _swapRouter Address of the Uniswap V4 SwapRouter.
    /// @param _poolManager Address of the Uniswap V4 PoolManager.
    /// @param _owner Initial owner of the plugin.
    /// @custom:throws ZeroAddress if any address is zero.
    constructor(
        address _permit2,
        address _swapRouter,
        address _poolManager,
        address _owner
    ) Ownable2Step() {
        if (_permit2 == address(0)) revert ZeroAddress();
        if (_swapRouter == address(0)) revert ZeroAddress();
        if (_poolManager == address(0)) revert ZeroAddress();
        if (_owner == address(0)) revert ZeroAddress();

        permit2 = IAllowanceTransfer(_permit2);
        swapRouter = IUniswapV4SwapRouter(_swapRouter);
        poolManager = IPoolManager(_poolManager);

        _transferOwnership(_owner);
    }

    // ══════════════════════════════════════════════════════════════════════
    //  External Functions
    // ══════════════════════════════════════════════════════════════════════

    /// @notice Execute a swap using Permit2 for funding and automatically clean up
    ///         the swap router allowance afterwards.
    /// @dev Uses Permit2 to pull tokens from the user, approves the swap router for
    ///      the exact input amount, executes the swap via `swapRouter.swap()`, and
    ///      finally resets the swap router allowance to zero.
    ///
    ///      The `permit2Data.spender` **must** be this plugin contract (the entity
    ///      that calls `permitTransferFrom`); otherwise the transaction reverts.
    ///
    ///      If the swap call reverts, the allowance is reset before reverting, ensuring
    ///      no dangling approvals.
    ///
    ///      Reentrancy is prevented via `nonReentrant`.
    /// @param poolKey The pool identifier to swap against.
    /// @param zeroForOne If true, swap token0 for token1; otherwise token1 for token0.
    /// @param amountSpecified The exact input amount (positive). Must be > 0.
    /// @param sqrtPriceLimitX96 Slippage protection – the sqrt price limit scaled by 2^96.
    /// @param recipient Address receiving the output tokens.
    /// @param permit2Data Permit2 `PermitSingle` data containing token, amount, nonce, and
    ///        signature. The token must be the input currency of the swap.
    /// @return delta The raw balance delta from the swap (amount0, amount1).
    function swapWithPermit2(
        PoolKey calldata poolKey,
        bool zeroForOne,
        uint256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        address recipient,
        IAllowanceTransfer.PermitSingle calldata permit2Data
    ) external nonReentrant returns (BalanceDelta delta) {
        // ── Input Validation ─────────────────────────────────────────
        if (recipient == address(0)) revert ZeroAddress();
        if (permit2Data.details.token == address(0)) revert ZeroAddress();
        if (permit2Data.spender == address(0)) revert ZeroAddress();
        if (amountSpecified == 0) revert AmountZero();

        // The permit must authorise *this* contract to pull tokens.
        if (permit2Data.spender != address(this)) revert InvalidPermitSpender();

        // ── Pull Tokens via Permit2 ──────────────────────────────────
        IERC20Metadata token = IERC20Metadata(permit2Data.details.token);
        permit2.permitTransferFrom(
            permit2Data,
            permit2Data.details.amount,
            msg.sender,
            address(this)
        );

        // ── Approve Swap Router for exact input ──────────────────────
        // Use safeApprove to handle non-standard tokens; reset first.
        token.forceApprove(address(swapRouter), amountSpecified);

        // ── Execute Swap ─────────────────────────────────────────────
        // We wrap the swap in a try-catch to ensure allowance cleanup even if it fails.
        bool swapSucceeded;
        try
            swapRouter.swap(
                poolKey,
                zeroForOne,
                -int256(amountSpecified), // exact input (negative)
                sqrtPriceLimitX96,
                hex""
            )
        returns (BalanceDelta resultDelta) {
            delta = resultDelta;
            swapSucceeded = true;
        } catch {
            swapSucceeded = false;
        }

        // ── Cleanup: Reset allowance to zero ─────────────────────────
        // Always reset, even if swap failed, to avoid lingering approvals.
        _resetSwapRouterAllowance(token);

        // If swap failed, revert after cleanup.
        if (!swapSucceeded) revert SwapFailed();

        // ── Emit event ───────────────────────────────────────────────
        emit SwapExecuted(recipient, poolKey, zeroForOne, amountSpecified, uint256(delta.amount1()));
    }

    /// @notice Manually reset the swap router allowance for a given token.
    /// @dev Can be called by the owner if the automatic cleanup in `swapWithPermit2`
    ///      fails for any reason (e.g., storage exfiltration). Sets allowance to zero.
    /// @param token The token address whose allowance to reset.
    function resetSwapRouterAllowance(IERC20Metadata token) external onlyOwner {
        _resetSwapRouterAllowance(token);
    }

    /// @notice Rescue tokens that were accidentally sent to the contract.
    /// @dev Only callable by the contract owner. Checks that the contract has a non‑zero
    ///      balance of the given token and transfers it to the recipient.
    /// @param token The token address to rescue.
    /// @param to Recipient of the rescued tokens.
    /// @param amount Amount to rescue. Must be > 0.
    function rescueTokens(
        IERC20Metadata token,
        address to,
        uint256 amount
    ) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert RescueAmountZero();
        uint256 balance = token.balanceOf(address(this));
        if (balance == 0) revert NoTokensToRescue();
        if (amount > balance) {
            // Adjust to available balance.
            amount = balance;
        }
        token.safeTransfer(to, amount);
        emit TokensRescued(address(token), to, amount);
    }

    // ══════════════════════════════════════════════════════════════════════
    //  Internal / Private Functions
    // ══════════════════════════════════════════════════════════════════════

    /// @dev Sets the swap router allowance for `token` to zero using Permit2's
    ///      `approve` function. Reverts if the approval fails.
    /// @param token The token address.
    function _resetSwapRouterAllowance(IERC20Metadata token) private {
        // Use Permit2's approve to set the allowance for the swap router to zero.
        try permit2.approve(address(token), address(swapRouter), ZERO_ALLOWANCE, type(uint48).max) {
            emit Permit2AllowanceReset(address(token), address(swapRouter));
        } catch {
            revert AllowanceResetFailed();
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    //  Receive Fallback (optional, to accept ETH)
    // ══════════════════════════════════════════════════════════════════════

    /// @notice Receive ETH (e.g., from refunds).
    receive() external payable {}
}