// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.17;

import {Action} from "@aragon/osx-commons-contracts/src/executors/IExecutor.sol";

/// @title IPayrollPlugin
/// @notice Fixed-list monthly payroll, gated on management (vote) but with a
///         permissionless monthly crank. Missed months are skipped — no back-pay.
interface IPayrollPlugin {
    /// @notice On-chain recipient record. `active = false` is a soft delete so
    ///         payout history (subgraph + UI) stays intact across removals.
    ///         `description` is a free-form human label ("Senior dev monthly
    ///         salary", "DevOps retainer", …) the DAO can read in the UI and
    ///         indexers can carry into the subgraph.
    struct Recipient {
        address payee;
        address token; // address(0) = native ETH
        uint256 amount;
        bool active;
        string description;
    }

    // --- Events ---

    event RecipientAdded(
        address indexed payee,
        address indexed token,
        uint256 amount,
        string description
    );
    event RecipientRemoved(address indexed payee);
    event RecipientAmountUpdated(address indexed payee, uint256 oldAmount, uint256 newAmount);
    /// @notice The free-form `description` for `payee` was changed (added,
    ///         updated, or cleared). Indexers should treat this as the
    ///         authoritative source for the current description.
    event RecipientDescriptionSet(
        address indexed payee,
        string oldDescription,
        string newDescription
    );
    event PayDayUpdated(uint8 oldDay, uint8 newDay);
    /// @notice The settable recipient-slot cap (`MAX_RECIPIENTS()`) was changed.
    event MaxRecipientsUpdated(uint256 oldMax, uint256 newMax);
    /// @notice One batch of payments executed within a period. For a payroll
    ///         that fits a single page this fires once (identical to v1); for a
    ///         paginated payroll it fires once per page.
    /// @param period Packed `year * 12 + month`.
    /// @param recipientCount Number of active recipients paid in THIS batch.
    /// @param failureMap Bitmap of per-recipient failures within this batch
    ///        (bit `i` = action `i` failed). The bitmap is page-local — bit `i`
    ///        refers to the `i`-th recipient of this page, not of the period.
    event PayrollExecuted(uint256 indexed period, uint256 recipientCount, uint256 failureMap);
    /// @notice Fires exactly once per period, when the final page is processed
    ///         and `lastPayoutPeriod` advances. Indexers use this as the
    ///         "period fully paid" marker; sum the `PayrollExecuted` batches
    ///         for the same `period` to get the period total.
    event PayrollPeriodCompleted(uint256 indexed period);
    /// @notice The keeper bounty configuration was changed by governance.
    event KeeperBountyConfigured(address indexed token, uint256 perCrank, uint256 maxPerPeriod);
    /// @notice A skipped month was settled via `executeForcePayPeriod`. Fires
    ///         once per period; a second force-pay of the same period reverts.
    event ForcePeriodPaid(uint256 indexed period);
    /// @notice A successful crank paid a keeper bounty to `msg.sender`. Fires
    ///         at most once per `executePayroll(Page)` call, only when the
    ///         period's accumulated bounty is below `maxPerPeriod` and the
    ///         crank actually paid one or more recipients.
    event KeeperBountyPaid(
        address indexed keeper,
        address indexed token,
        uint256 amount,
        uint256 indexed period
    );

    // --- Errors ---

    error RecipientAlreadyExists(address payee);
    error RecipientNotFound(address payee);
    error AlreadyPaidThisPeriod(uint256 period);
    error NotYetDueThisMonth(uint8 currentDay, uint8 payDay);
    error InvalidPayDayOfMonth(uint8 day);
    error ZeroAddress();
    error ZeroAmount();
    error NoActiveRecipients();
    error RecipientLimitExceeded(uint256 max);
    /// @notice `setMaxRecipients` was called with a value below the current slot
    ///         count or above `MAX_RECIPIENTS_CEILING`.
    error MaxRecipientsOutOfRange(uint256 requested, uint256 minimum, uint256 ceiling);
    /// @notice `executePayroll()` was called but the remaining active set for
    ///         this period exceeds one page. Use `executePayrollPage` instead.
    error PayrollExceedsSinglePage(uint256 maxPerPage);
    /// @notice `executePayrollPage(0)` — a page must process at least one slot.
    error PageSizeZero();
    error NotImplemented();
    /// @notice `previewForcePayPeriodActions` target is the current or a future
    ///         period — only past periods can be force-settled (use the crank
    ///         for the current).
    error ForcePeriodNotPast(uint256 period, uint256 currentPeriod);
    /// @notice `previewForcePayPeriodActions` target is ≤ `lastPayoutPeriod` — at
    ///         or before the last regular run, so it may already have been paid.
    ///         Not forcible.
    error ForcePeriodAlreadySettled(uint256 period);
    /// @notice `previewForcePayPeriodActions` target is more than
    ///         `MAX_FORCE_BACK_MONTHS` back.
    error ForcePeriodTooOld(uint256 period);
    /// @notice A recipient-set mutation was attempted while a paginated period
    ///         is mid-flight. Finish the period (or wait for the next) before
    ///         adding / removing / re-pricing recipients (M-03).
    error PayrollMidPagination();
    /// @notice `setKeeperBounty` was given an enabled config (`perCrank > 0`)
    ///         whose `maxPerPeriod` can't fund a single crank (M-02 / L-04).
    error InvalidBountyConfig(uint256 perCrank, uint256 maxPerPeriod);

