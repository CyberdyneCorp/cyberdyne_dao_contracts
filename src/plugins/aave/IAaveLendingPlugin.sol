// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.17;

import {IAaveAdapter} from "./adapters/IAaveAdapter.sol";

/// @title IAaveLendingPlugin
/// @notice Vote-gated DAO supply/withdraw/borrow/repay against AAVE via a pluggable adapter.
/// @dev aTokens + debt tokens are issued to the DAO (`onBehalfOf = dao`). Plugin never custodies.
interface IAaveLendingPlugin {
    // --- Events ---

    event Supplied(address indexed asset, uint256 amount);
    event Withdrawn(address indexed asset, uint256 amount, uint256 received);
    event Borrowed(address indexed asset, uint256 amount, uint256 interestRateMode);
    event Repaid(address indexed asset, uint256 amount, uint256 interestRateMode, uint256 paid);
    event AdapterUpdated(address indexed previous, address indexed current);
    event AllowedAssetSet(address indexed asset, bool allowed);

    // --- Errors ---

    error AssetNotAllowed(address asset);
    error ZeroAddress();
    error NotImplemented();

    // --- Vote-gated mutators ---

    function supply(address asset, uint256 amount) external;

    function withdraw(address asset, uint256 amount) external;

    function borrow(address asset, uint256 amount, uint256 interestRateMode) external;

    function repay(address asset, uint256 amount, uint256 interestRateMode) external;

    function setAdapter(IAaveAdapter newAdapter) external;

    function setAllowedAsset(address asset, bool allowed) external;

    // --- Views ---

    function adapter() external view returns (IAaveAdapter);

    function allowedAsset(address asset) external view returns (bool);

    function allowlistEnforced() external view returns (bool);

    function opNonce() external view returns (uint256);
}
