// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

/// @notice Test contract that always reverts on incoming ETH — used to verify
///         PayrollPlugin's per-recipient failure tolerance.
contract RevertingRecipient {
    error PayeeRefusedPayment();

    receive() external payable {
        revert PayeeRefusedPayment();
    }
}
