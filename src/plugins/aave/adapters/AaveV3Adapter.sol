// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.17;

import {IAaveAdapter} from "./IAaveAdapter.sol";
import {IAavePool} from "./IAavePool.sol";

/// @title AaveV3Adapter
/// @notice Thin wrapper around the AAVE v3 `Pool` that conforms to our
///         `IAaveAdapter`. Lets `AaveLendingPlugin` stay version-agnostic:
///         a v4 adapter implementing the same interface can drop in via
///         `setAdapter` without redeploying the plugin.
/// @dev    The plugin executes from the DAO (via `IExecutor.execute`), so
///         every call into this adapter — and into the pool — has the DAO
///         as `msg.sender`. `onBehalfOf = dao` therefore yields aTokens /
///         debt tokens directly to the DAO. The adapter itself is
///         immutable + stateless; it never custodies funds.
contract AaveV3Adapter is IAaveAdapter {
    /// @notice Underlying AAVE v3 Pool. Set once at construction.
    IAavePool public immutable POOL;

    /// @notice AAVE v3 referral code. We don't run a referral program, so
    ///         we hardcode 0 — same value AAVE's own UI passes.
    uint16 private constant REFERRAL_CODE = 0;

    constructor(IAavePool _pool) {
        POOL = _pool;
    }

    /// @inheritdoc IAaveAdapter
    function poolAddress() external view override returns (address) {
        return address(POOL);
    }

    /// @inheritdoc IAaveAdapter
    function supply(address asset, uint256 amount, address onBehalfOf) external override {
        POOL.supply(asset, amount, onBehalfOf, REFERRAL_CODE);
    }

    /// @inheritdoc IAaveAdapter
    function withdraw(
        address asset,
        uint256 amount,
        address to
    ) external override returns (uint256) {
        return POOL.withdraw(asset, amount, to);
    }

    /// @inheritdoc IAaveAdapter
    function borrow(
        address asset,
        uint256 amount,
        uint256 interestRateMode,
        address onBehalfOf
    ) external override {
        POOL.borrow(asset, amount, interestRateMode, REFERRAL_CODE, onBehalfOf);
    }

    /// @inheritdoc IAaveAdapter
    function repay(
        address asset,
        uint256 amount,
        uint256 interestRateMode,
        address onBehalfOf
    ) external override returns (uint256) {
        return POOL.repay(asset, amount, interestRateMode, onBehalfOf);
    }
}
