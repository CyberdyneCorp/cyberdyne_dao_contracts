// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.17;

/// @title IV4PositionManager
/// @notice Minimal subset of Uniswap v4-periphery `PositionManager` the plugin
///         needs to drive the LP lifecycle. Kept local to avoid pulling the
///         whole v4-periphery tree into our 0.8.17 build.
/// @dev    All LP ops (mint / increase / decrease / burn) are submitted through
///         a single entry point — `modifyLiquidities(unlockData, deadline)` —
///         where `unlockData = abi.encode(bytes actions, bytes[] params)`. Each
///         byte in `actions` is one entry from the v4-periphery `Actions` enum
///         (e.g. MINT_POSITION = 0x02, INCREASE_LIQUIDITY = 0x00,
///         DECREASE_LIQUIDITY = 0x01, BURN_POSITION = 0x03, SETTLE_PAIR = 0x0d,
///         TAKE_PAIR = 0x11); `params[i]` is the abi-encoded args for action i.
///
///         The PositionManager pulls input currencies via Permit2 (same as the
///         Universal Router), so the caller must (a) approve Permit2 on each
///         input ERC20 and (b) Permit2-approve the PositionManager for the
///         spend, before calling `modifyLiquidities`. Position NFTs are minted
///         to the `owner` encoded in the action params.
interface IV4PositionManager {
    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable;

    /// @notice The PoolManager this PositionManager is wired to. Used at install
    ///         to fail-fast if the configured PM doesn't point at the expected
    ///         PoolManager on this chain.
    function poolManager() external view returns (address);
}
