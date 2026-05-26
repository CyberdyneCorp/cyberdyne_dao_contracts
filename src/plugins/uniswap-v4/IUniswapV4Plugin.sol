// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.17;

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

    // --- Errors ---

    /// @notice Reverts when a swap targets a non-allowlisted token (only when allowlist is non-empty).
    error TokenNotAllowed(address token);

    /// @notice Reverts when the post-swap delta is less than `minAmountOut`.
    error SlippageExceeded(uint256 received, uint256 minExpected);

    /// @notice Reverts when `deadline` has passed.
    error DeadlineExpired();

    /// @notice Reverts when a placeholder function has not yet been implemented.
    error NotImplemented();

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

    /// @notice Update the Universal Router target (vote-gated).
    function setUniversalRouter(address newRouter) external;

    /// @notice Toggle an entry in the token allowlist (vote-gated).
    function setAllowedToken(address token, bool allowed) external;

    // --- Views ---

    function universalRouter() external view returns (address);

    function permit2() external view returns (address);

    function poolManager() external view returns (address);

    function allowedToken(address token) external view returns (bool);

    /// @notice True if the allowlist is enforced. False = no restriction.
    function allowlistEnforced() external view returns (bool);
}
