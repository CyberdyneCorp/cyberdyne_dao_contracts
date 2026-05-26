// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.17;

/// @title IAavePool
/// @notice Minimal AAVE v3 `Pool` surface we need from `AaveV3Adapter`.
/// @dev    Declared inline (no aave-v3-origin submodule) so we keep our build
///         independent of AAVE's upstream remappings. Signatures match the
///         deployed v3 Pool at `0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2`.
interface IAavePool {
    /// @notice Supply `amount` of `asset` to AAVE on behalf of `onBehalfOf`.
    /// @dev    The aToken corresponding to `asset` is minted to `onBehalfOf`.
    /// @param asset         Underlying token to supply.
    /// @param amount        Amount, in token decimals.
    /// @param onBehalfOf    Beneficiary of the aTokens.
    /// @param referralCode  Legacy referral code (kept zero by our adapter).
    function supply(
        address asset,
        uint256 amount,
        address onBehalfOf,
        uint16 referralCode
    ) external;

    /// @notice Withdraw `amount` of `asset` to `to`. Pass `type(uint256).max`
    ///         to withdraw the full balance.
    /// @return The actual amount withdrawn.
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);

    /// @notice Borrow `amount` of `asset` against the caller's collateral on
    ///         behalf of `onBehalfOf`. The variable/stable debt token is
    ///         minted to `onBehalfOf`.
    /// @param interestRateMode 1 = stable, 2 = variable.
    function borrow(
        address asset,
        uint256 amount,
        uint256 interestRateMode,
        uint16 referralCode,
        address onBehalfOf
    ) external;

    /// @notice Repay `amount` of `asset` for `onBehalfOf`. Pass
    ///         `type(uint256).max` to repay the full debt.
    /// @return The actual amount repaid.
    function repay(
        address asset,
        uint256 amount,
        uint256 interestRateMode,
        address onBehalfOf
    ) external returns (uint256);

    /// @notice Risk-adjusted summary of `user`'s position across all reserves.
    /// @return totalCollateralBase           In the pool's base currency (USD-pegged).
    /// @return totalDebtBase                 In the pool's base currency.
    /// @return availableBorrowsBase          In the pool's base currency.
    /// @return currentLiquidationThreshold   Weighted LT, in basis points.
    /// @return ltv                           Weighted LTV, in basis points.
    /// @return healthFactor                  In ray (1e18) — < 1e18 = liquidatable.
    function getUserAccountData(
        address user
    )
        external
        view
        returns (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,
            uint256 availableBorrowsBase,
            uint256 currentLiquidationThreshold,
            uint256 ltv,
            uint256 healthFactor
        );
}
