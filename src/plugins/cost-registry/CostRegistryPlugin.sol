// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.17;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {PluginUUPSUpgradeable} from "@aragon/osx-commons-contracts/src/plugin/PluginUUPSUpgradeable.sol";
import {IDAO} from "@aragon/osx-commons-contracts/src/dao/IDAO.sol";
import {IExecutor, Action} from "@aragon/osx-commons-contracts/src/executors/IExecutor.sol";

import {ICostRegistryPlugin} from "./ICostRegistryPlugin.sol";

/// @title CostRegistryPlugin
/// @notice Vote-gated registry of the DAO's recurring operating costs that also
///         disburses them: each entry pays a fixed amount of one configured
///         token (USDC) to its payee every `frequencyDays`.
/// @dev    Plugin never custodies funds. Transfers flow DAO → payee via
///         `IExecutor.execute` with a per-entry `allowFailureMap` so one
///         reverting payee never blocks the rest of a batch. Mutations are
///         gated on `MANAGE_COSTS_PERMISSION`; the `processDue` crank is
///         permissionless. No back-pay: a due entry is paid once and its clock
///         is reset to `now`, so missed periods are skipped (anti-stacking).
contract CostRegistryPlugin is PluginUUPSUpgradeable, ICostRegistryPlugin {
    bytes32 public constant MANAGE_COSTS_PERMISSION_ID = keccak256("MANAGE_COSTS_PERMISSION");

    /// @notice Gates `setPaymentToken`. Separate from `MANAGE_COSTS_PERMISSION`
    ///         so a DAO can vote-gate the token-migration path independently of
    ///         day-to-day entry edits.
    bytes32 public constant UPDATE_PAYMENT_TOKEN_PERMISSION_ID =
        keccak256("UPDATE_PAYMENT_TOKEN_PERMISSION");

    /// @inheritdoc ICostRegistryPlugin
    /// @dev Hard upper bound on the settable `MAX_ENTRIES()` cap. Bounds the
    ///      worst-case storage scan a `processDue` page performs even if
    ///      governance raises the limit. `setMaxEntries` can never exceed this
    ///      without a plugin upgrade.
    uint256 public constant override MAX_ENTRIES_CEILING = 1000;

    /// @dev Default `MAX_ENTRIES()` at install — preserves the original v1 cap.
    uint256 private constant DEFAULT_MAX_ENTRIES = 300;

    /// @inheritdoc ICostRegistryPlugin
    /// @dev OSx caps `DAO.execute` at 256 actions and `allowFailureMap` is a
    ///      256-bit bitmap; 100 leaves gas headroom.
    uint256 public constant override MAX_PER_PAGE = 100;

    /// @inheritdoc ICostRegistryPlugin
    /// @dev Defense-in-depth cap on `costUsdc`. The storage type `uint96` already
    ///      bounds writes to ~7.9e28, but that's so far above any realistic
    ///      monthly cost that a typo (extra zeros pasted from a calculator) could
    ///      pre-stage a treasury-drain past governance. 1_000_000_000_000_000 is
    ///      $1B USDC per payment — well above any conceivable real cost and tight
    ///      enough that an unintended extra digit trips the guard.
    uint256 public constant override MAX_COST_USDC = 1_000_000_000_000_000;

    /// @notice The single ERC20 every entry is paid in (USDC). Set at install.
    IERC20 private _token;

    CostEntry[] private _entries;

    /// @dev Governance-settable total slot cap, bounded by `MAX_ENTRIES_CEILING`.
    ///      Exposed via `MAX_ENTRIES()`. Initialized to `DEFAULT_MAX_ENTRIES`.
    uint256 private _maxEntries;

    uint256[47] private __gap;

    /// @notice Initialize the plugin. Called once via the UUPS proxy constructor.
    /// @param _dao   DAO that authorizes this plugin and holds the funds.
    /// @param token  ERC20 used for all payments (USDC).
    function initialize(IDAO _dao, IERC20 token) external initializer {
        __PluginUUPSUpgradeable_init(_dao);
        if (address(token) == address(0)) revert ZeroAddress();
        _token = token;
        _maxEntries = DEFAULT_MAX_ENTRIES;
    }

    /// @notice Upgrade migration for instances installed before `MAX_ENTRIES`
    ///         became a storage value (it used to be a `constant`, so the new
    ///         `_maxEntries` slot reads as 0 after such an upgrade — which would
    ///         make `registerEntry` revert `EntryLimitExceeded(0)`). Seeds the
    ///         default cap once. Run it atomically with the upgrade
    ///         (`upgradeToAndCall(newImpl, abi.encodeCall(this.initializeV2, ()))`);
    ///         it is also permissionless and idempotent (only writes when zero)
    ///         so a forgotten call can still be repaired afterward. Fresh
    ///         installs set the cap in `initialize` and never need this.
    function initializeV2() external reinitializer(2) {
        if (_maxEntries == 0) {
            _maxEntries = DEFAULT_MAX_ENTRIES;
        }
    }

    // --- Vote-gated management --------------------------------------------

    /// @inheritdoc ICostRegistryPlugin
    function registerEntry(
        string calldata name,
        string calldata description,
        uint256 costUsdc,
        uint32 frequencyDays,
        address payee
    ) external override auth(MANAGE_COSTS_PERMISSION_ID) returns (uint256 id) {
        _validate(name, costUsdc, frequencyDays, payee);
        if (_entries.length >= _maxEntries) revert EntryLimitExceeded(_maxEntries);

        _entries.push(
            CostEntry({
                payee: payee,
                costUsdc: uint96(costUsdc),
                frequencyDays: frequencyDays,
                lastPaidAt: uint64(block.timestamp),
                active: true,
                name: name,
                description: description
            })
        );
        id = _entries.length - 1;

        emit EntryRegistered(id, payee, costUsdc, frequencyDays, name);
    }

    /// @inheritdoc ICostRegistryPlugin
    function updateEntry(
        uint256 id,
        string calldata name,
        string calldata description,
        uint256 costUsdc,
        uint32 frequencyDays,
        address payee
    ) external override auth(MANAGE_COSTS_PERMISSION_ID) {
        CostEntry storage e = _activeEntry(id);
        _validate(name, costUsdc, frequencyDays, payee);

        e.payee = payee;
        e.costUsdc = uint96(costUsdc);
        e.frequencyDays = frequencyDays;
        e.name = name;
        e.description = description;
        // lastPaidAt intentionally preserved — updating fields must not reset
        // the payment clock (or let governance grief the schedule).

        emit EntryUpdated(id, payee, costUsdc, frequencyDays);
    }

    /// @inheritdoc ICostRegistryPlugin
    /// @dev Soft delete — the slot is kept so prior `CostPaid` history keeps a
    ///      stable foreign key.
    function removeEntry(uint256 id) external override auth(MANAGE_COSTS_PERMISSION_ID) {
        CostEntry storage e = _activeEntry(id);
        e.active = false;
        emit EntryRemoved(id);
    }

    /// @inheritdoc ICostRegistryPlugin
    /// @dev Vote-gated. Replaces the registry's single payment token. Existing
    ///      entries' `costUsdc` values are reused as raw token units — see the
    ///      docs warning about decimals mismatches when migrating to a token
    ///      with a different scale.
    function setPaymentToken(
        address newToken
    ) external override auth(UPDATE_PAYMENT_TOKEN_PERMISSION_ID) {
        if (newToken == address(0)) revert ZeroAddress();
        address previous = address(_token);
        _token = IERC20(newToken);
        emit PaymentTokenUpdated(previous, newToken);
    }

    /// @inheritdoc ICostRegistryPlugin
    /// @dev Raise (or lower) the entry-slot cap. Bounded by `MAX_ENTRIES_CEILING`
    ///      above and by the current slot count below (can't shrink past slots
    ///      that already exist). Gated by `MANAGE_COSTS` — same governance class
    ///      as entry management.
    function setMaxEntries(uint256 newMax) external override auth(MANAGE_COSTS_PERMISSION_ID) {
        if (newMax < _entries.length || newMax > MAX_ENTRIES_CEILING) {
            revert MaxEntriesOutOfRange(newMax, _entries.length, MAX_ENTRIES_CEILING);
        }
        uint256 previous = _maxEntries;
        _maxEntries = newMax;
        emit MaxEntriesUpdated(previous, newMax);
    }

    // --- Permissionless crank ---------------------------------------------

    /// @inheritdoc ICostRegistryPlugin
    /// @dev Effects (each paid entry's `lastPaidAt`) are written BEFORE the
    ///      external `execute`, so a payee that reenters cannot trigger a second
    ///      payment for the same entry in the same call.
    function processDue(uint256 offset, uint256 limit) external override {
        _processDue(offset, limit);
    }

    /// @inheritdoc ICostRegistryPlugin
    /// @dev Convenience crank for keepers that don't want to track an offset.
    ///      Pays the first `MAX_PER_PAGE` due entries from index 0 — i.e.
    ///      genuinely "all due" for any registry with `entryCount() <=
    ///      MAX_PER_PAGE`. Larger registries still need paginated `processDue`
    ///      calls to reach entries past the first page.
    function processAllDue() external override {
        _processDue(0, MAX_PER_PAGE);
    }

    function _processDue(uint256 offset, uint256 limit) private {
        if (limit == 0) revert PageSizeZero();
        if (limit > MAX_PER_PAGE) limit = MAX_PER_PAGE;

        uint256 len = _entries.length;
        if (offset >= len) return;
        uint256 end = offset + limit;
        if (end > len) end = len;

        uint256 nowTs = block.timestamp;
        IERC20 token = _token;

        Action[] memory buffer = new Action[](end - offset);
        uint256[] memory paidIds = new uint256[](end - offset);
        uint256 count;

        for (uint256 i = offset; i < end; ++i) {
            CostEntry storage e = _entries[i];
            if (!e.active) continue;
            if (nowTs < uint256(e.lastPaidAt) + uint256(e.frequencyDays) * 1 days) continue;

            // EFFECT first: reset the clock to now. Missed periods are skipped
            // (no back-pay), and a reentrant crank sees this entry as not-due.
            e.lastPaidAt = uint64(nowTs);
            buffer[count] = Action({
                to: address(token),
                value: 0,
                data: abi.encodeCall(IERC20.transfer, (e.payee, uint256(e.costUsdc)))
            });
            paidIds[count] = i;
            ++count;
        }

        if (count == 0) return;

        Action[] memory actions = new Action[](count);
        for (uint256 k; k < count; ++k) {
            actions[k] = buffer[k];
        }

        // Every bit set so any single transfer can fail without aborting the
        // batch. `count <= MAX_PER_PAGE = 100`, so the shift is safe.
        uint256 allowFailureMap = (uint256(1) << count) - 1;

        (, uint256 failureMap) = IExecutor(address(dao())).execute(
            keccak256(abi.encodePacked("COSTS:", offset, ":", nowTs)),
            actions,
            allowFailureMap
        );

        for (uint256 k; k < count; ++k) {
            CostEntry storage e = _entries[paidIds[k]];
            emit CostPaid(paidIds[k], e.payee, uint256(e.costUsdc), uint64(nowTs));
        }
        emit CostsProcessed(offset, count, failureMap);
    }

    // --- Views ------------------------------------------------------------

    /// @inheritdoc ICostRegistryPlugin
    function paymentToken() external view override returns (address) {
        return address(_token);
    }

    /// @inheritdoc ICostRegistryPlugin
    function entryCount() external view override returns (uint256) {
        return _entries.length;
    }

    /// @inheritdoc ICostRegistryPlugin
    function MAX_ENTRIES() external view override returns (uint256) {
        return _maxEntries;
    }

    /// @inheritdoc ICostRegistryPlugin
    function getEntry(uint256 id) external view override returns (CostEntry memory) {
        if (id >= _entries.length) revert EntryNotFound(id);
        return _entries[id];
    }

    /// @inheritdoc ICostRegistryPlugin
    function getEntries(
        uint256 offset,
        uint256 limit
    ) external view override returns (CostEntry[] memory page, uint256 total) {
        total = _entries.length;
        if (limit > MAX_PER_PAGE) limit = MAX_PER_PAGE;
        if (offset >= total) {
            return (new CostEntry[](0), total);
        }
        uint256 end = offset + limit;
        if (end > total) end = total;
        uint256 n = end - offset;
        page = new CostEntry[](n);
        for (uint256 i; i < n; ++i) {
            page[i] = _entries[offset + i];
        }
    }

    /// @inheritdoc ICostRegistryPlugin
    function isDue(uint256 id) external view override returns (bool) {
        if (id >= _entries.length) revert EntryNotFound(id);
        CostEntry storage e = _entries[id];
        if (!e.active) return false;
        return block.timestamp >= uint256(e.lastPaidAt) + uint256(e.frequencyDays) * 1 days;
    }

    /// @inheritdoc ICostRegistryPlugin
    function nextPaymentAt(uint256 id) external view override returns (uint256) {
        if (id >= _entries.length) revert EntryNotFound(id);
        CostEntry storage e = _entries[id];
        return uint256(e.lastPaidAt) + uint256(e.frequencyDays) * 1 days;
    }

    // --- Internals --------------------------------------------------------

    function _validate(
        string calldata name,
        uint256 costUsdc,
        uint32 frequencyDays,
        address payee
    ) private pure {
        if (payee == address(0)) revert ZeroAddress();
        if (costUsdc == 0) revert ZeroAmount();
        if (costUsdc > MAX_COST_USDC) revert CostTooLarge(costUsdc);
        if (frequencyDays == 0) revert ZeroFrequency();
        if (bytes(name).length == 0) revert EmptyName();
    }

    /// @dev Returns a storage pointer to an existing, active entry or reverts.
    function _activeEntry(uint256 id) private view returns (CostEntry storage e) {
        if (id >= _entries.length) revert EntryNotFound(id);
        e = _entries[id];
        if (!e.active) revert EntryNotFound(id);
    }
}
