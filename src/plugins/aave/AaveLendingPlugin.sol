// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.17;

import {PluginUUPSUpgradeable} from "@aragon/osx-commons-contracts/src/plugin/PluginUUPSUpgradeable.sol";
import {IDAO} from "@aragon/osx-commons-contracts/src/dao/IDAO.sol";

import {IAaveLendingPlugin} from "./IAaveLendingPlugin.sol";
import {IAaveAdapter} from "./adapters/IAaveAdapter.sol";

/// @title AaveLendingPlugin (P1 stub)
/// @notice Vote-gated AAVE supply/withdraw/borrow/repay. Real adapter call paths
///         land in P4 — this stub locks the API, permission IDs, and the adapter
///         swap mechanic that supports a future v3→v4 migration.
contract AaveLendingPlugin is PluginUUPSUpgradeable, IAaveLendingPlugin {
    bytes32 public constant TRIGGER_LENDING_PERMISSION_ID = keccak256("TRIGGER_LENDING_PERMISSION");
    bytes32 public constant UPDATE_ADAPTER_PERMISSION_ID = keccak256("UPDATE_ADAPTER_PERMISSION");
    bytes32 public constant MANAGE_ALLOWLIST_PERMISSION_ID = keccak256("MANAGE_ALLOWLIST_PERMISSION");

    IAaveAdapter public override adapter;
    mapping(address => bool) public override allowedAsset;
    bool public override allowlistEnforced;

    uint256[47] private __gap;

    function initialize(
        IDAO _dao,
        IAaveAdapter _adapter,
        address[] calldata _initialAllowlist
    ) external initializer {
        __PluginUUPSUpgradeable_init(_dao);
        if (address(_adapter) == address(0)) revert ZeroAddress();
        adapter = _adapter;

        if (_initialAllowlist.length > 0) {
            allowlistEnforced = true;
            for (uint256 i; i < _initialAllowlist.length; ++i) {
                allowedAsset[_initialAllowlist[i]] = true;
                emit AllowedAssetSet(_initialAllowlist[i], true);
            }
        }
    }

    function supply(address, uint256) external override auth(TRIGGER_LENDING_PERMISSION_ID) {
        revert NotImplemented();
    }

    function withdraw(address, uint256) external override auth(TRIGGER_LENDING_PERMISSION_ID) {
        revert NotImplemented();
    }

    function borrow(address, uint256, uint256) external override auth(TRIGGER_LENDING_PERMISSION_ID) {
        revert NotImplemented();
    }

    function repay(address, uint256, uint256) external override auth(TRIGGER_LENDING_PERMISSION_ID) {
        revert NotImplemented();
    }

    function setAdapter(IAaveAdapter newAdapter) external override auth(UPDATE_ADAPTER_PERMISSION_ID) {
        if (address(newAdapter) == address(0)) revert ZeroAddress();
        IAaveAdapter previous = adapter;
        adapter = newAdapter;
        emit AdapterUpdated(address(previous), address(newAdapter));
    }

    function setAllowedAsset(address asset, bool allowed) external override auth(MANAGE_ALLOWLIST_PERMISSION_ID) {
        allowedAsset[asset] = allowed;
        if (allowed && !allowlistEnforced) {
            allowlistEnforced = true;
        }
        emit AllowedAssetSet(asset, allowed);
    }
}
