// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.17;

import {IAaveAdapter} from "./IAaveAdapter.sol";
import {IAavePool} from "./IAavePool.sol";

/// @title AaveV3Adapter
/// @notice Calldata builder for the AAVE v3 `Pool`, conforming to `IAaveAdapter`.
///         Lets `AaveLendingPlugin` stay version-agnostic: a v4 adapter
///         implementing the same interface drops in via `setAdapter` with no
///         plugin redeploy.
/// @dev    Stateless + immutable. It does NOT call the pool — it only encodes
///         the calldata the DAO uses to call the pool directly (see
///         IAaveAdapter for why this is the only design compatible with AAVE's
///         msg.sender-based custody model).
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
    function encodeSupply(
        address asset,
        uint256 amount,
        address onBehalfOf
    ) external pure override returns (bytes memory) {
        return
            abi.encodeWithSelector(
                IAavePool.supply.selector,
                asset,
                amount,
                onBehalfOf,
                REFERRAL_CODE
            );
    }

    /// @inheritdoc IAaveAdapter
    function encodeWithdraw(
        address asset,
        uint256 amount,
        address to
    ) external pure override returns (bytes memory) {
        return abi.encodeWithSelector(IAavePool.withdraw.selector, asset, amount, to);
    }

    /// @inheritdoc IAaveAdapter
    function encodeBorrow(
        address asset,
        uint256 amount,
        uint256 interestRateMode,
        address onBehalfOf
    ) external pure override returns (bytes memory) {
        return
            abi.encodeWithSelector(
                IAavePool.borrow.selector,
                asset,
                amount,
                interestRateMode,
                REFERRAL_CODE,
                onBehalfOf
            );
    }

    /// @inheritdoc IAaveAdapter
    function encodeRepay(
        address asset,
        uint256 amount,
        uint256 interestRateMode,
        address onBehalfOf
    ) external pure override returns (bytes memory) {
        return
            abi.encodeWithSelector(
                IAavePool.repay.selector,
                asset,
                amount,
                interestRateMode,
                onBehalfOf
            );
    }
}
