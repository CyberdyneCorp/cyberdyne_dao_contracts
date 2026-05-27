// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.17;

import {PermissionLib} from "@aragon/osx-commons-contracts/src/permission/PermissionLib.sol";
import {IPluginSetup} from "@aragon/osx-commons-contracts/src/plugin/setup/IPluginSetup.sol";
import {PluginUpgradeableSetup} from "@aragon/osx-commons-contracts/src/plugin/setup/PluginUpgradeableSetup.sol";
import {ProxyLib} from "@aragon/osx-commons-contracts/src/utils/deployment/ProxyLib.sol";
import {IDAO} from "@aragon/osx-commons-contracts/src/dao/IDAO.sol";

import {UniswapV3Plugin} from "./UniswapV3Plugin.sol";

/// @title UniswapV3PluginSetup (Release 1, Build 1)
/// @notice Deploys the UUPS proxy + grants the 5 permissions (same shape as the
///         swap plugin: the ops disburse funds via the DAO, so the plugin needs
///         EXECUTE on the DAO; ops + manager + allowlist + upgrades are DAO-gated).
contract UniswapV3PluginSetup is PluginUpgradeableSetup {
    using ProxyLib for address;

    uint16 internal constant THIS_BUILD = 1;

    bytes32 private constant EXECUTE_PERMISSION_ID = keccak256("EXECUTE_PERMISSION");

    constructor() PluginUpgradeableSetup(address(new UniswapV3Plugin())) {}

    /// @inheritdoc IPluginSetup
    /// @param _data ABI-encoded `(address positionManager, address[] initialAllowlist)`.
    function prepareInstallation(
        address _dao,
        bytes calldata _data
    ) external returns (address plugin, PreparedSetupData memory preparedSetupData) {
        (address positionManager, address[] memory initialAllowlist) = abi.decode(
            _data,
            (address, address[])
        );

        bytes memory initCalldata = abi.encodeCall(
            UniswapV3Plugin.initialize,
            (IDAO(_dao), positionManager, initialAllowlist)
        );

        plugin = implementation().deployUUPSProxy(initCalldata);

        PermissionLib.MultiTargetPermission[]
            memory permissions = new PermissionLib.MultiTargetPermission[](5);

        // 1) DAO → plugin: EXECUTE (lets the ops move treasury tokens via DAO.execute).
        permissions[0] = PermissionLib.MultiTargetPermission({
            operation: PermissionLib.Operation.Grant,
            where: _dao,
            who: plugin,
            condition: address(0),
            permissionId: EXECUTE_PERMISSION_ID
        });
        // 2) plugin → DAO: MANAGE_POSITIONS (vote-gated mint/increase/decrease/collect/burn).
        permissions[1] = PermissionLib.MultiTargetPermission({
            operation: PermissionLib.Operation.Grant,
            where: plugin,
            who: _dao,
            condition: address(0),
            permissionId: UniswapV3Plugin(plugin).MANAGE_POSITIONS_PERMISSION_ID()
        });
        // 3) plugin → DAO: UPDATE_POSITION_MANAGER (vote-gated NPM migration).
        permissions[2] = PermissionLib.MultiTargetPermission({
            operation: PermissionLib.Operation.Grant,
            where: plugin,
            who: _dao,
            condition: address(0),
            permissionId: UniswapV3Plugin(plugin).UPDATE_POSITION_MANAGER_PERMISSION_ID()
        });
        // 4) plugin → DAO: MANAGE_ALLOWLIST (vote-gated token allowlist).
        permissions[3] = PermissionLib.MultiTargetPermission({
            operation: PermissionLib.Operation.Grant,
            where: plugin,
            who: _dao,
            condition: address(0),
            permissionId: UniswapV3Plugin(plugin).MANAGE_ALLOWLIST_PERMISSION_ID()
        });
        // 5) plugin → DAO: UPGRADE_PLUGIN (vote-gated UUPS upgrades).
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
            permissionId: keccak256("MANAGE_POSITIONS_PERMISSION")
        });
        permissions[2] = PermissionLib.MultiTargetPermission({
            operation: PermissionLib.Operation.Revoke,
            where: _payload.plugin,
            who: _dao,
            condition: address(0),
            permissionId: keccak256("UPDATE_POSITION_MANAGER_PERMISSION")
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
