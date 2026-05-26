// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.17;

/// @title IUniversalRouter (minimal subset)
/// @notice Only the methods the plugin needs. Full router lives at Uniswap.
interface IUniversalRouter {
    function execute(
        bytes calldata commands,
        bytes[] calldata inputs,
        uint256 deadline
    ) external payable;

    function execute(bytes calldata commands, bytes[] calldata inputs) external payable;
}
