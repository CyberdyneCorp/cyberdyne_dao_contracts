// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.17;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IPermit2} from "../../plugins/uniswap-v4/IPermit2.sol";

/// @title MockPermit2 — test-only Permit2 stand-in that records `approve` calls
///         and offers a `transferFrom` that mirrors real Permit2 semantics
///         (uses the ERC20 allowance set on the underlying token).
/// @notice Tests assert the plugin invoked `approve(token, spender, amountIn, deadline)`
///         exactly once per swap with the expected parameters. `transferFrom`
///         lets the MockUniversalRouter pull `tokenIn` from the DAO using the
///         standard ERC20 allowance the DAO granted to Permit2 — preserving
///         the real Universal-Router → Permit2 → ERC20 settlement path.
contract MockPermit2 is IPermit2 {
    struct ApprovalRecord {
        uint160 amount;
        uint48 expiration;
        bool set;
    }

    // (token, spender) → record. Last write wins; tests can also count calls via the array.
    mapping(address => mapping(address => ApprovalRecord)) public records;

    /// @notice Counts every call regardless of (token, spender), useful for
    ///         "approve was called N times" sanity checks across runs.
    uint256 public approveCallCount;

    function approve(address token, address spender, uint160 amount, uint48 expiration) external override {
        records[token][spender] = ApprovalRecord({amount: amount, expiration: expiration, set: true});
        ++approveCallCount;
    }

    function getApproval(address token, address spender)
        external
        view
        returns (uint160 amount, uint48 expiration, bool set)
    {
        ApprovalRecord storage r = records[token][spender];
        return (r.amount, r.expiration, r.set);
    }

    /// @notice Real Permit2 exposes `transferFrom(from, to, amount, token)` —
    ///         this mock implements the same signature so the mock router can
    ///         pull `tokenIn` from the DAO using the ERC20 allowance the DAO
    ///         granted to Permit2 (mirroring the real settlement path).
    /// @dev    Does NOT decrement the internal Permit2 allowance — tests inspect
    ///         the underlying ERC20 allowance (which IS decremented by the
    ///         token's `transferFrom`) to verify zero-leftover after a swap.
    function transferFrom(address from, address to, uint160 amount, address token) external {
        IERC20(token).transferFrom(from, to, amount);
    }
}
