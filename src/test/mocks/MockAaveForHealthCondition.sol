// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.17;

/// @title MockAaveForHealthCondition
/// @notice A single mock that plays AAVE Pool + PoolAddressesProvider + price
///         oracle for BorrowHealthCondition unit tests. Account data, per-asset
///         prices, and a revert toggle are all settable so the tests can drive
///         the projection math and the fail-closed path deterministically.
contract MockAaveForHealthCondition {
    uint256 public totalCollateralBase;
    uint256 public totalDebtBase;
    uint256 public currentLiquidationThreshold; // bps
    uint256 public healthFactor; // 18-dec; returned verbatim by currentHealthFactor

    mapping(address => uint256) public price; // asset => base (8-dec) price
    bool public oracleReverts;

    function setHealthData(
        uint256 _collateral,
        uint256 _debt,
        uint256 _liqThreshold,
        uint256 _healthFactor
    ) external {
        totalCollateralBase = _collateral;
        totalDebtBase = _debt;
        currentLiquidationThreshold = _liqThreshold;
        healthFactor = _healthFactor;
    }

    function setPrice(address asset, uint256 p) external {
        price[asset] = p;
    }

    function setOracleReverts(bool v) external {
        oracleReverts = v;
    }

    // --- IAavePoolView ---
    function getUserAccountData(
        address
    ) external view returns (uint256, uint256, uint256, uint256, uint256, uint256) {
        return (totalCollateralBase, totalDebtBase, 0, currentLiquidationThreshold, 0, healthFactor);
    }

    function ADDRESSES_PROVIDER() external view returns (address) {
        return address(this);
    }

    // --- IPoolAddressesProvider ---
    function getPriceOracle() external view returns (address) {
        return address(this);
    }

    // --- IAaveOracleView ---
    function getAssetPrice(address asset) external view returns (uint256) {
        require(!oracleReverts, "oracle down");
        return price[asset];
    }
}
