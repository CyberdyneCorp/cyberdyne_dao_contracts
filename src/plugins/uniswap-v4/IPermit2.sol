// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.17;

/// @title IPermit2 (minimal subset)
/// @notice Only the methods the plugin needs (AllowanceTransfer.approve).
interface IPermit2 {
    /// @notice Approve `spender` to spend up to `amount` of `token` until `expiration`.
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}
