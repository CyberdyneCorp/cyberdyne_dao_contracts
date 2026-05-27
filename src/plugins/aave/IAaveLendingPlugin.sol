// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.17;

import {Action} from "@aragon/osx-commons-contracts/src/executors/IExecutor.sol";

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

    // --- Action-builder views (governance path) ---
    // Each `preview…Actions` returns the Action[] the wrapper would execute
    // via `dao.execute`. The governance frontend submits these as a multi-
    // action TokenVoting proposal, avoiding the nested-`dao.execute`
    // reentrancy that blocks the wrappers on the governance path.

    function previewSupplyActions(
        address asset,
        uint256 amount
    ) external view returns (Action[] memory);

    function previewWithdrawActions(
        address asset,
        uint256 amount
    ) external view returns (Action[] memory);

    function previewBorrowActions(
        address asset,
        uint256 amount,
        uint256 interestRateMode
    ) external view returns (Action[] memory);

    function previewRepayActions(
        address asset,
        uint256 amount,
        uint256 interestRateMode
    ) external view returns (Action[] memory);

    // --- Vote-gated mutators (direct-call entry; same as preview + execute) ---

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
