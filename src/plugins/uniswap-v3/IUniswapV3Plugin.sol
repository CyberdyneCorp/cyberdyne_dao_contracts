// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.17;

/// @title IUniswapV3Plugin
/// @notice Vote-gated management of the DAO's Uniswap V3 liquidity positions:
///         mint, increase, decrease, collect fees, burn. Every position NFT is
///         owned by the DAO; the plugin custodies nothing.
interface IUniswapV3Plugin {
    /// @notice Parameters for `mint`. Mirrors NPM's `MintParams` minus
    ///         `recipient` — the plugin forces the recipient to the DAO so a
    ///         position NFT can never be minted to anyone else.
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    // --- Events ---

    event PositionMinted(
        uint256 indexed tokenId,
        address indexed token0,
        address indexed token1,
        uint24 fee,
        uint128 liquidity,
        uint256 amount0,
        uint256 amount1
    );
    event LiquidityIncreased(
        uint256 indexed tokenId,
        uint128 liquidity,
        uint256 amount0,
        uint256 amount1
    );
    event LiquidityDecreased(uint256 indexed tokenId, uint128 liquidity);
    event FeesCollected(uint256 indexed tokenId, uint256 amount0, uint256 amount1);
    event PositionBurned(uint256 indexed tokenId);
    event PositionManagerUpdated(address indexed previous, address indexed current);
    event AllowedTokenSet(address indexed token, bool allowed);

    // --- Errors ---

    error ZeroAddress();
    error DeadlineExpired();
    error TokenNotAllowed(address token);

    // --- Vote-gated operations ---

    /// @notice Open a new V3 position; the NFT is minted to the DAO.
    function mint(MintParams calldata params) external;

    /// @notice Add liquidity to an existing DAO-owned position.
    function increaseLiquidity(
        uint256 tokenId,
        uint256 amount0Desired,
        uint256 amount1Desired,
        uint256 amount0Min,
        uint256 amount1Min,
        uint256 deadline
    ) external;

    /// @notice Remove liquidity from a position (tokens become collectable).
    function decreaseLiquidity(
        uint256 tokenId,
        uint128 liquidity,
        uint256 amount0Min,
        uint256 amount1Min,
        uint256 deadline
    ) external;

    /// @notice Collect owed tokens (fees + decreased liquidity) to the DAO.
    function collect(uint256 tokenId, uint128 amount0Max, uint128 amount1Max) external;

    /// @notice Burn an empty position NFT.
    function burn(uint256 tokenId) external;

    // --- Vote-gated admin ---

    function setPositionManager(address newManager) external;

    function setAllowedToken(address token, bool allowed) external;

    // --- Views ---

    function positionManager() external view returns (address);

    function allowedToken(address token) external view returns (bool);

    function allowlistEnforced() external view returns (bool);

    function opNonce() external view returns (uint256);
}
