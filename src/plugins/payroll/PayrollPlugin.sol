// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.17;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {PluginUUPSUpgradeable} from "@aragon/osx-commons-contracts/src/plugin/PluginUUPSUpgradeable.sol";
import {IDAO} from "@aragon/osx-commons-contracts/src/dao/IDAO.sol";
import {IExecutor, Action} from "@aragon/osx-commons-contracts/src/executors/IExecutor.sol";

import {IPayrollPlugin} from "./IPayrollPlugin.sol";
import {BokkyPooBahsDateTimeLibrary as DT} from "./lib/BokkyPooBahsDateTimeLibrary.sol";
import {SafeTransferHelper} from "../../common/SafeTransferHelper.sol";

/// @title PayrollPlugin
/// @notice Fixed-list monthly payroll on Aragon OSx.
///         Recipient management is vote-gated; the monthly `executePayroll`
///         crank is permissionless. Missed months are skipped — no back-pay.
/// @dev    Plugin never custodies funds. Salary transfers flow DAO → payee via
///         `IExecutor.execute` and are MANDATORY: their failure-map bits are
///         cleared, so any failing transfer reverts the whole batch and rolls
///         back the period state (H-01). Only an optional trailing keeper-bounty
///         action is failable. ERC20 legs route through `SafeTransferHelper` so a
///         false-returning token can't be booked as paid (M-04).
contract PayrollPlugin is PluginUUPSUpgradeable, IPayrollPlugin {
    bytes32 public constant MANAGE_PAYROLL_PERMISSION_ID = keccak256("MANAGE_PAYROLL_PERMISSION");

    /// @notice Gates `setKeeperBounty`. Separate from `MANAGE_PAYROLL` so the
    ///         bounty budget can be tuned by a different governance class
    ///         (e.g. a treasury sub-committee) than recipient management.
    bytes32 public constant UPDATE_BOUNTY_PERMISSION_ID = keccak256("UPDATE_BOUNTY_PERMISSION");

    /// @inheritdoc IPayrollPlugin
    /// @dev Hard upper bound on the settable `MAX_RECIPIENTS()` cap. Bounds the
    ///      worst-case storage scan a paginated crank performs even if
    ///      governance raises the limit (TRD §11). `setMaxRecipients` can never
    ///      exceed this without a plugin upgrade.
    uint256 public constant override MAX_RECIPIENTS_CEILING = 1000;

    /// @dev Default `MAX_RECIPIENTS()` at install — preserves the original v1
    ///      cap of 300 for fresh deployments.
    uint256 private constant DEFAULT_MAX_RECIPIENTS = 300;

    /// @inheritdoc IPayrollPlugin
    /// @dev OSx DAO.execute caps at 256 actions and `allowFailureMap` is a
    ///      256-bit bitmap; 100 leaves gas headroom. A payroll larger than this
    ///      is paid across multiple `executePayrollPage` calls.
    uint256 public constant override MAX_RECIPIENTS_PER_PAGE = 100;

    Recipient[] private _recipients;
    /// @dev 1-based index into `_recipients`; 0 = absent. Lets us treat 0 as a
    ///      sentinel without losing slot 0.
    mapping(address => uint256) public indexOfPayee;

    uint8 public override payDayOfMonth;
    uint256 public override lastPayoutPeriod;

    /// @dev Period the pagination cursor belongs to. Distinguishes "resume the
    ///      in-progress period" from "start a fresh period" (cursor resets when
    ///      `_cursorPeriod != currentPeriod`).
    uint256 private _cursorPeriod;
    /// @dev Next `_recipients` index a paginated crank resumes from for
    ///      `_cursorPeriod`. 0 = start from the top.
    uint256 private _payoutCursor;

    /// @notice Keeper bounty config — set by governance via `setKeeperBounty`.
    ///         All zero (default) = bounty disabled; the crank stays free for
    ///         keepers but receives nothing in return.
    address public override bountyToken;
    uint256 public override bountyPerCrank;
    uint256 public override bountyMaxPerPeriod;
    /// @dev Total bounty paid in `_bountyAccumPeriod`. Reset to 0 when the
    ///      first crank of a new period runs.
    uint256 private _bountyPaidThisPeriod;
    uint256 private _bountyAccumPeriod;

    /// @dev Governance-settable total slot cap (active + soft-deleted), bounded
    ///      by `MAX_RECIPIENTS_CEILING`. Exposed via the `MAX_RECIPIENTS()`
    ///      getter. Initialized to `DEFAULT_MAX_RECIPIENTS`.
    uint256 private _maxRecipients;

    /// @dev SafeERC20 shim every ERC20 payout is routed through so a
    ///      false-returning token can never be recorded as paid (M-04).
    ///      Deployed once per instance in `initialize` / `initializeV3`.
    address private _transferHelper;

    /// @notice True once `executeForcePayPeriod` has settled `period`, blocking a
    ///         second force-pay of the same skipped month (M-02).
    mapping(uint256 => bool) public override forcePaidPeriod;

    uint256[37] private __gap;

    /// @inheritdoc IPayrollPlugin
    /// @dev How many months back `previewForcePayPeriodActions` may reach.
    ///      Bounds the recovery window so a long-dormant payroll can't be
    ///      back-paid arbitrarily far.
    uint256 public constant override MAX_FORCE_BACK_MONTHS = 12;

    /// @notice Initialize the plugin. Called once via the UUPS proxy constructor.
    function initialize(IDAO _dao, uint8 _payDayOfMonth) external initializer {
        __PluginUUPSUpgradeable_init(_dao);
        if (_payDayOfMonth == 0 || _payDayOfMonth > 28) {
            revert InvalidPayDayOfMonth(_payDayOfMonth);
        }
        payDayOfMonth = _payDayOfMonth;
        _maxRecipients = DEFAULT_MAX_RECIPIENTS;
        _transferHelper = address(new SafeTransferHelper());
    }

    /// @notice Upgrade migration for instances installed before `MAX_RECIPIENTS`
    ///         became a storage value (it used to be a `constant`, so the new
    ///         `_maxRecipients` slot reads as 0 after such an upgrade — which
    ///         would make `addRecipient` revert `RecipientLimitExceeded(0)`).
    ///         Seeds the default cap once. Run it atomically with the upgrade
    ///         (`upgradeToAndCall(newImpl, abi.encodeCall(this.initializeV2, ()))`);
    ///         it is also permissionless and idempotent (only writes when zero)
    ///         so a forgotten call can still be repaired afterward. Fresh
    ///         installs set the cap in `initialize` and never need this.
    function initializeV2() external reinitializer(2) {
        if (_maxRecipients == 0) {
            _maxRecipients = DEFAULT_MAX_RECIPIENTS;
        }
    }

    /// @notice Upgrade migration for instances installed before the SafeERC20
    ///         `_transferHelper` slot existed (M-04). Deploys the per-instance
    ///         helper once if unset. Permissionless but idempotent (writes only
    ///         when zero, seeds a freshly-deployed stateless helper), same
    ///         rationale as `initializeV2`. Run atomically with the upgrade:
    ///         `upgradeToAndCall(newImpl, abi.encodeCall(this.initializeV3, ()))`.
    ///         Fresh installs set the helper in `initialize` and never need this.
    function initializeV3() external reinitializer(3) {
        if (_transferHelper == address(0)) {
            _transferHelper = address(new SafeTransferHelper());
        }
    }

    // --- Vote-gated management --------------------------------------------

    /// @inheritdoc IPayrollPlugin
    function addRecipient(
        address payee,
        address token,
        uint256 amount,
        string calldata description
    ) external override auth(MANAGE_PAYROLL_PERMISSION_ID) {
        _requireNotMidPagination();
        if (payee == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (indexOfPayee[payee] != 0) revert RecipientAlreadyExists(payee);
        if (_recipients.length >= _maxRecipients) {
            revert RecipientLimitExceeded(_maxRecipients);
        }

        _recipients.push(
            Recipient({
                payee: payee,
                token: token,
                amount: amount,
                active: true,
                description: description
            })
        );
        indexOfPayee[payee] = _recipients.length; // 1-based

        emit RecipientAdded(payee, token, amount, description);
    }

    /// @inheritdoc IPayrollPlugin
    function setRecipientDescription(
        address payee,
        string calldata description
    ) external override auth(MANAGE_PAYROLL_PERMISSION_ID) {
        uint256 idx = indexOfPayee[payee];
        if (idx == 0) revert RecipientNotFound(payee);

        Recipient storage r = _recipients[idx - 1];
        string memory oldDescription = r.description;
        r.description = description;

        emit RecipientDescriptionSet(payee, oldDescription, description);
    }

    /// @inheritdoc IPayrollPlugin
    /// @dev Soft delete — slot is marked inactive but kept so prior payout
    ///      history (events / subgraph) keeps a stable foreign key.
    function removeRecipient(address payee) external override auth(MANAGE_PAYROLL_PERMISSION_ID) {
        _requireNotMidPagination();
        uint256 idx = indexOfPayee[payee];
        if (idx == 0) revert RecipientNotFound(payee);

        Recipient storage r = _recipients[idx - 1];
        if (!r.active) revert RecipientNotFound(payee); // already soft-deleted
        r.active = false;

        emit RecipientRemoved(payee);
    }

    /// @inheritdoc IPayrollPlugin
    /// @dev L-02: bring a soft-deleted payee back into payroll. `removeRecipient`
    ///      leaves `indexOfPayee[payee]` populated so history keeps a stable key,
    ///      which made `addRecipient` reject the payee forever. Reactivation
    ///      reuses the original slot, overwriting token / amount / description and
    ///      flipping `active` back on. Reverts if the payee was never added or is
    ///      currently active (use `setAmount` / `setRecipientDescription` for
    ///      live recipients). Frozen mid-pagination like the other mutators (M-03).
    function reactivateRecipient(
        address payee,
        address token,
        uint256 amount,
        string calldata description
    ) external override auth(MANAGE_PAYROLL_PERMISSION_ID) {
        _requireNotMidPagination();
        if (amount == 0) revert ZeroAmount();
        uint256 idx = indexOfPayee[payee];
        if (idx == 0) revert RecipientNotFound(payee);

        Recipient storage r = _recipients[idx - 1];
        if (r.active) revert RecipientAlreadyExists(payee);
        r.token = token;
        r.amount = amount;
        r.description = description;
        r.active = true;

        emit RecipientAdded(payee, token, amount, description);
    }

    /// @inheritdoc IPayrollPlugin
    function setAmount(
        address payee,
        uint256 newAmount
    ) external override auth(MANAGE_PAYROLL_PERMISSION_ID) {
        _requireNotMidPagination();
        if (newAmount == 0) revert ZeroAmount();
        uint256 idx = indexOfPayee[payee];
        if (idx == 0) revert RecipientNotFound(payee);

        Recipient storage r = _recipients[idx - 1];
        if (!r.active) revert RecipientNotFound(payee);

        uint256 oldAmount = r.amount;
        r.amount = newAmount;
        emit RecipientAmountUpdated(payee, oldAmount, newAmount);
    }

    /// @inheritdoc IPayrollPlugin
    function setPayDayOfMonth(uint8 day) external override auth(MANAGE_PAYROLL_PERMISSION_ID) {
        if (day == 0 || day > 28) revert InvalidPayDayOfMonth(day);
        uint8 previous = payDayOfMonth;
        payDayOfMonth = day;
        emit PayDayUpdated(previous, day);
    }

    /// @inheritdoc IPayrollPlugin
    /// @dev Raise (or lower) the recipient-slot cap. Bounded by
    ///      `MAX_RECIPIENTS_CEILING` above and by the current slot count below
    ///      (you can't shrink the cap past slots that already exist). Gated by
    ///      `MANAGE_PAYROLL` — same governance class as recipient management.
    function setMaxRecipients(uint256 newMax) external override auth(MANAGE_PAYROLL_PERMISSION_ID) {
        if (newMax < _recipients.length || newMax > MAX_RECIPIENTS_CEILING) {
            revert MaxRecipientsOutOfRange(newMax, _recipients.length, MAX_RECIPIENTS_CEILING);
        }
        uint256 previous = _maxRecipients;
        _maxRecipients = newMax;
        emit MaxRecipientsUpdated(previous, newMax);
    }

    /// @inheritdoc IPayrollPlugin
    /// @dev Set the keeper bounty paid out of the DAO treasury to `msg.sender`
    ///      on each successful crank. `perCrank == 0` disables (default).
    ///      `maxPerPeriod` rolls per period so paginated cranks within the
    ///      same month share one cap.
    function setKeeperBounty(
        address token,
        uint256 perCrank,
        uint256 maxPerPeriod
    ) external override auth(UPDATE_BOUNTY_PERMISSION_ID) {
        // L-04: reject configs that can never pay (or can only pay a fraction of
        // `perCrank`) so a misconfigured bounty can't masquerade as enabled.
        // `perCrank == 0` is the canonical "disabled" setting and skips the
        // checks. When enabled, the per-period cap must be able to fund at least
        // one full crank.
        if (perCrank != 0 && maxPerPeriod < perCrank) {
            revert InvalidBountyConfig(perCrank, maxPerPeriod);
        }
        bountyToken = token;
        bountyPerCrank = perCrank;
        bountyMaxPerPeriod = maxPerPeriod;
        emit KeeperBountyConfigured(token, perCrank, maxPerPeriod);
    }

    /// @inheritdoc IPayrollPlugin
    /// @dev Governance-safe recovery for a month the permissionless crank
    ///      skipped. Returns the DAO→payee transfer batch that pays every
    ///      currently-active recipient once — TokenVoting carries these actions
    ///      and runs them via `dao.execute` at the TOP level (no nested
    ///      `dao.execute`, unlike a wrapper that calls `execute` itself), the
    ///      same pattern the AAVE / Uniswap fund-moving ops use.
    ///
    ///      `period` (`year*12+month`) must be STRICTLY between
    ///      `lastPayoutPeriod` and the current period — unambiguously skipped
    ///      (the crank jumps from `lastPayoutPeriod` straight to "now") — and no
    ///      more than `MAX_FORCE_BACK_MONTHS` back. The guards bind at
    ///      build/simulation time; double-pay prevention is a governance review
    ///      concern (consistent with the other preview-built fund ops), aided by
    ///      the frontend's proposal-execution simulation. Single batch — a
    ///      payroll exceeding one page must be settled by the regular crank.
    function previewForcePayPeriodActions(
        uint256 period
    ) external view override returns (Action[] memory) {
        return _buildForcePayActions(period);
    }

    /// @inheritdoc IPayrollPlugin
    /// @dev M-02: stateful, executable counterpart to
    ///      `previewForcePayPeriodActions`. Marks `period` as force-paid
    ///      atomically with the transfer batch so the same skipped month can
    ///      never be force-paid twice. Gated by `MANAGE_PAYROLL` (this moves
    ///      treasury funds outside the normal crank, so it is governance-only,
    ///      not permissionless). The batch runs with `allowFailureMap = 0` — any
    ///      failed transfer reverts everything, including the `forcePaidPeriod`
    ///      write, so a failed recovery can be retried (H-01-style guarantee).
    function executeForcePayPeriod(
        uint256 period
    ) external override auth(MANAGE_PAYROLL_PERMISSION_ID) {
        Action[] memory actions = _buildForcePayActions(period);

        // EFFECT before INTERACTION: lock the period now so a reentrant call
        // during a transfer can't force-pay it a second time. Rolled back with
        // the rest of the tx if the mandatory batch reverts.
        forcePaidPeriod[period] = true;

        IExecutor(address(dao())).execute(
            keccak256(abi.encodePacked("PAYROLL_FORCE:", period)),
            actions,
            0
        );

        emit ForcePeriodPaid(period);
    }

    /// @dev Shared builder for the force-pay batch. Validates the target period
    ///      window and that it has not already been force-paid (M-02), then
    ///      returns the DAO→payee transfer batch for every active recipient,
    ///      ERC20 legs routed through the SafeERC20 helper (M-04).
    function _buildForcePayActions(uint256 period) private view returns (Action[] memory) {
        (uint256 year, uint256 month, ) = DT.timestampToDate(block.timestamp);
        uint256 currentPeriod = year * 12 + month;

        if (period >= currentPeriod) revert ForcePeriodNotPast(period, currentPeriod);
        if (period <= lastPayoutPeriod) revert ForcePeriodAlreadySettled(period);
        if (currentPeriod - period > MAX_FORCE_BACK_MONTHS) revert ForcePeriodTooOld(period);
        if (forcePaidPeriod[period]) revert ForcePeriodAlreadySettled(period);

        address helper = _transferHelper;
        uint256 len = _recipients.length;
        // Worst case 2 actions per recipient (ERC20 approve + safeTransfer).
        Action[] memory buffer = new Action[](2 * len);
        uint256 count;
        uint256 a;
        for (uint256 i; i < len; ++i) {
            Recipient memory r = _recipients[i];
            if (!r.active) continue;
            if (count >= MAX_RECIPIENTS_PER_PAGE) {
                revert PayrollExceedsSinglePage(MAX_RECIPIENTS_PER_PAGE);
            }
            a = _appendTransfer(buffer, a, helper, r.token, r.payee, r.amount);
            ++count;
        }
        if (count == 0) revert NoActiveRecipients();

        Action[] memory actions = new Action[](a);
        for (uint256 k; k < a; ++k) {
            actions[k] = buffer[k];
        }
        return actions;
    }

    // --- Permissionless monthly crank -------------------------------------

    /// @inheritdoc IPayrollPlugin
    /// @dev Single-batch crank: pays every remaining active recipient for the
    ///      current period in one `DAO.execute`. Reverts
    ///      `PayrollExceedsSinglePage` when that set won't fit one page — large
    ///      payrolls must use `executePayrollPage`. For payrolls of
    ///      `<= MAX_RECIPIENTS_PER_PAGE` this is identical to v1.
    function executePayroll() external override {
        _runPayroll(MAX_RECIPIENTS_PER_PAGE, true);
    }

    /// @inheritdoc IPayrollPlugin
    /// @dev Paginated crank. `maxCount == 0` reverts; values above
    ///      `MAX_RECIPIENTS_PER_PAGE` are clamped down. Repeated calls walk the
    ///      `_recipients` array via `_payoutCursor` until the period completes.
    function executePayrollPage(uint256 maxCount) external override {
        if (maxCount == 0) revert PageSizeZero();
        if (maxCount > MAX_RECIPIENTS_PER_PAGE) maxCount = MAX_RECIPIENTS_PER_PAGE;
        _runPayroll(maxCount, false);
    }

    /// @dev Shared crank body. Pays up to `maxCount` active recipients starting
    ///      from the period cursor.
    ///      - `requireSinglePass`: if true (the `executePayroll` entrypoint) and
    ///        the page does not reach the end of the recipient set, revert
    ///        `PayrollExceedsSinglePage` instead of half-paying the period.
    ///      Effects (cursor / `lastPayoutPeriod`) are written BEFORE the external
    ///      `execute`, so a recipient that reenters cannot re-pay the same page.
    function _runPayroll(uint256 maxCount, bool requireSinglePass) private {
        (uint256 currentPeriod, uint256 day) = _currentPeriodAndDay();

        if (currentPeriod <= lastPayoutPeriod) {
            revert AlreadyPaidThisPeriod(currentPeriod);
        }
        if (day < payDayOfMonth) {
            revert NotYetDueThisMonth(uint8(day), payDayOfMonth);
        }

        // Resume mid-period, or start fresh if the cursor belongs to an older
        // period (or has never been set).
        uint256 start = (_cursorPeriod == currentPeriod) ? _payoutCursor : 0;
        uint256 len = _recipients.length;

        // Collect up to `maxCount` active recipients from `start`, building the
        // salary batch. ERC20 legs route through the SafeERC20 helper (M-04):
        // one `approve(helper, amount)` + one `helper.safeTransfer(...)` each;
        // native-ETH legs stay a single value transfer. `i` ends at the slot to
        // resume from next page (or `len` if we reached the end).
        Action[] memory buffer = new Action[](2 * maxCount + 2); // +2 for the bounty leg
        uint256 count; // active recipients collected this page
        uint256 a; // actions built so far
        uint256 i = start;
        for (; i < len && count < maxCount; ++i) {
            Recipient memory r = _recipients[i];
            if (!r.active) continue;
            a = _appendTransfer(buffer, a, _transferHelper, r.token, r.payee, r.amount);
            ++count;
        }
        bool reachedEnd = (i == len);

        if (count == 0) {
            // Nothing to pay from `start`. If we never advanced, the payroll is
            // empty; otherwise the tail is all soft-deleted and the period is
            // already fully paid by earlier pages — complete it.
            if (start == 0) revert NoActiveRecipients();
            _cursorPeriod = currentPeriod;
            _payoutCursor = 0;
            lastPayoutPeriod = currentPeriod;
            emit PayrollPeriodCompleted(currentPeriod);
            return;
        }

        // L-03: the page filled before reaching the array end. If the remaining
        // tail holds no further active recipient, the period IS complete — only
        // a real active recipient left unpaid should make `executePayroll`
        // revert or keep the period open.
        if (!reachedEnd && !_hasActiveFrom(i, len)) {
            reachedEnd = true;
        }
        if (requireSinglePass && !reachedEnd) {
            revert PayrollExceedsSinglePage(maxCount);
        }

        // Hand off to a separate frame to settle the page (bounty append,
        // failure map, effects, execute, events) — keeps this function under
        // the stack-slot limit without `via-ir`.
        _settlePage(buffer, a, count, currentPeriod, start, i, reachedEnd);
    }

    /// @dev Finalize one collected page: append the optional keeper-bounty leg,
    ///      build the failable-only-on-bounty allow-failure map, write the
    ///      cursor / period effects, run the DAO batch, and emit. `salaryActions`
    ///      is the number of (mandatory) salary action slots already in `buffer`.
    function _settlePage(
        Action[] memory buffer,
        uint256 salaryActions,
        uint256 count,
        uint256 currentPeriod,
        uint256 start,
        uint256 nextIndex,
        bool reachedEnd
    ) private {
        // L-01: award the bounty only on a full page or the period's final page,
        // so a keeper can't farm the per-period cap by cranking tiny pages.
        uint256 bountyAmount = (reachedEnd || count == MAX_RECIPIENTS_PER_PAGE)
            ? _calcBountyAmount(currentPeriod)
            : 0;

        uint256 a = salaryActions;
        if (bountyAmount > 0) {
            a = _appendTransfer(buffer, a, _transferHelper, bountyToken, msg.sender, bountyAmount);
        }

        // allowFailureMap: salary bits stay CLEARED (mandatory — H-01/H-02); only
        // the trailing bounty bits are failable, so a keeper that can't be paid
        // never blocks salaries and a failed salary never advances state.
        uint256 bountyBits = a > salaryActions
            ? (((uint256(1) << (a - salaryActions)) - 1) << salaryActions)
            : 0;

        Action[] memory actions = new Action[](a);
        for (uint256 k; k < a; ++k) {
            actions[k] = buffer[k];
        }

        // EFFECTS before INTERACTIONS: advance the cursor / lock the period now
        // so a reentrant crank cannot re-pay this page. Rolled back with the tx
        // if the mandatory salary batch reverts.
        _cursorPeriod = currentPeriod;
        if (reachedEnd) {
            _payoutCursor = 0;
            lastPayoutPeriod = currentPeriod;
        } else {
            _payoutCursor = nextIndex;
        }
        // Reserve the bounty against the per-period cap BEFORE the external call
        // so a keeper can't retry to drain past the cap by spamming pages.
        if (bountyAmount > 0) {
            if (_bountyAccumPeriod != currentPeriod) {
                _bountyAccumPeriod = currentPeriod;
                _bountyPaidThisPeriod = 0;
            }
            _bountyPaidThisPeriod += bountyAmount;
        }

        (, uint256 failureMap) = IExecutor(address(dao())).execute(
            keccak256(abi.encodePacked("PAYROLL:", currentPeriod, ":", start)),
            actions,
            bountyBits
        );

        emit PayrollExecuted(currentPeriod, count, failureMap);
        // H-02 / L-04: only claim the bounty was paid when none of its action
        // bits failed in the batch — never emit a paid event for a no-op.
        if (bountyAmount > 0 && (failureMap & bountyBits) == 0) {
            emit KeeperBountyPaid(msg.sender, bountyToken, bountyAmount, currentPeriod);
        }
        if (reachedEnd) emit PayrollPeriodCompleted(currentPeriod);
    }

    /// @dev `(year*12+month, day)` for `block.timestamp`. Folded into one call so
    ///      `_runPayroll` doesn't carry `year`/`month` as separate stack slots.
    function _currentPeriodAndDay() private view returns (uint256 period, uint256 day) {
        uint256 year;
        uint256 month;
        (year, month, day) = DT.timestampToDate(block.timestamp);
        period = year * 12 + month;
    }

    /// @dev Append a DAO→`to` transfer of `amount` of `token` to `buf` at index
    ///      `a`, returning the next free index. Native ETH (`token == 0`) is a
    ///      single value transfer; an ERC20 becomes a SafeERC20-routed pair —
    ///      `token.approve(helper, amount)` then `helper.safeTransfer(...)` —
    ///      so a false-returning token reverts instead of silently no-op'ing
    ///      (M-04 / M-06). The exact-amount approve nets back to zero once the
    ///      helper pulls it, leaving no residual allowance.
    function _appendTransfer(
        Action[] memory buf,
        uint256 a,
        address helper,
        address token,
        address to,
        uint256 amount
    ) private pure returns (uint256) {
        if (token == address(0)) {
            buf[a++] = Action({to: to, value: amount, data: ""});
        } else {
            buf[a++] = Action({
                to: token,
                value: 0,
                data: abi.encodeCall(IERC20.approve, (helper, amount))
            });
            buf[a++] = Action({
                to: helper,
                value: 0,
                data: abi.encodeCall(SafeTransferHelper.safeTransfer, (IERC20(token), to, amount))
            });
        }
        return a;
    }

    /// @dev True if any slot in `[from, to)` is an active recipient. Used by the
    ///      single-pass crank (L-03) to tell "page full, real work remains" from
    ///      "page full, only soft-deleted tail left" (the latter completes).
    function _hasActiveFrom(uint256 from, uint256 to) private view returns (bool) {
        for (uint256 j = from; j < to; ++j) {
            if (_recipients[j].active) return true;
        }
        return false;
    }

    /// @dev M-03: block recipient-set / amount mutations while a paginated period
    ///      is mid-flight, so a single period can't be paid against a recipient
    ///      set that changed between pages. Mid-pagination means a cursor is
    ///      parked inside the CURRENT period (`_payoutCursor != 0` and
    ///      `_cursorPeriod == currentPeriod`). Once the period completes the
    ///      cursor resets to 0 and mutations are free again.
    function _requireNotMidPagination() private view {
        if (_payoutCursor == 0) return;
        (uint256 year, uint256 month, ) = DT.timestampToDate(block.timestamp);
        if (_cursorPeriod == year * 12 + month) revert PayrollMidPagination();
    }

    /// @dev Returns the bounty amount to pay this crank, after applying the
    ///      per-period rolling cap. Returns 0 when the bounty is disabled or
    ///      the cap is exhausted.
    function _calcBountyAmount(uint256 currentPeriod) private view returns (uint256) {
        uint256 perCrank = bountyPerCrank;
        if (perCrank == 0) return 0;
        uint256 cap = bountyMaxPerPeriod;
        if (cap == 0) return 0;
        // New period: full cap is available again.
        uint256 used = (_bountyAccumPeriod == currentPeriod) ? _bountyPaidThisPeriod : 0;
        if (used >= cap) return 0;
        uint256 remaining = cap - used;
        return perCrank <= remaining ? perCrank : remaining;
    }

    // --- Views ------------------------------------------------------------

    /// @inheritdoc IPayrollPlugin
    function transferHelper() external view override returns (address) {
        return _transferHelper;
    }

    /// @inheritdoc IPayrollPlugin
    function cursorPeriod() external view override returns (uint256) {
        return _cursorPeriod;
    }

    /// @inheritdoc IPayrollPlugin
    function payoutCursor() external view override returns (uint256) {
        return _payoutCursor;
    }

    /// @inheritdoc IPayrollPlugin
    function recipientCount() external view override returns (uint256) {
        return _recipients.length;
    }

    /// @inheritdoc IPayrollPlugin
    function MAX_RECIPIENTS() external view override returns (uint256) {
        return _maxRecipients;
    }

    /// @inheritdoc IPayrollPlugin
    function getRecipientAt(uint256 index) external view override returns (Recipient memory) {
        return _recipients[index];
    }

    /// @inheritdoc IPayrollPlugin
    function allActiveRecipients() external view override returns (Recipient[] memory) {
        uint256 active = _countActive();
        Recipient[] memory out = new Recipient[](active);
        uint256 j;
        for (uint256 i; i < _recipients.length; ++i) {
            if (_recipients[i].active) {
                out[j++] = _recipients[i];
            }
        }
        return out;
    }

    /// @inheritdoc IPayrollPlugin
    function bountyPaidThisPeriod() external view override returns (uint256) {
        return _bountyPaidThisPeriod;
    }

    /// @inheritdoc IPayrollPlugin
    function bountyAccumPeriod() external view override returns (uint256) {
        return _bountyAccumPeriod;
    }

    // --- Internals --------------------------------------------------------

    function _countActive() private view returns (uint256 n) {
        uint256 len = _recipients.length;
        for (uint256 i; i < len; ++i) {
            if (_recipients[i].active) ++n;
        }
    }
}
