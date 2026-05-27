// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.17;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {PluginUUPSUpgradeable} from "@aragon/osx-commons-contracts/src/plugin/PluginUUPSUpgradeable.sol";
import {IDAO} from "@aragon/osx-commons-contracts/src/dao/IDAO.sol";
import {IExecutor, Action} from "@aragon/osx-commons-contracts/src/executors/IExecutor.sol";

import {IPayrollPlugin} from "./IPayrollPlugin.sol";
import {BokkyPooBahsDateTimeLibrary as DT} from "./lib/BokkyPooBahsDateTimeLibrary.sol";

/// @title PayrollPlugin
/// @notice Fixed-list monthly payroll on Aragon OSx.
///         Recipient management is vote-gated; the monthly `executePayroll`
///         crank is permissionless. Missed months are skipped — no back-pay.
/// @dev    Plugin never custodies funds. Transfers flow DAO → payee via
///         `IExecutor.execute` with `allowFailureMap = (1 << n) - 1` so one
///         reverting recipient never halts the run for the rest.
contract PayrollPlugin is PluginUUPSUpgradeable, IPayrollPlugin {
    bytes32 public constant MANAGE_PAYROLL_PERMISSION_ID = keccak256("MANAGE_PAYROLL_PERMISSION");

    /// @notice Gates `setKeeperBounty`. Separate from `MANAGE_PAYROLL` so the
    ///         bounty budget can be tuned by a different governance class
    ///         (e.g. a treasury sub-committee) than recipient management.
    bytes32 public constant UPDATE_BOUNTY_PERMISSION_ID = keccak256("UPDATE_BOUNTY_PERMISSION");

    /// @inheritdoc IPayrollPlugin
    /// @dev Total slot cap (active + soft-deleted). Bounds the storage scan a
    ///      paginated crank performs to find the next active recipient (TRD §11).
    uint256 public constant override MAX_RECIPIENTS = 300;

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

    uint256[40] private __gap;

    /// @notice Initialize the plugin. Called once via the UUPS proxy constructor.
    function initialize(IDAO _dao, uint8 _payDayOfMonth) external initializer {
        __PluginUUPSUpgradeable_init(_dao);
        if (_payDayOfMonth == 0 || _payDayOfMonth > 28) {
            revert InvalidPayDayOfMonth(_payDayOfMonth);
        }
        payDayOfMonth = _payDayOfMonth;
    }

    // --- Vote-gated management --------------------------------------------

    /// @inheritdoc IPayrollPlugin
    function addRecipient(
        address payee,
        address token,
        uint256 amount
    ) external override auth(MANAGE_PAYROLL_PERMISSION_ID) {
        if (payee == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (indexOfPayee[payee] != 0) revert RecipientAlreadyExists(payee);
        if (_recipients.length >= MAX_RECIPIENTS) {
            revert RecipientLimitExceeded(MAX_RECIPIENTS);
        }

        _recipients.push(Recipient({payee: payee, token: token, amount: amount, active: true}));
        indexOfPayee[payee] = _recipients.length; // 1-based

        emit RecipientAdded(payee, token, amount);
    }

    /// @inheritdoc IPayrollPlugin
    /// @dev Soft delete — slot is marked inactive but kept so prior payout
    ///      history (events / subgraph) keeps a stable foreign key.
    function removeRecipient(address payee) external override auth(MANAGE_PAYROLL_PERMISSION_ID) {
        uint256 idx = indexOfPayee[payee];
        if (idx == 0) revert RecipientNotFound(payee);

        Recipient storage r = _recipients[idx - 1];
        if (!r.active) revert RecipientNotFound(payee); // already soft-deleted
        r.active = false;

        emit RecipientRemoved(payee);
    }

    /// @inheritdoc IPayrollPlugin
    function setAmount(
        address payee,
        uint256 newAmount
    ) external override auth(MANAGE_PAYROLL_PERMISSION_ID) {
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
    /// @dev Set the keeper bounty paid out of the DAO treasury to `msg.sender`
    ///      on each successful crank. `perCrank == 0` disables (default).
    ///      `maxPerPeriod` rolls per period so paginated cranks within the
    ///      same month share one cap.
    function setKeeperBounty(
        address token,
        uint256 perCrank,
        uint256 maxPerPeriod
    ) external override auth(UPDATE_BOUNTY_PERMISSION_ID) {
        bountyToken = token;
        bountyPerCrank = perCrank;
        bountyMaxPerPeriod = maxPerPeriod;
        emit KeeperBountyConfigured(token, perCrank, maxPerPeriod);
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
        (uint256 year, uint256 month, uint256 day) = DT.timestampToDate(block.timestamp);
        uint256 currentPeriod = year * 12 + month;

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

        // Collect up to `maxCount` active recipients from `start`. `i` ends at
        // the slot to resume from next page (or `len` if we reached the end).
        Action[] memory buffer = new Action[](maxCount);
        uint256 count;
        uint256 i = start;
        for (; i < len && count < maxCount; ++i) {
            Recipient memory r = _recipients[i];
            if (!r.active) continue;
            buffer[count++] = (r.token == address(0))
                ? Action({to: r.payee, value: r.amount, data: ""})
                : Action({
                    to: r.token,
                    value: 0,
                    data: abi.encodeCall(IERC20.transfer, (r.payee, r.amount))
                });
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

        // `executePayroll` must finish the period in this one batch.
        if (requireSinglePass && !reachedEnd) {
            revert PayrollExceedsSinglePage(maxCount);
        }

        // Compute the keeper bounty for this crank — may be 0 if disabled, or
        // clipped by the per-period cap. Decide here so the action batch has
        // its final size known before we allocate.
        uint256 bountyAmount = _calcBountyAmount(currentPeriod);

        // Recipient actions + optional trailing bounty action.
        uint256 actionsLen = bountyAmount > 0 ? count + 1 : count;
        Action[] memory actions = new Action[](actionsLen);
        for (uint256 k; k < count; ++k) {
            actions[k] = buffer[k];
        }
        if (bountyAmount > 0) {
            address bToken = bountyToken;
            actions[count] = (bToken == address(0))
                ? Action({to: msg.sender, value: bountyAmount, data: ""})
                : Action({
                    to: bToken,
                    value: 0,
                    data: abi.encodeCall(IERC20.transfer, (msg.sender, bountyAmount))
                });
        }

        // Every bit set so any single action (recipient transfer OR the bounty)
        // can fail without aborting the batch. `actionsLen <= 101`, so the shift
        // is safe.
        uint256 allowFailureMap = (uint256(1) << actionsLen) - 1;

        // EFFECTS before INTERACTIONS: advance the cursor / lock the period now
        // so a reentrant crank cannot re-pay this page.
        _cursorPeriod = currentPeriod;
        if (reachedEnd) {
            _payoutCursor = 0;
            lastPayoutPeriod = currentPeriod;
        } else {
            _payoutCursor = i;
        }
        // Reserve the bounty against the per-period cap BEFORE the external
        // call. If the bounty leg reverts via the allowFailureMap, the
        // reservation still stands — a keeper that can't be paid this call
        // can't retry to drain past the cap by spamming pages.
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
            allowFailureMap
        );

        emit PayrollExecuted(currentPeriod, count, failureMap);
        if (bountyAmount > 0) {
            emit KeeperBountyPaid(msg.sender, bountyToken, bountyAmount, currentPeriod);
        }
        if (reachedEnd) emit PayrollPeriodCompleted(currentPeriod);
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
