// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

/// @notice Test-only ERC20 whose `transfer` / `transferFrom` return `false`
///         WITHOUT reverting — the exact "false-returning token" class that
///         findings M-04 / M-06 / CR-M-01 are about. `approve` and balance
///         bookkeeping behave normally so the DAO→helper approve leg succeeds;
///         only the actual move silently fails. Routed through
///         `SafeTransferHelper.safeTransfer` this makes `SafeERC20` revert,
///         which (with `allowFailureMap = 0`) reverts the whole crank batch —
///         the property the regression tests assert.
contract FalseReturningERC20 {
    string public name = "False Token";
    string public symbol = "FALSE";
    uint8 public decimals;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(uint8 decimals_) {
        decimals = decimals_;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    /// @dev Always returns false, never moves funds, never reverts.
    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }

    /// @dev Always returns false, never moves funds, never reverts.
    function transferFrom(address, address, uint256) external pure returns (bool) {
        return false;
    }
}
