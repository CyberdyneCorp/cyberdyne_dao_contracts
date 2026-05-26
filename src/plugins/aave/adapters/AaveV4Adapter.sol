// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.17;

import {IAaveAdapter} from "./IAaveAdapter.sol";

/// @title AaveV4Adapter (stub)
/// @notice Placeholder adapter that will wrap AAVE v4 once v4 is live.
///         Every function reverts `NotImplemented`. Exists today so the
///         adapter-swap path is exercised by tests and the deploy scripts
///         can publish the v4 PluginRepo version ahead of v4 launch
///         without shipping live lending behavior.
/// @dev    The v3 → v4 migration playbook is documented in
///         `docs/plugins/AAVE.md §3`. Once v4 lands, fill in the bodies
///         (mirror `AaveV3Adapter.sol`) and bump the plugin repo build.
contract AaveV4Adapter is IAaveAdapter {
    /// @notice Reverted by every call until the v4 Pool is wired up.
    error NotImplemented();

    /// @inheritdoc IAaveAdapter
    function poolAddress() external pure override returns (address) {
        revert NotImplemented();
    }

    /// @inheritdoc IAaveAdapter
    function supply(address, uint256, address) external pure override {
        revert NotImplemented();
    }

    /// @inheritdoc IAaveAdapter
    function withdraw(address, uint256, address) external pure override returns (uint256) {
        revert NotImplemented();
    }

    /// @inheritdoc IAaveAdapter
    function borrow(address, uint256, uint256, address) external pure override {
        revert NotImplemented();
    }

    /// @inheritdoc IAaveAdapter
    function repay(address, uint256, uint256, address) external pure override returns (uint256) {
        revert NotImplemented();
    }
}
