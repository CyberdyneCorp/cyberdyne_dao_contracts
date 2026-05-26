// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.17;

/// @title IAaveAdapter
/// @notice Version-isolating shim between AaveLendingPlugin and a concrete AAVE pool (v3, v4, …).
/// @dev Swapping versions = DAO vote calling `AaveLendingPlugin.setAdapter(newAdapter)`. No plugin redeploy.
interface IAaveAdapter {
    /// @notice Supply `amount` of `asset` to AAVE on behalf of `onBehalfOf`.
    function supply(address asset, uint256 amount, address onBehalfOf) external;

    /// @notice Withdraw `amount` of `asset` from AAVE to `to`. Returns actual amount withdrawn.
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);

    /// @notice Borrow `amount` of `asset` on behalf of `onBehalfOf` at the given rate mode.
    function borrow(
        address asset,
        uint256 amount,
        uint256 interestRateMode,
        address onBehalfOf
    ) external;

    /// @notice Repay `amount` of `asset` for `onBehalfOf`. Returns actual amount repaid.
    function repay(
        address asset,
        uint256 amount,
        uint256 interestRateMode,
        address onBehalfOf
    ) external returns (uint256);

    /// @notice The underlying AAVE Pool address — used to scope DAO approvals.
    function poolAddress() external view returns (address);
}
