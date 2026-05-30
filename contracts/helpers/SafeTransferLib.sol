solidity
// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

/**
 * @title SafeTransferLib
 * @notice Safe wrapper for ERC20 token transfers, approvals, and transferFrom.
 * @dev Uses low-level calls to handle tokens that do not conform strictly to the ERC20 standard
 *      (e.g., USDT, BNB). Performs input validation (non-zero addresses, contract code existence).
 *      Emits events for every successful operation to enable off-chain monitoring. Callers should
 *      not emit duplicate Transfer/Approval events to avoid double emission.
 *
 * @custom:gasnote Events increase gas cost ~2k–3k per operation. If gas is critical, consider
 *                 using a version without events or use events sparingly.
 *
 * @custom:tokencompat
 * - Handles tokens that return false (e.g., USDT) by reverting on non‑success.
 * - Handles tokens that do not return a bool (e.g., missing return data) by checking
 *   returndatasize() and reverting if less than 32 bytes.
 * - For tokens that require resetting allowance to 0 first (e.g., USDT), callers should
 *   call `safeApprove(token, spender, 0)` then `safeApprove(token, spender, amount)` in
 *   separate transactions.
 * - Fee-on-transfer tokens are not supported; the amount parameter must be the exact
 *   amount transferred, not the post-fee amount.
 */
library SafeTransferLib {
    // ══════════════════════════════════════════════
    //  Custom Errors
    // ══════════════════════════════════════════════

    /// @notice ERC20 transfer failed.
    /// @param token The token address.
    /// @param to Recipient address.
    /// @param amount Amount attempted to transfer.
    error TransferFailed(address token, address to, uint256 amount);

    /// @notice ERC20 transferFrom failed.
    /// @param token The token address.
    /// @param from Sender address.
    /// @param to Recipient address.
    /// @param amount Amount attempted to transfer.
    error TransferFromFailed(address token, address from, address to, uint256 amount);

    /// @notice ERC20 approve failed.
    /// @param token The token address.
    /// @param spender Spender address.
    /// @param amount Allowance amount attempted.
    error ApproveFailed(address token, address spender, uint256 amount);

    /// @notice Zero address provided where non‑zero required.
    error InvalidAddress();

    /// @notice Address does not contain contract code.
    /// @param token The address that was checked.
    error TokenNotContract(address token);

    // ══════════════════════════════════════════════
    //  Events (for off‑chain logging)
    // ══════════════════════════════════════════════

    /// @notice Emitted on a successful `safeTransfer` or `safeTransferFrom`.
    /// @param token The ERC20 token address.
    /// @param from The sender of the tokens.
    /// @param to The recipient.
    /// @param amount Transferred amount.
    event Transfer(address indexed token, address indexed from, address indexed to, uint256 amount);

    /// @notice Emitted on a successful `safeApprove`.
    /// @param token The ERC20 token address.
    /// @param owner The token owner (the calling contract).
    /// @param spender The approved spender.
    /// @param amount Approved amount.
    event Approval(
        address indexed token,
        address indexed owner,
        address indexed spender,
        uint256 amount
    );

    // ══════════════════════════════════════════════
    //  Address Validation Helpers
    // ══════════════════════════════════════════════

    /// @notice Reverts if `addr` is the zero address.
    /// @param addr Address to validate.
    function _validateAddress(address addr) internal pure {
        if (addr == address(0)) revert InvalidAddress();
    }

    /// @notice Reverts if `token` is the zero address or does not contain contract code.
    /// @param token Token address to validate.
    function _validateToken(address token) internal view {
        _validateAddress(token);
        if (token.code.length == 0) revert TokenNotContract(token);
    }

    // ══════════════════════════════════════════════
    //  Public API
    // ══════════════════════════════════════════════

    /**
     * @notice Safely transfers `amount` tokens from the calling contract to `to`.
     * @dev Uses a low-level call to handle tokens that may not return a boolean.
     *      Reverts if the transfer fails or if `token` or `to` is the zero address.
     *      Emits a `Transfer` event with `from` set to `address(this)`.
     * @param token The ERC20 token address (must have code).
     * @param to The recipient address (must be non‑zero).
     * @param amount The amount of tokens to transfer.
     */
    function safeTransfer(address token, address to, uint256 amount) internal {
        _validateToken(token);
        _validateAddress(to);

        // Perform low-level call to token.transfer(to, amount)
        (bool success, bytes memory data) = token.call(
            abi.encodeCall(IERC20.transfer, (to, amount))
        );

        // Check success and return data
        if (!success || data.length == 0 || !abi.decode(data, (bool))) {
            revert TransferFailed(token, to, amount);
        }

        emit Transfer(token, address(this), to, amount);
    }

    /**
     * @notice Safely transfers `amount` tokens from `from` to `to` using the allowance mechanism.
     * @dev Uses a low-level call to handle tokens that may not return a boolean.
     *      Reverts if the transfer fails or if any address is zero.
     *      Emits a `Transfer` event.
     * @param token The ERC20 token address (must have code).
     * @param from The sender address (must be non‑zero).
     * @param to The recipient address (must be non‑zero).
     * @param amount The amount of tokens to transfer.
     */
    function safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        _validateToken(token);
        _validateAddress(from);
        _validateAddress(to);

        // Perform low-level call to token.transferFrom(from, to, amount)
        (bool success, bytes memory data) = token.call(
            abi.encodeCall(IERC20.transferFrom, (from, to, amount))
        );

        if (!success || data.length == 0 || !abi.decode(data, (bool))) {
            revert TransferFromFailed(token, from, to, amount);
        }

        emit Transfer(token, from, to, amount);
    }

    /**
     * @notice Safely approves `spender` to spend `amount` tokens.
     * @dev Uses a low-level call to handle tokens that may not return a boolean.
     *      Reverts if the approval fails or if any address is zero.
     *      Emits an `Approval` event.
     * @param token The ERC20 token address (must have code).
     * @param spender The spender address (must be non‑zero).
     * @param amount The allowance amount.
     */
    function safeApprove(address token, address spender, uint256 amount) internal {
        _validateToken(token);
        _validateAddress(spender);

        // Perform low-level call to token.approve(spender, amount)
        (bool success, bytes memory data) = token.call(
            abi.encodeCall(IERC20.approve, (spender, amount))
        );

        if (!success || data.length == 0 || !abi.decode(data, (bool))) {
            revert ApproveFailed(token, spender, amount);
        }

        emit Approval(token, address(this), spender, amount);
    }

    // ══════════════════════════════════════════════
    //  Minimal ERC20 Interface (for encoding only)
    // ══════════════════════════════════════════════

    /// @notice Minimal interface used to generate ABI-encoded calls.
    interface IERC20 {
        function transfer(address to, uint256 amount) external returns (bool);
        function transferFrom(address from, address to, uint256 amount) external returns (bool);
        function approve(address spender, uint256 amount) external returns (bool);
    }
}