// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.17;

import {PermissionLib} from "@aragon/osx-commons-contracts/src/permission/PermissionLib.sol";
import {IPluginSetup} from "@aragon/osx-commons-contracts/src/plugin/setup/IPluginSetup.sol";
import {PluginUpgradeableSetup} from "@aragon/osx-commons-contracts/src/plugin/setup/PluginUpgradeableSetup.sol";
import {ProxyLib} from "@aragon/osx-commons-contracts/src/utils/deployment/ProxyLib.sol";
import {IDAO} from "@aragon/osx-commons-contracts/src/dao/IDAO.sol";

import {AaveLendingPlugin} from "./AaveLendingPlugin.sol";
import {IAaveAdapter} from "./adapters/IAaveAdapter.sol";

/// @title AaveLendingPluginSetup (Release 1, Build 1)
/// @notice Deploys the UUPS proxy + emits the permission grants from TRD §9.
contract AaveLendingPluginSetup is PluginUpgradeableSetup {
    using ProxyLib for address;

    uint16 internal constant THIS_BUILD = 1;

    bytes32 private constant EXECUTE_PERMISSION_ID = keccak256("EXECUTE_PERMISSION");

    constructor() PluginUpgradeableSetup(address(new AaveLendingPlugin())) {}

    /// @inheritdoc IPluginSetup
    /// @param _data ABI-encoded `(address adapter, address[] initialAllowlist)`.
    function prepareInstallation(
        address _dao,
        bytes calldata _data
    ) external returns (address plugin, PreparedSetupData memory preparedSetupData) {
        (address aaveAdapter, address[] memory initialAllowlist) = abi.decode(
            _data,
            (address, address[])
        );

        bytes memory initCalldata = abi.encodeCall(
            AaveLendingPlugin.initialize,
            (IDAO(_dao), IAaveAdapter(aaveAdapter), initialAllowlist)
        );

        plugin = implementation().deployUUPSProxy(initCalldata);

        PermissionLib.MultiTargetPermission[]
            memory permissions = new PermissionLib.MultiTargetPermission[](5);

        permissions[0] = PermissionLib.MultiTargetPermission({
            operation: PermissionLib.Operation.Grant,
            where: _dao,
            who: plugin,
            condition: address(0),
            permissionId: EXECUTE_PERMISSION_ID
        });
        permissions[1] = PermissionLib.MultiTargetPermission({
            operation: PermissionLib.Operation.Grant,
            where: plugin,
            who: _dao,
            condition: address(0),
            permissionId: AaveLendingPlugin(plugin).TRIGGER_LENDING_PERMISSION_ID()
        });
        permissions[2] = PermissionLib.MultiTargetPermission({
            operation: PermissionLib.Operation.Grant,
            where: plugin,
            who: _dao,
            condition: address(0),
            permissionId: AaveLendingPlugin(plugin).UPDATE_ADAPTER_PERMISSION_ID()
        });
        permissions[3] = PermissionLib.MultiTargetPermission({
            operation: PermissionLib.Operation.Grant,
            where: plugin,
            who: _dao,
            condition: address(0),
            permissionId: AaveLendingPlugin(plugin).MANAGE_ALLOWLIST_PERMISSION_ID()
        });
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
            permissionId: keccak256("TRIGGER_LENDING_PERMISSION")
        });
        permissions[2] = PermissionLib.MultiTargetPermission({
            operation: PermissionLib.Operation.Revoke,
            where: _payload.plugin,
            who: _dao,
            condition: address(0),
            permissionId: keccak256("UPDATE_ADAPTER_PERMISSION")
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
