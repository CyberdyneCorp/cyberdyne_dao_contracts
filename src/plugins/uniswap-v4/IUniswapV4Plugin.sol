// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.17;

import {Action} from "@aragon/osx-commons-contracts/src/executors/IExecutor.sol";

/// @title IUniswapV4Plugin
/// @notice Vote-gated DAO swap surface for Uniswap V4 via the Universal Router + Permit2.
/// @dev Plugin never custodies funds. The DAO holds `tokenIn` and receives `tokenOut`.
///      The post-swap balance delta must satisfy `minAmountOut` (slippage guard).
interface IUniswapV4Plugin {
    /// @notice Emitted on every executed swap. Indexed for subgraph/UI consumption.
    /// @param tokenIn The asset spent by the DAO.
    /// @param amountIn The amount of `tokenIn` spent.
    /// @param tokenOut The asset received by the DAO.
    /// @param amountOutActual The actual `tokenOut` balance delta on the DAO post-swap.
    event SwapExecuted(
        address indexed tokenIn,
        uint256 amountIn,
        address indexed tokenOut,
        uint256 amountOutActual
    );

    /// @notice Emitted when a token's allowlist flag is toggled.
    event AllowedTokenSet(address indexed token, bool allowed);

    /// @notice Emitted when the Universal Router target is migrated.
    event UniversalRouterUpdated(address indexed previous, address indexed current);

    /// @notice Emitted when the v4 PositionManager target is migrated.
    event V4PositionManagerUpdated(address indexed previous, address indexed current);

    /// @notice Emitted on every successful `modifyLiquidities` call.
    /// @param opNonce Monotonic counter used to derive the executor callId.
    event LiquidityModified(uint256 indexed opNonce);

    // --- Errors ---

    /// @notice Reverts when a swap or LP op targets a non-allowlisted token
    ///         (only when the allowlist is enforced).
    error TokenNotAllowed(address token);

    /// @notice Reverts when the post-swap delta is less than `minAmountOut`.
    error SlippageExceeded(uint256 received, uint256 minExpected);

    /// @notice Reverts when the post-LP-op balance delta on an output currency
    ///         falls short of `minOut` (slippage guard for the DAO).
    error OutputShortfall(address currency, uint256 received, uint256 minExpected);

    /// @notice Reverts when `deadline` has passed.
    error DeadlineExpired();

    /// @notice Reverts when array lengths don't match (input vs. maxIn, output vs. minOut).
    error LengthMismatch();

    /// @notice Reverts when the v4 PositionManager isn't configured (build-1 plugin
    ///         installed before the LP feature; call `setV4PositionManager` first).
    error PositionManagerUnset();

    /// @notice Reverts when a placeholder function has not yet been implemented.
    error NotImplemented();

    /// @notice Reverts when an action in `unlockData` is a `MINT_POSITION` whose
    ///         encoded `owner` doesn't match the DAO. Closes the proposal-review-
    ///         only gap that the plugin would otherwise let a malicious proposal
    ///         mint a DAO-funded position to a stranger.
    error MintRecipientMustBeDao(address encodedOwner, address dao);

    /// @notice Reverts when `unlockData` is shorter than the v4 action-stream
    ///         envelope (`abi.encode(bytes actions, bytes[] params)`) requires.
    error UnlockDataTooShort();

    // --- Vote-gated mutators ---

    /// @notice Execute a swap via the Universal Router. The DAO is the spender and recipient.
    /// @param commands Universal Router command bytes.
    /// @param inputs ABI-encoded inputs per command.
    /// @param deadline Unix timestamp after which the swap reverts.
    /// @param tokenIn Asset the DAO spends.
    /// @param amountIn Amount of `tokenIn` to spend.
    /// @param tokenOut Asset the DAO expects to receive.
    /// @param minAmountOut Minimum acceptable `tokenOut` delta on the DAO (slippage guard).
    function swap(
        bytes calldata commands,
        bytes[] calldata inputs,
        uint256 deadline,
        address tokenIn,
        uint256 amountIn,
        address tokenOut,
        uint256 minAmountOut
    ) external;

    /// @notice Action-builder view for the governance path: returns the exact
    ///         `Action[]` `modifyLiquidities` would submit via `dao.execute`
    ///         (approve → Permit2.approve → PM.modifyLiquidities → approve(0)).
    ///         The `outputCurrencies`/`minOut` slippage guard from the wrapper
    ///         is NOT applied here — that check is wrapper-only. Output-side
    ///         min amounts are encoded inside the v4 action stream's TAKE_*
    ///         params and enforced by v4-periphery.
    function previewModifyLiquiditiesActions(
        bytes calldata unlockData,
        uint256 deadline,
        address[] calldata inputCurrencies,
        uint256[] calldata maxIn
    ) external view returns (Action[] memory);

    /// @notice Run a v4 LP-lifecycle batch on the v4 PositionManager (mint,
    ///         increase, decrease, burn — any combination encoded in
    ///         `unlockData`). The DAO executes the call; the position NFT is
    ///         owned by whichever `owner` the proposal encoded in MINT_POSITION
    ///         (recommended: `dao()`). The plugin enforces:
    ///           • allowance lifecycle for every input currency (DAO→Permit2
    ///             exact-amount, Permit2→PositionManager `maxIn`, both reset to
    ///             zero after the call so no allowance lingers), and
    ///           • a post-call balance delta ≥ `minOut` for every output
    ///             currency (slippage guard for the DAO).
    ///         The proposal builds the v4 action stream off-chain (Uniswap SDK)
    ///         and supplies `unlockData = abi.encode(actions, params)` verbatim.
    /// @param unlockData       Encoded v4 action stream.
    /// @param deadline         Unix ts after which the op reverts (forwarded to
    ///                         the PositionManager and the Permit2 allowances).
    /// @param inputCurrencies  ERC20 tokens the DAO pays (omit native ETH).
    /// @param maxIn            Exact-amount allowance per input currency.
    /// @param outputCurrencies Currencies the DAO expects to receive (any).
    /// @param minOut           Minimum delta on each output currency.
    function modifyLiquidities(
        bytes calldata unlockData,
        uint256 deadline,
        address[] calldata inputCurrencies,
        uint256[] calldata maxIn,
        address[] calldata outputCurrencies,
        uint256[] calldata minOut
    ) external;

    /// @notice Update the Universal Router target (vote-gated).
    function setUniversalRouter(address newRouter) external;

    /// @notice Update the v4 PositionManager target (vote-gated, reuses
    ///         `UPDATE_ROUTER_PERMISSION` — both are Uniswap-endpoint updates).
    function setV4PositionManager(address newPositionManager) external;

    /// @notice Toggle an entry in the token allowlist (vote-gated).
    function setAllowedToken(address token, bool allowed) external;

    // --- Views ---

    function universalRouter() external view returns (address);

    function permit2() external view returns (address);

    function poolManager() external view returns (address);

    function v4PositionManager() external view returns (address);

    function allowedToken(address token) external view returns (bool);

    /// @notice True if the allowlist is enforced. False = no restriction.
    function allowlistEnforced() external view returns (bool);

    /// @notice Monotonically-increasing counter used to derive a unique `callId`
    ///         per swap when invoking `IExecutor.execute`. Useful for the
    ///         subgraph to correlate `SwapExecuted` ↔ `Executed` 1:1.
    function swapNonce() external view returns (uint256);
}
