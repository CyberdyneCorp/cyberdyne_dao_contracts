// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.17;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {PluginUUPSUpgradeable} from "@aragon/osx-commons-contracts/src/plugin/PluginUUPSUpgradeable.sol";
import {IDAO} from "@aragon/osx-commons-contracts/src/dao/IDAO.sol";
import {IExecutor, Action} from "@aragon/osx-commons-contracts/src/executors/IExecutor.sol";

import {IAaveLendingPlugin} from "./IAaveLendingPlugin.sol";
import {IAaveAdapter} from "./adapters/IAaveAdapter.sol";

/// @title AaveLendingPlugin
/// @notice Vote-gated DAO supply / withdraw / borrow / repay against AAVE,
///         routed through a pluggable `IAaveAdapter` so a v3 → v4 migration
///         is a single `setAdapter` vote with no plugin redeploy.
/// @dev    Plugin never custodies funds.
///         `onBehalfOf = dao()` on every adapter call so aTokens and debt
///         tokens are issued directly to the DAO.
///         Token movements happen via `IExecutor(dao).execute(...)`:
///         the DAO is the only address that can approve the pool, and the
///         DAO is the receiver of every withdraw / borrow.
contract AaveLendingPlugin is PluginUUPSUpgradeable, IAaveLendingPlugin {
    bytes32 public constant TRIGGER_LENDING_PERMISSION_ID = keccak256("TRIGGER_LENDING_PERMISSION");
    bytes32 public constant UPDATE_ADAPTER_PERMISSION_ID = keccak256("UPDATE_ADAPTER_PERMISSION");
    bytes32 public constant MANAGE_ALLOWLIST_PERMISSION_ID =
        keccak256("MANAGE_ALLOWLIST_PERMISSION");

    IAaveAdapter public override adapter;
    mapping(address => bool) public override allowedAsset;
    bool public override allowlistEnforced;

    /// @notice Strictly-increasing counter used to make each `IExecutor.execute`
    ///         callId unique, so the subgraph can join distinct operations
    ///         even when they touch the same `(asset, amount)` pair.
    uint256 private _opNonce;

    uint256[46] private __gap;

    /// @notice Initialize the plugin. Called once via the UUPS proxy constructor.
    /// @param _dao              DAO that authorizes this plugin and holds funds.
    /// @param _adapter          Concrete `IAaveAdapter` (v3 today, v4 later).
    /// @param _initialAllowlist If non-empty, seeds the asset allowlist and
    ///                          flips `allowlistEnforced=true`.
    function initialize(
        IDAO _dao,
        IAaveAdapter _adapter,
        address[] calldata _initialAllowlist
    ) external initializer {
        __PluginUUPSUpgradeable_init(_dao);
        if (address(_adapter) == address(0)) revert ZeroAddress();
        adapter = _adapter;

        if (_initialAllowlist.length > 0) {
            allowlistEnforced = true;
            for (uint256 i; i < _initialAllowlist.length; ++i) {
                allowedAsset[_initialAllowlist[i]] = true;
                emit AllowedAssetSet(_initialAllowlist[i], true);
            }
        }
    }

    // --- Vote-gated lending operations ------------------------------------

    /// @inheritdoc IAaveLendingPlugin
    /// @dev Two-action batch executed by the DAO — the DAO calls the pool
    ///      DIRECTLY (msg.sender at the pool = DAO), so the approval is
    ///      honored and aTokens are minted to the DAO:
    ///         1. `IERC20(asset).approve(pool, amount)` — exact-amount approval.
    ///         2. `pool.supply(asset, amount, dao, refCode)` — adapter-encoded.
    function supply(
        address asset,
        uint256 amount
    ) external override auth(TRIGGER_LENDING_PERMISSION_ID) {
        _checkAllowlist(asset);

        IAaveAdapter _adapter = adapter;
        address pool = _adapter.poolAddress();

        Action[] memory actions = new Action[](2);
        actions[0] = Action({
            to: asset,
            value: 0,
            data: abi.encodeCall(IERC20.approve, (pool, amount))
        });
        actions[1] = Action({
            to: pool,
            value: 0,
            data: _adapter.encodeSupply(asset, amount, address(dao()))
        });

        IExecutor(address(dao())).execute(_nextCallId("AAVE_SUPPLY:"), actions, 0);

        emit Supplied(asset, amount);
    }

    /// @inheritdoc IAaveLendingPlugin
    /// @dev Computes `received` as the DAO's `asset` balance delta. AAVE may
    ///      return less than `amount` (e.g. `type(uint256).max` semantics or
    ///      partial liquidity) — the event surfaces the actual amount.
    function withdraw(
        address asset,
        uint256 amount
    ) external override auth(TRIGGER_LENDING_PERMISSION_ID) {
        _checkAllowlist(asset);

        IAaveAdapter _adapter = adapter;

        // The DAO holds the aTokens, so it must be msg.sender at the pool for
        // the burn to resolve. No approve needed — withdraw burns the caller's
        // aTokens and sends the underlying to `to = dao`.
        Action[] memory actions = new Action[](1);
        actions[0] = Action({
            to: _adapter.poolAddress(),
            value: 0,
            data: _adapter.encodeWithdraw(asset, amount, address(dao()))
        });

        uint256 before = IERC20(asset).balanceOf(address(dao()));
        IExecutor(address(dao())).execute(_nextCallId("AAVE_WITHDRAW:"), actions, 0);
        uint256 received = IERC20(asset).balanceOf(address(dao())) - before;

        emit Withdrawn(asset, amount, received);
    }

    /// @inheritdoc IAaveLendingPlugin
    /// @dev Single-action batch; debt token is issued to the DAO.
    function borrow(
        address asset,
        uint256 amount,
        uint256 interestRateMode
    ) external override auth(TRIGGER_LENDING_PERMISSION_ID) {
        _checkAllowlist(asset);

        IAaveAdapter _adapter = adapter;

        // The DAO borrows against its OWN collateral (msg.sender = DAO =
        // onBehalfOf), so the debt token is issued to the DAO and no credit
        // delegation is required.
        Action[] memory actions = new Action[](1);
        actions[0] = Action({
            to: _adapter.poolAddress(),
            value: 0,
            data: _adapter.encodeBorrow(asset, amount, interestRateMode, address(dao()))
        });

        IExecutor(address(dao())).execute(_nextCallId("AAVE_BORROW:"), actions, 0);

        emit Borrowed(asset, amount, interestRateMode);
    }

    /// @inheritdoc IAaveLendingPlugin
    /// @dev Three-action batch — DAO calls the pool directly so the approval
    ///      + debt burn resolve against the DAO:
    ///         1. `IERC20(asset).approve(pool, amount)` — exact-amount approval.
    ///         2. `pool.repay(asset, amount, mode, dao)` — adapter-encoded.
    ///         3. `IERC20(asset).approve(pool, 0)` — reset residual.
    ///      AAVE's `repay` caps at outstanding debt: if `amount` exceeds debt,
    ///      `transferFrom` pulls only `min(amount, debt)`, leaving a residual
    ///      DAO->pool allowance. Action 3 resets it to 0 so no orphan approval
    ///      survives the call (caught by `invariant_zeroResidualPoolAllowance`).
    ///      `paid` is the DAO's `asset` balance delta so the event reflects
    ///      what the pool actually pulled (<= amount).
    function repay(
        address asset,
        uint256 amount,
        uint256 interestRateMode
    ) external override auth(TRIGGER_LENDING_PERMISSION_ID) {
        _checkAllowlist(asset);

        IAaveAdapter _adapter = adapter;
        address pool = _adapter.poolAddress();

        Action[] memory actions = new Action[](3);
        actions[0] = Action({
            to: asset,
            value: 0,
            data: abi.encodeCall(IERC20.approve, (pool, amount))
        });
        actions[1] = Action({
            to: pool,
            value: 0,
            data: _adapter.encodeRepay(asset, amount, interestRateMode, address(dao()))
        });
        actions[2] = Action({to: asset, value: 0, data: abi.encodeCall(IERC20.approve, (pool, 0))});

        uint256 before = IERC20(asset).balanceOf(address(dao()));
        IExecutor(address(dao())).execute(_nextCallId("AAVE_REPAY:"), actions, 0);
        uint256 paid = before - IERC20(asset).balanceOf(address(dao()));

        emit Repaid(asset, amount, interestRateMode, paid);
    }

    // --- Vote-gated admin --------------------------------------------------

    /// @inheritdoc IAaveLendingPlugin
    /// @dev Swapping the adapter is how a v3 → v4 migration ships: the old
    ///      adapter remains deployed (positions opened through it are still
    ///      readable on AAVE), and all NEW operations route through the new
    ///      adapter. Withdrawing legacy positions from the old AAVE version
    ///      is a separate operation tracked in `docs/plugins/AAVE.md §6`.
    function setAdapter(
        IAaveAdapter newAdapter
    ) external override auth(UPDATE_ADAPTER_PERMISSION_ID) {
        if (address(newAdapter) == address(0)) revert ZeroAddress();
        IAaveAdapter previous = adapter;
        adapter = newAdapter;
        emit AdapterUpdated(address(previous), address(newAdapter));
    }

    /// @inheritdoc IAaveLendingPlugin
    /// @dev First `allowed=true` flips `allowlistEnforced` permanently.
    ///      Removing an asset (`allowed=false`) does NOT disable enforcement
    ///      — once on, the allowlist stays on for the life of the plugin.
    function setAllowedAsset(
        address asset,
        bool allowed
    ) external override auth(MANAGE_ALLOWLIST_PERMISSION_ID) {
        allowedAsset[asset] = allowed;
        if (allowed && !allowlistEnforced) {
            allowlistEnforced = true;
        }
        emit AllowedAssetSet(asset, allowed);
    }

    // --- Views -------------------------------------------------------------

    /// @inheritdoc IAaveLendingPlugin
    function opNonce() external view override returns (uint256) {
        return _opNonce;
    }

    // --- Internals --------------------------------------------------------

    /// @dev Reverts `AssetNotAllowed` if the allowlist is enforced and `asset`
    ///      is not flagged. No-op when the allowlist is disabled at install
    ///      time and never enabled.
    function _checkAllowlist(address asset) internal view {
        if (allowlistEnforced && !allowedAsset[asset]) {
            revert AssetNotAllowed(asset);
        }
    }

    /// @dev Bumps `_opNonce` and returns `keccak256(tag || nonce)`. Distinct
    ///      operations (back-to-back supplies of the same asset for the same
    ///      amount, say) get distinct callIds — important for the subgraph.
    function _nextCallId(string memory tag) internal returns (bytes32) {
        unchecked {
            _opNonce += 1;
        }
        return keccak256(abi.encodePacked(tag, _opNonce));
    }
}