    // --- Vote-gated mutators ---

    /// @notice Add a new payroll recipient.
    /// @param payee       EOA / contract that receives the recurring payment.
    /// @param token       ERC-20 paid; `address(0)` = native ETH.
    /// @param amount      Atomic amount per period.
    /// @param description Free-form human label ("Senior dev monthly salary",
    ///                    …). May be empty; updateable later via
    ///                    `setRecipientDescription`.
    function addRecipient(
        address payee,
        address token,
        uint256 amount,
        string calldata description
    ) external;

    function removeRecipient(address payee) external;

    /// @notice Bring a soft-deleted (removed) payee back onto payroll, reusing
    ///         its original slot and overwriting token / amount / description
    ///         (L-02). Reverts `RecipientNotFound` if the payee was never added
    ///         and `RecipientAlreadyExists` if it is currently active. Frozen
    ///         while a paginated period is mid-flight.
    function reactivateRecipient(
        address payee,
        address token,
        uint256 amount,
        string calldata description
    ) external;

    function setAmount(address payee, uint256 newAmount) external;

    /// @notice Update the free-form description for an existing recipient.
    ///         Vote-gated (`MANAGE_PAYROLL`); reverts `RecipientNotFound` if
    ///         the payee was never added (soft-deleted slots are still
    ///         editable so historic records can be corrected). Pass an empty
    ///         string to clear.
    function setRecipientDescription(address payee, string calldata description) external;

    /// @notice Set the day-of-month the crank may run. Restricted to 1..28 to avoid
    ///         February / 30/31 calendar edge cases.
    function setPayDayOfMonth(uint8 day) external;

    /// @notice Configure (or disable) the keeper bounty. Pass `perCrank == 0`
    ///         to disable. `maxPerPeriod` is a per-period rolling cap so a
    ///         keeper calling many paginated cranks in the same month can't
    ///         drain the bounty budget arbitrarily.
    /// @param token       Bounty token. `address(0)` = native ETH.
    /// @param perCrank    Amount paid to `msg.sender` per successful crank.
    /// @param maxPerPeriod Maximum total bounty paid in one period (resets per
    ///                    period). When `perCrank > 0` it must be ≥ `perCrank`
    ///                    or the call reverts `InvalidBountyConfig` (L-04); pass
    ///                    `perCrank == 0` to disable the bounty.
    function setKeeperBounty(address token, uint256 perCrank, uint256 maxPerPeriod) external;

    /// @notice Raise or lower the recipient-slot cap returned by
    ///         `MAX_RECIPIENTS()`. Must be ≥ the current slot count and
    ///         ≤ `MAX_RECIPIENTS_CEILING`. Lets the DAO grow past the default
    ///         300 without a plugin upgrade. Gated by `MANAGE_PAYROLL`.
    function setMaxRecipients(uint256 newMax) external;

    /// @notice Governance-safe recovery for a skipped month: returns the
    ///         DAO→payee transfer batch that pays every active recipient once
    ///         for `period` (`year*12+month`). A proposal carries these actions
    ///         and TokenVoting runs them via `dao.execute` at the top level —
    ///         the same preview pattern the AAVE / Uniswap fund ops use, which
    ///         avoids the nested-`dao.execute` reentrancy a wrapper call would
    ///         hit. `period` must be strictly between `lastPayoutPeriod` and the
    ///         current period and ≤ `MAX_FORCE_BACK_MONTHS` back; the active set
    ///         must fit one page. Reverts otherwise (surfaced at build/sim time).
    function previewForcePayPeriodActions(uint256 period) external view returns (Action[] memory);

