// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.17;

import {PermissionLib} from "@aragon/osx-commons-contracts/src/permission/PermissionLib.sol";
import {IPluginSetup} from "@aragon/osx-commons-contracts/src/plugin/setup/IPluginSetup.sol";
import {PluginUpgradeableSetup} from "@aragon/osx-commons-contracts/src/plugin/setup/PluginUpgradeableSetup.sol";
import {ProxyLib} from "@aragon/osx-commons-contracts/src/utils/deployment/ProxyLib.sol";
import {IDAO} from "@aragon/osx-commons-contracts/src/dao/IDAO.sol";

import {UniswapV4Plugin} from "./UniswapV4Plugin.sol";

/// @title UniswapV4PluginSetup (Release 1, Build 1)
/// @notice Deploys the UUPS proxy + emits the permission grants from TRD §9.
/// @dev Build 1 has no upgrade path; `prepareUpdate` reverts InvalidUpdatePath.
contract UniswapV4PluginSetup is PluginUpgradeableSetup {
    using ProxyLib for address;

    uint16 internal constant THIS_BUILD = 1;

    /// @notice keccak256("EXECUTE_PERMISSION") — defined on the DAO.
    bytes32 private constant EXECUTE_PERMISSION_ID = keccak256("EXECUTE_PERMISSION");

    constructor() PluginUpgradeableSetup(address(new UniswapV4Plugin())) {}

    /// @inheritdoc IPluginSetup
    /// @param _data ABI-encoded `(address universalRouter, address permit2, address poolManager, address[] initialAllowlist)`.
    function prepareInstallation(
        address _dao,
        bytes calldata _data
    ) external returns (address plugin, PreparedSetupData memory preparedSetupData) {
        (
            address universalRouter,
            address permit2,
            address poolManager,
            address[] memory initialAllowlist
        ) = abi.decode(_data, (address, address, address, address[]));

        bytes memory initCalldata = abi.encodeCall(
            UniswapV4Plugin.initialize,
            (IDAO(_dao), universalRouter, permit2, poolManager, initialAllowlist)
        );

        plugin = implementation().deployUUPSProxy(initCalldata);

        PermissionLib.MultiTargetPermission[]
            memory permissions = new PermissionLib.MultiTargetPermission[](5);

        // 1) DAO grants the plugin EXECUTE_PERMISSION so the plugin can build Action[]
        //    batches (approve / route / revoke) and call dao.execute.
        permissions[0] = PermissionLib.MultiTargetPermission({
            operation: PermissionLib.Operation.Grant,
            where: _dao,
            who: plugin,
            condition: address(0),
            permissionId: EXECUTE_PERMISSION_ID
        });
        // 2) Plugin grants the DAO TRIGGER_SWAP — only proposal-executed calls hit swap().
        permissions[1] = PermissionLib.MultiTargetPermission({
            operation: PermissionLib.Operation.Grant,
            where: plugin,
            who: _dao,
            condition: address(0),
            permissionId: UniswapV4Plugin(plugin).TRIGGER_SWAP_PERMISSION_ID()
        });
        // 3) Vote-gated router migration.
        permissions[2] = PermissionLib.MultiTargetPermission({
            operation: PermissionLib.Operation.Grant,
            where: plugin,
            who: _dao,
            condition: address(0),
            permissionId: UniswapV4Plugin(plugin).UPDATE_ROUTER_PERMISSION_ID()
        });
        // 4) Vote-gated allowlist edits.
        permissions[3] = PermissionLib.MultiTargetPermission({
            operation: PermissionLib.Operation.Grant,
            where: plugin,
            who: _dao,
            condition: address(0),
            permissionId: UniswapV4Plugin(plugin).MANAGE_ALLOWLIST_PERMISSION_ID()
        });
        // 5) Vote-gated UUPS upgrades.
        permissions[4] = PermissionLib.MultiTargetPermission({
            operation: PermissionLib.Operation.Grant,
            where: plugin,
            who: _dao,
            condition: address(0),
            permissionId: keccak256("UPGRADE_PLUGIN_PERMISSION")
        });

        preparedSetupData.permissions = permissions;
    }

    /// @inheritdoc IPluginSetup
    function prepareUpdate(
        address _dao,
        uint16 _fromBuild,
        SetupPayload calldata _payload
    ) external pure returns (bytes memory, PreparedSetupData memory) {
        (_dao, _fromBuild, _payload);
        revert InvalidUpdatePath({fromBuild: 0, thisBuild: THIS_BUILD});
    }

    /// @inheritdoc IPluginSetup
    function prepareUninstallation(
        address _dao,
        SetupPayload calldata _payload
    ) external pure returns (PermissionLib.MultiTargetPermission[] memory permissions) {
        permissions = new PermissionLib.MultiTargetPermission[](5);

        permissions[0] = PermissionLib.MultiTargetPermission({
            operation: PermissionLib.Operation.Revoke,
            where: _dao,
            who: _payload.plugin,
            condition: address(0),
            permissionId: EXECUTE_PERMISSION_ID
        });
        permissions[1] = PermissionLib.MultiTargetPermission({
            operation: PermissionLib.Operation.Revoke,
            where: _payload.plugin,
            who: _dao,
            condition: address(0),
            permissionId: keccak256("TRIGGER_SWAP_PERMISSION")
        });
        permissions[2] = PermissionLib.MultiTargetPermission({
            operation: PermissionLib.Operation.Revoke,
            where: _payload.plugin,
            who: _dao,
            condition: address(0),
            permissionId: keccak256("UPDATE_ROUTER_PERMISSION")
        });
        permissions[3] = PermissionLib.MultiTargetPermission({
            operation: PermissionLib.Operation.Revoke,
            where: _payload.plugin,
            who: _dao,
            condition: address(0),
            permissionId: keccak256("MANAGE_ALLOWLIST_PERMISSION")
        });
        permissions[4] = PermissionLib.MultiTargetPermission({
            operation: PermissionLib.Operation.Revoke,
            where: _payload.plugin,
            who: _dao,
            condition: address(0),
            permissionId: keccak256("UPGRADE_PLUGIN_PERMISSION")
        });
    }
}
