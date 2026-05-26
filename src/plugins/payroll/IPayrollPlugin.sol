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
    /// @param period Packed `year * 12 + month`.
    /// @param recipientCount Number of active recipients included in this run.
    /// @param failureMap Bitmap of per-recipient failures (bit `i` = action `i` failed).
    event PayrollExecuted(uint256 indexed period, uint256 recipientCount, uint256 failureMap);

    // --- Errors ---

    error RecipientAlreadyExists(address payee);
    error RecipientNotFound(address payee);
    error AlreadyPaidThisPeriod(uint256 period);
    error NotYetDueThisMonth(uint8 currentDay, uint8 payDay);
    error InvalidPayDayOfMonth(uint8 day);
    error NotImplemented();

    // --- Vote-gated mutators ---

    function addRecipient(address payee, address token, uint256 amount) external;

    function removeRecipient(address payee) external;

    function setAmount(address payee, uint256 newAmount) external;

    /// @notice Set the day-of-month the crank may run. Restricted to 1..28 to avoid
    ///         February / 30/31 calendar edge cases.
    function setPayDayOfMonth(uint8 day) external;

    // --- Permissionless crank ---

    /// @notice Run this month's payroll. Anyone may call; idempotent within a period.
    function executePayroll() external;

    // --- Views ---

    function payDayOfMonth() external view returns (uint8);

    function lastPayoutPeriod() external view returns (uint256);

    function recipientCount() external view returns (uint256);

    /// @notice One-RPC-roundtrip view for the toy frontend (TRD §3a/§3b).
    function allActiveRecipients() external view returns (Recipient[] memory);
}
