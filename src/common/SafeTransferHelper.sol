// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.17;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title SafeTransferHelper
/// @notice Stateless, custody-free shim that lets a DAO move ERC20s with
///         OpenZeppelin `SafeERC20` semantics (revert on a false-returning or
///         non-compliant token) from inside an Aragon `DAO.execute` batch.
/// @dev    Remediates audit findings M-04 / M-06 (raw `IERC20.transfer`): the
///         low-level OSx executor ignores a call's return data, so a token that
///         returns `false` without reverting would be recorded as a *successful*
///         payment while no funds moved. Plugins therefore never let the DAO
///         call `IERC20.transfer` directly. Instead each ERC20 payment becomes a
///         two-action batch executed *as the DAO*:
///           1. `token.approve(helper, amount)`
///           2. `helper.safeTransfer(token, payee, amount)`
///         `safeTransfer` pulls exactly `amount` from the caller (the DAO)
///         straight to `to` via `SafeERC20.safeTransferFrom`, so the helper
///         never custodies funds and the allowance it consumes nets back to
///         zero. A false-returning or reverting token makes `SafeERC20` revert;
///         with the corresponding `allowFailureMap` bits cleared that reverts
///         the whole batch, so no "paid" state or event is ever recorded for a
///         payment that did not happen.
///
///         The helper is permissionless and holds no state or privileged role:
///         anyone may call it, but it can only move tokens the caller has
///         already approved to it, so it confers no new authority. Each plugin
///         instance deploys its own helper in `initialize`.
contract SafeTransferHelper {
    using SafeERC20 for IERC20;

    /// @notice Move `amount` of `token` from `msg.sender` to `to` with
    ///         `SafeERC20` semantics. Reverts if the transfer reverts or returns
    ///         `false`. The caller must have approved this contract for at least
    ///         `amount` of `token` (the plugins do so in the preceding batch
    ///         action). The helper never holds the tokens — they move directly
    ///         from the caller to `to`.
    function safeTransfer(IERC20 token, address to, uint256 amount) external {
        token.safeTransferFrom(msg.sender, to, amount);
    }
}
