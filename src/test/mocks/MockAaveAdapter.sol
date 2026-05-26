// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.17;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IAaveAdapter} from "../../plugins/aave/adapters/IAaveAdapter.sol";

/// @title MockAaveAdapter
/// @notice Test-only `IAaveAdapter` with realistic-enough behavior to verify
///         the plugin's flow end-to-end without a real AAVE pool.
/// @dev    Custody model mirrors AAVE in spirit:
///         - `supply` pulls `asset` from the caller (DAO via approve) into
///           the adapter, and tracks an "aToken-equivalent" balance for
///           `onBehalfOf` keyed by underlying.
///         - `withdraw` burns the aToken-equivalent and sends `asset` from
///           the adapter back to `to`.
///         - `borrow` transfers `asset` from a pre-funded adapter pool to
///           `onBehalfOf` and bumps a per-mode debt counter.
///         - `repay` pulls `asset` from caller and reduces the debt counter.
///         No price oracles, no interest accrual — those are AAVE's concern.
///         What we care about is: who holds what after each call.
contract MockAaveAdapter is IAaveAdapter {
    /// @dev Non-zero by default so `IERC20.approve(pool, amount)` works.
    ///      Settable in case tests want to point approvals at a sentinel
    ///      address distinct from the adapter itself.
    address public poolAddressOverride;

    /// @notice `aTokenBalance[user][asset]` — aToken-equivalent balance.
    mapping(address => mapping(address => uint256)) public aTokenBalance;

    /// @notice `debt[user][asset][interestRateMode]` — outstanding debt.
    mapping(address => mapping(address => mapping(uint256 => uint256))) public debt;

    constructor() {
        // Default to the adapter's own address so the DAO approves something
        // real that `transferFrom` can spend. Tests can override.
        poolAddressOverride = address(this);
    }

    /// @notice Override the address returned by `poolAddress()`. Useful for
    ///         testing scenarios where the approve target should NOT be the
    ///         adapter itself.
    function setPoolAddress(address _pool) external {
        poolAddressOverride = _pool;
    }

    /// @inheritdoc IAaveAdapter
    function poolAddress() external view override returns (address) {
        return poolAddressOverride;
    }

    /// @inheritdoc IAaveAdapter
    /// @dev Pulls via `transferFrom(msg.sender, this, amount)`, so the
    ///      caller (typically the DAO) must have approved `poolAddress()`
    ///      for at least `amount`. We use `address(this)` as the spender
    ///      so the same allowance also gates `repay`.
    function supply(address asset, uint256 amount, address onBehalfOf) external override {
        require(
            IERC20(asset).transferFrom(msg.sender, address(this), amount),
            "MockAaveAdapter: transferFrom failed"
        );
        aTokenBalance[onBehalfOf][asset] += amount;
    }

    /// @inheritdoc IAaveAdapter
    function withdraw(
        address asset,
        uint256 amount,
        address to
    ) external override returns (uint256) {
        uint256 bal = aTokenBalance[msg.sender][asset];
        uint256 toWithdraw = amount > bal ? bal : amount;
        aTokenBalance[msg.sender][asset] = bal - toWithdraw;
        require(
            IERC20(asset).transfer(to, toWithdraw),
            "MockAaveAdapter: transfer failed"
        );
        return toWithdraw;
    }

    /// @inheritdoc IAaveAdapter
    /// @dev Transfers `amount` of `asset` from the adapter's own balance to
    ///      `onBehalfOf` and credits debt against `msg.sender` so the same
    ///      caller (DAO) can later `repay`. Test setup must pre-fund the
    ///      adapter with `asset`.
    function borrow(
        address asset,
        uint256 amount,
        uint256 interestRateMode,
        address onBehalfOf
    ) external override {
        debt[msg.sender][asset][interestRateMode] += amount;
        require(
            IERC20(asset).transfer(onBehalfOf, amount),
            "MockAaveAdapter: transfer failed"
        );
    }

    /// @inheritdoc IAaveAdapter
    function repay(
        address asset,
        uint256 amount,
        uint256 interestRateMode,
        address onBehalfOf
    ) external override returns (uint256) {
        uint256 outstanding = debt[onBehalfOf][asset][interestRateMode];
        uint256 toPay = amount > outstanding ? outstanding : amount;
        require(
            IERC20(asset).transferFrom(msg.sender, address(this), toPay),
            "MockAaveAdapter: transferFrom failed"
        );
        debt[onBehalfOf][asset][interestRateMode] = outstanding - toPay;
        return toPay;
    }
}