    /// @notice Stateful, executable recovery for a skipped month (M-02). Pays
    ///         every active recipient once for `period` and atomically records
    ///         the period as force-paid, so it can never be force-paid twice.
    ///         Gated by `MANAGE_PAYROLL` (moves treasury funds outside the
    ///         normal crank). Salary transfers are mandatory — a failed transfer
    ///         reverts the whole call so it can be retried. Prefer this over the
    ///         preview path, which is for off-chain simulation only.
    function executeForcePayPeriod(uint256 period) external;

    /// @notice True once `period` has been settled via `executeForcePayPeriod`.
    function forcePaidPeriod(uint256 period) external view returns (bool);

    // --- Permissionless crank ---

    /// @notice Run this month's payroll in a single batch. Anyone may call;
    ///         idempotent within a period. Reverts `PayrollExceedsSinglePage`
    ///         if the remaining active set won't fit one page — use
    ///         `executePayrollPage` for large payrolls.
    function executePayroll() external;

    /// @notice Pay up to `maxCount` of this period's not-yet-paid active
    ///         recipients (clamped to `MAX_RECIPIENTS_PER_PAGE`). Anyone may
    ///         call. Repeatable within a period until every active recipient is
    ///         paid; the period locks (`lastPayoutPeriod` advances) on the final
    ///         page. Missed months are still skipped — only the current due
    ///         period is ever processed.
    function executePayrollPage(uint256 maxCount) external;

    // --- Views ---

    function payDayOfMonth() external view returns (uint8);

    /// @notice The per-instance SafeERC20 shim every ERC20 payout is routed
    ///         through (see `SafeTransferHelper`). Deployed at install.
    function transferHelper() external view returns (address);

    function lastPayoutPeriod() external view returns (uint256);

    /// @notice Period (`year*12+month`) the in-progress pagination cursor
    ///         belongs to. 0 before the first paginated run. Stale once
    ///         `lastPayoutPeriod >= cursorPeriod` (period complete).
    function cursorPeriod() external view returns (uint256);

    /// @notice Next `_recipients` index a paginated crank will resume from for
    ///         `cursorPeriod`. 0 means "start from the top" (fresh period or
    ///         period complete).
    function payoutCursor() external view returns (uint256);

    function recipientCount() external view returns (uint256);

    /// @notice Read a single recipient slot by index (active or soft-deleted).
    function getRecipientAt(uint256 index) external view returns (Recipient memory);

    /// @notice One-RPC-roundtrip view for the toy frontend (TRD §3a/§3b).
    function allActiveRecipients() external view returns (Recipient[] memory);

    /// @notice The current cap on `recipientCount()` (active + soft-deleted
    ///         slots) per TRD §11 security note. Bounds the storage scan a
    ///         paginated crank performs. Governance-settable via
    ///         `setMaxRecipients`, defaulting to 300, never above
    ///         `MAX_RECIPIENTS_CEILING`.
    function MAX_RECIPIENTS() external view returns (uint256);

    /// @notice The hard upper bound `setMaxRecipients` can never exceed without
    ///         a plugin upgrade. Exposed for UI introspection.
    function MAX_RECIPIENTS_CEILING() external view returns (uint256);

    /// @notice How many months back `previewForcePayPeriodActions` may reach.
    function MAX_FORCE_BACK_MONTHS() external view returns (uint256);

    /// @notice Max active recipients paid per crank call. Bounds per-tx gas and
    ///         keeps the run within OSx's 256-action / 256-bit-failure-map limit.
    function MAX_RECIPIENTS_PER_PAGE() external view returns (uint256);

    /// @notice Token paid as the keeper bounty (0 = native ETH; default).
    function bountyToken() external view returns (address);

    /// @notice Amount paid to `msg.sender` per successful crank. 0 = bounty
    ///         disabled (default).
    function bountyPerCrank() external view returns (uint256);

    /// @notice Per-period rolling cap on the total bounty paid.
    function bountyMaxPerPeriod() external view returns (uint256);

    /// @notice Total bounty paid so far in `bountyAccumPeriod()`. Resets when
    ///         a new period is processed.
    function bountyPaidThisPeriod() external view returns (uint256);

    /// @notice Period (`year*12+month`) that `bountyPaidThisPeriod()` refers to.
    function bountyAccumPeriod() external view returns (uint256);
}
