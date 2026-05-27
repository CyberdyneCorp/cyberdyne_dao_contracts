// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.17;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {PermissionCondition} from "@aragon/osx-commons-contracts/src/permission/condition/PermissionCondition.sol";
import {IPermissionCondition} from "@aragon/osx-commons-contracts/src/permission/condition/IPermissionCondition.sol";

import {IAaveLendingPlugin} from "../IAaveLendingPlugin.sol";

/// @dev AAVE v3 surfaces this condition reads. Declared inline (no aave-v3
///      submodule) to keep the build independent of AAVE's remappings.
interface IAavePoolView {
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

    /// @notice The AAVE PoolAddressesProvider (used to resolve the price oracle).
    function ADDRESSES_PROVIDER() external view returns (address);
}

interface IPoolAddressesProvider {
    function getPriceOracle() external view returns (address);
}

interface IAaveOracleView {
    /// @notice Asset price in the pool's base currency (8-decimal USD on v3).
    function getAssetPrice(address asset) external view returns (uint256);
}

/// @title BorrowHealthCondition
/// @notice Enforces a minimum AAVE health factor for the Cyberdyne DAO's
///         borrows (TRD §6.2 / §11 / §16 #1) — turning "don't over-leverage"
///         from a proposal-review convention into an on-chain guard.
///
/// @dev    AAVE health factor is 18-decimal: `< 1e18` is liquidatable. The
///         floor (`minHealthFactor`, e.g. `1.5e18`) is fixed at deploy.
///
///         Two enforcement surfaces, because the plugin has two borrow paths:
///
///         1. **Direct `borrow()` path** (operator setups where
///            `TRIGGER_LENDING_PERMISSION` is delegated to a keeper/multisig
///            rather than only the DAO). Attach this contract to that grant via
///            `grantWithCondition(plugin, operator, TRIGGER_LENDING, condition)`.
///            `isGranted` decodes the pending `borrow(asset, amount, …)`,
///            *projects* the post-borrow health factor for the borrower, and
///            denies the call if it would breach the floor — a pre-trade check.
///
///         2. **Governance preview path** (the common case: a proposal carries
///            the raw `pool.borrow(onBehalfOf = DAO)` action, so the plugin's
///            `auth` modifier — and therefore any condition on it — never
///            fires). Append `assertHealthFactor(dao)` as the FINAL action of
///            the borrow proposal: executed in the same atomic `dao.execute`
///            batch immediately after the borrow, it reverts if the now-current
///            health factor is below the floor, rolling the whole batch back.
///
///         Fail-closed: if the oracle / pool / token-metadata reads revert,
///         the projection reverts too, so a borrow can never slip through on a
///         data error.
contract BorrowHealthCondition is PermissionCondition {
    /// @notice The AAVE v3 Pool this condition reads positions + the oracle from.
    IAavePoolView public immutable pool;

    /// @notice Minimum acceptable health factor (18-decimal). A borrow that
    ///         would put the account's HF below this is denied / reverted.
    uint256 public immutable minHealthFactor;

    /// @notice The `AaveLendingPlugin.borrow` selector this condition gates.
    ///         Calls with any other selector pass `isGranted` untouched.
    bytes4 public constant BORROW_SELECTOR = IAaveLendingPlugin.borrow.selector;

    error ZeroAddress();
    error InvalidMinHealthFactor();
    /// @notice `assertHealthFactor` found the account below the floor.
    error HealthFactorBelowFloor(address account, uint256 healthFactor, uint256 floor);

    /// @param _pool            AAVE v3 Pool (e.g. `0x8787…4E2` on mainnet).
    /// @param _minHealthFactor Floor, 18-decimal. Must be ≥ 1e18 (≥ liquidation).
    constructor(IAavePoolView _pool, uint256 _minHealthFactor) {
        if (address(_pool) == address(0)) revert ZeroAddress();
        if (_minHealthFactor < 1e18) revert InvalidMinHealthFactor();
        pool = _pool;
        minHealthFactor = _minHealthFactor;
    }

    /// @inheritdoc IPermissionCondition
    /// @dev Gates the direct `borrow()` path. Non-borrow selectors (supply /
    ///      withdraw / repay, or anything else sharing the permission) are
    ///      allowed — only borrows reduce the health factor in a way this
    ///      guard is responsible for. `_who` is the borrower (the DAO).
    function isGranted(
        address _where,
        address _who,
        bytes32 _permissionId,
        bytes calldata _data
    ) external view override returns (bool) {
        (_where, _permissionId); // unused — the grant already scopes plugin + permission
        if (_data.length < 4 || bytes4(_data[:4]) != BORROW_SELECTOR) {
            return true;
        }
        (address asset, uint256 amount, ) = abi.decode(_data[4:], (address, uint256, uint256));
        return projectedHealthFactorAfterBorrow(_who, asset, amount) >= minHealthFactor;
    }

    /// @notice Revert `HealthFactorBelowFloor` if `account`'s CURRENT AAVE
    ///         health factor is below the floor. Designed to be the trailing
    ///         action of a governance borrow batch (runs post-borrow, atomic),
    ///         but is a plain view anyone can call to introspect.
    function assertHealthFactor(address account) external view {
        uint256 hf = currentHealthFactor(account);
        if (hf < minHealthFactor) revert HealthFactorBelowFloor(account, hf, minHealthFactor);
    }

    /// @notice `account`'s current AAVE health factor (18-decimal). Returns
    ///         `type(uint256).max` when the account has no debt.
    function currentHealthFactor(address account) public view returns (uint256 healthFactor) {
        (, , , , , healthFactor) = pool.getUserAccountData(account);
    }

    /// @notice The health factor `account` WOULD have after borrowing `amount`
    ///         of `asset`, holding collateral constant (borrowing adds debt but
    ///         does not change the collateral mix, so the weighted liquidation
    ///         threshold is unchanged). Returns `type(uint256).max` if the
    ///         projected debt is zero.
    function projectedHealthFactorAfterBorrow(
        address account,
        address asset,
        uint256 amount
    ) public view returns (uint256) {
        (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,
            ,
            uint256 liquidationThreshold,
            ,

        ) = pool.getUserAccountData(account);

        // Value the new borrow in the pool's base currency (8-decimal USD).
        address oracle = IPoolAddressesProvider(pool.ADDRESSES_PROVIDER()).getPriceOracle();
        uint256 price = IAaveOracleView(oracle).getAssetPrice(asset); // base per whole token
        uint256 unit = 10 ** IERC20Metadata(asset).decimals();
        uint256 newDebtBase = (amount * price) / unit;

        uint256 projectedDebtBase = totalDebtBase + newDebtBase;
        if (projectedDebtBase == 0) return type(uint256).max;

        // Mirror AAVE's formula: HF = collateral · LT / debt, LT in bps, HF 1e18.
        return (totalCollateralBase * liquidationThreshold * 1e18) / (10000 * projectedDebtBase);
    }
}
