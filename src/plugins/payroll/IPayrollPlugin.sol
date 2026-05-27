// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.17;

/// @title IPayrollPlugin
/// @notice Fixed-list monthly payroll, gated on management (vote) but with a
///         permissionless monthly crank. Missed months are skipped — no back-pay.
interface IPayrollPlugin {
    /// @notice On-chain recipient record. `active = false` is a soft delete so
    ///         payout history (subgraph + UI) stays intact across removals.
    struct Recipient {
        address payee;
        address token; // address(0) = native ETH
        uint256 amount;
        bool active;
    }

    // --- Events ---

    event RecipientAdded(address indexed payee, address indexed token, uint256 amount);
    event RecipientRemoved(address indexed payee);
    event RecipientAmountUpdated(address indexed payee, uint256 oldAmount, uint256 newAmount);
    event PayDayUpdated(uint8 oldDay, uint8 newDay);
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
    /// @notice `executePayroll()` was called but the remaining active set for
    ///         this period exceeds one page. Use `executePayrollPage` instead.
    error PayrollExceedsSinglePage(uint256 maxPerPage);
    /// @notice `executePayrollPage(0)` — a page must process at least one slot.
    error PageSizeZero();
    error NotImplemented();

    // --- Vote-gated mutators ---

    function addRecipient(address payee, address token, uint256 amount) external;

    function removeRecipient(address payee) external;

    function setAmount(address payee, uint256 newAmount) external;

    /// @notice Set the day-of-month the crank may run. Restricted to 1..28 to avoid
    ///         February / 30/31 calendar edge cases.
    function setPayDayOfMonth(uint8 day) external;

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

    /// @notice The hard cap on `recipientCount()` (active + soft-deleted slots)
    ///         per TRD §11 security note. Bounds the storage scan a paginated
    ///         crank performs.
    function MAX_RECIPIENTS() external view returns (uint256);

    /// @notice Max active recipients paid per crank call. Bounds per-tx gas and
    ///         keeps the run within OSx's 256-action / 256-bit-failure-map limit.
    function MAX_RECIPIENTS_PER_PAGE() external view returns (uint256);
}
