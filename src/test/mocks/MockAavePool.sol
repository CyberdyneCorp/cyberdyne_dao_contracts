// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.17;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IAavePool} from "../../plugins/aave/adapters/IAavePool.sol";

/// @title MockAavePool
/// @notice Minimal stand-in for the AAVE v3 `Pool` that lets unit tests
///         exercise `AaveV3Adapter` end-to-end without a fork.
/// @dev    Records every call so tests can assert AaveV3Adapter forwarded
///         the right arguments (including the hardcoded `referralCode = 0`).
///         Token accounting mirrors AAVE in spirit: `supply` pulls funds,
///         `withdraw`/`borrow` push them, `repay` pulls them. Use this for
///         unit tests; the real Pool is exercised in the fork test.
contract MockAavePool is IAavePool {
    struct SupplyCall {
        address asset;
        uint256 amount;
        address onBehalfOf;
        uint16 referralCode;
    }

    struct BorrowCall {
        address asset;
        uint256 amount;
        uint256 interestRateMode;
        uint16 referralCode;
        address onBehalfOf;
    }

    SupplyCall public lastSupply;
    BorrowCall public lastBorrow;
    address public lastWithdrawTo;
    uint256 public lastWithdrawAmount;
    address public lastRepayOnBehalfOf;
    uint256 public lastRepayAmount;

    /// @notice `aTokenBalance[user][asset]` — simplified balance ledger.
    mapping(address => mapping(address => uint256)) public aTokenBalance;
    mapping(address => mapping(address => mapping(uint256 => uint256))) public debt;

    // Static health data tests can configure if needed.
    uint256 public totalCollateralBase;
    uint256 public totalDebtBase;
    uint256 public availableBorrowsBase;
    uint256 public currentLiquidationThreshold;
    uint256 public ltv;
    uint256 public healthFactor;

    /// @inheritdoc IAavePool
    function supply(
        address asset,
        uint256 amount,
        address onBehalfOf,
        uint16 referralCode
    ) external override {
        lastSupply = SupplyCall(asset, amount, onBehalfOf, referralCode);
        require(
            IERC20(asset).transferFrom(msg.sender, address(this), amount),
            "MockAavePool: transferFrom failed"
        );
        aTokenBalance[onBehalfOf][asset] += amount;
    }

    /// @inheritdoc IAavePool
    function withdraw(
        address asset,
        uint256 amount,
        address to
    ) external override returns (uint256) {
        uint256 bal = aTokenBalance[msg.sender][asset];
        uint256 toWithdraw = amount > bal ? bal : amount;
        aTokenBalance[msg.sender][asset] = bal - toWithdraw;
        lastWithdrawTo = to;
        lastWithdrawAmount = toWithdraw;
        require(IERC20(asset).transfer(to, toWithdraw), "MockAavePool: transfer failed");
        return toWithdraw;
    }

    /// @inheritdoc IAavePool
    function borrow(
        address asset,
        uint256 amount,
        uint256 interestRateMode,
        uint16 referralCode,
        address onBehalfOf
    ) external override {
        lastBorrow = BorrowCall(asset, amount, interestRateMode, referralCode, onBehalfOf);
        debt[msg.sender][asset][interestRateMode] += amount;
        require(IERC20(asset).transfer(onBehalfOf, amount), "MockAavePool: transfer failed");
    }

    /// @inheritdoc IAavePool
    function repay(
        address asset,
        uint256 amount,
        uint256 interestRateMode,
        address onBehalfOf
    ) external override returns (uint256) {
        uint256 outstanding = debt[onBehalfOf][asset][interestRateMode];
        uint256 toPay = amount > outstanding ? outstanding : amount;
        lastRepayOnBehalfOf = onBehalfOf;
        lastRepayAmount = toPay;
        require(
            IERC20(asset).transferFrom(msg.sender, address(this), toPay),
            "MockAavePool: transferFrom failed"
        );
        debt[onBehalfOf][asset][interestRateMode] = outstanding - toPay;
        return toPay;
    }

    /// @inheritdoc IAavePool
    function getUserAccountData(
        address /* user */
    ) external view override returns (uint256, uint256, uint256, uint256, uint256, uint256) {
        return (
            totalCollateralBase,
            totalDebtBase,
            availableBorrowsBase,
            currentLiquidationThreshold,
            ltv,
            healthFactor
        );
    }

    function setHealthData(
        uint256 _totalCollateralBase,
        uint256 _totalDebtBase,
        uint256 _availableBorrowsBase,
        uint256 _currentLiquidationThreshold,
        uint256 _ltv,
        uint256 _healthFactor
    ) external {
        totalCollateralBase = _totalCollateralBase;
        totalDebtBase = _totalDebtBase;
        availableBorrowsBase = _availableBorrowsBase;
        currentLiquidationThreshold = _currentLiquidationThreshold;
        ltv = _ltv;
        healthFactor = _healthFactor;
    }
}
