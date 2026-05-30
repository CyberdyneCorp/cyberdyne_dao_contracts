solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title AccountingLib
/// @notice Shared library that atomically transfers tokens (via SafeERC20) and marks a payment
///         status. Eliminates the possibility of "partial payment" state.
/// @dev Plugins embed a `PaymentStatus` struct in their storage and call the appropriate transfer
///      function. The library reverts on failed transfers or invalid inputs, ensuring the status
///      flag is set only after a successful transfer.
///      **Security** – Because this library performs an external call (ERC20 transfer) before
///      writing to storage, the calling contract MUST enforce a reentrancy guard (e.g.
///      OpenZeppelin's `ReentrancyGuard`) when the token is ERC777 or any token that can call
///      back into the caller. Without such guard, an attacker could re‑enter the caller's
///      function and drain funds. This library itself cannot hold state, so the guard must be
///      at the caller level.
///      **Invariant:** A `PaymentStatus` that is `true` guarantees that the corresponding tokens
///      have been transferred (and not reversed). Conversely, if the function reverts, the
///      status remains `false` and no tokens leave the sender.
library AccountingLib {
    using SafeERC20 for IERC20;

    // ──────────────────────────────────────────────────────────────
    // Library version
    // ──────────────────────────────────────────────────────────────

    /// @notice Returns the version of this library.
    /// @return versionString Semantic version string.
    function version() external pure returns (string memory versionString) {
        versionString = "1.0.1";
    }

    // ──────────────────────────────────────────────────────────────
    // Custom errors (gas efficient, no string storage)
    // ──────────────────────────────────────────────────────────────

    /// @notice Thrown when a zero-address token is provided.
    error ZeroTokenAddress();

    /// @notice Thrown when a zero-address sender is provided (transferFrom).
    error ZeroSenderAddress();

    /// @notice Thrown when a zero-address recipient is provided.
    error ZeroRecipientAddress();

    /// @notice Thrown when the transfer amount is zero.
    error ZeroTransferAmount();

    /// @notice Thrown when attempting to mark an already-paid payment.
    error AlreadyPaid();

    // ──────────────────────────────────────────────────────────────
    // Events
    // ──────────────────────────────────────────────────────────────

    /// @notice Emitted after a successful transfer and status update.
    /// @param token The token transferred (indexed for quick filtering).
    /// @param from The sender of the tokens (indexed).
    /// @param to The recipient of the tokens (indexed).
    /// @param amount The amount transferred.
    event PaymentMarkedPaid(
        IERC20 indexed token,
        address indexed from,
        address indexed to,
        uint256 amount
    );

    // ───────────────────────────────────────────────────��──────────
    // Types
    // ──────────────────────────────────────────────────────────────

    /// @notice Tracks whether a payment has been completed.
    struct PaymentStatus {
        bool paid;
    }

    // ──────────────────────────────────────────────────────────────
    // Internal validation helper (inlined by compiler – zero overhead)
    // ──────────────────────────────────────────────────────────────

    /// @notice Validates common pre-conditions for payment marking.
    /// @param token The ERC20 token address.
    /// @param recipient The address receiving tokens.
    /// @param amount The amount to transfer.
    /// @param status The storage pointer to the payment status.
    /// @dev Reverts if any input is invalid or the payment is already marked.
    ///      This function is inlined by the compiler for zero calling overhead.
    function _validate(
        IERC20 token,
        address recipient,
        uint256 amount,
        PaymentStatus storage status
    ) private pure {
        if (address(token) == address(0)) revert ZeroTokenAddress();
        if (recipient == address(0)) revert ZeroRecipientAddress();
        if (amount == 0) revert ZeroTransferAmount();
        if (status.paid) revert AlreadyPaid();
    }

    // ──────────────────────────────────────────────────────────────
    // External Functions
    // ──────────────────────────────────────────────────────────────

    /// @notice Transfers tokens from `sender` to `recipient` via safeTransferFrom,
    ///         then marks the given `status` as paid.
    /// @param token The ERC20 token to transfer (must be non-zero, must be a contract).
    /// @param sender The address pulling tokens from (must have approved this contract;
    ///        must be non-zero to avoid accidental burning).
    /// @param recipient The address receiving the tokens (must be non-zero).
    /// @param amount The amount of tokens to transfer (must be > 0).
    /// @param status A storage pointer to the PaymentStatus struct to mark.
    /// @dev Reverts on any invalid input, if the ERC20 transfer fails (allowance/balance
    ///      issues, non‑contract token), or if the payment was already marked.
    ///      The status is set **only after** a successful transfer, guaranteeing atomicity.
    ///      Uses `unchecked` for the status assignment to save gas (the check was already
    ///      performed and cannot overflow). No reentrancy risk from the token: the status
    ///      is written after the external call and no further external calls follow.
    ///      **Caller responsibility:** If the token can call back (e.g. ERC777), the calling
    ///      contract must enforce a reentrancy guard (see library-level docs).
    function transferFromAndMark(
        IERC20 token,
        address sender,
        address recipient,
        uint256 amount,
        PaymentStatus storage status
    ) external {
        // Validate all inputs – sender must be non-zero to prevent accidental burning.
        if (sender == address(0)) revert ZeroSenderAddress();
        _validate(token, recipient, amount, status);

        // Perform transfer – SafeERC20.safeTransferFrom reverts on any failure.
        token.safeTransferFrom(sender, recipient, amount);

        // Mark as paid only after successful transfer.
        unchecked {
            status.paid = true;
        }

        emit PaymentMarkedPaid({token: token, from: sender, to: recipient, amount: amount});
    }

    /// @notice Transfers tokens from this contract to `recipient` via safeTransfer,
    ///         then marks the given `status` as paid.
    /// @param token The ERC20 token to transfer (must be non-zero, must be a contract).
    /// @param recipient The address receiving the tokens (must be non-zero).
    /// @param amount The amount of tokens to transfer (must be > 0).
    /// @param status A storage pointer to the PaymentStatus struct to mark.
    /// @dev Reverts on any invalid input, if the ERC20 transfer fails (balance/receiver issues,
    ///      non‑contract token), or if the payment was already marked.
    ///      The status is set **only after** a successful transfer, guaranteeing atomicity.
    ///      Uses `unchecked` for the status assignment to save gas.
    ///      No reentrancy risk from the token: the status is written after the external call
    ///      and no further external calls follow.
    ///      **Caller responsibility:** If the token can call back (e.g. ERC777), the calling
    ///      contract must enforce a reentrancy guard (see library-level docs).
    function transferAndMark(
        IERC20 token,
        address recipient,
        uint256 amount,
        PaymentStatus storage status
    ) external {
        _validate(token, recipient, amount, status);

        // Perform transfer – SafeERC20.safeTransfer reverts on failure.
        token.safeTransfer(recipient, amount);

        unchecked {
            status.paid = true;
        }

        emit PaymentMarkedPaid({token: token, from: address(this), to: recipient, amount: amount});
    }

    /// @notice Returns whether the payment identified by `status` has been completed.
    /// @param status The PaymentStatus storage pointer to query.
    /// @return paid True if already paid, false otherwise.
    function isPaid(PaymentStatus storage status) external view returns (bool paid) {
        paid = status.paid;
    }
}