// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.17;

import {PermissionLib} from "@aragon/osx-commons-contracts/src/permission/PermissionLib.sol";
import {IPluginSetup} from "@aragon/osx-commons-contracts/src/plugin/setup/IPluginSetup.sol";
import {PluginUpgradeableSetup} from "@aragon/osx-commons-contracts/src/plugin/setup/PluginUpgradeableSetup.sol";
import {ProxyLib} from "@aragon/osx-commons-contracts/src/utils/deployment/ProxyLib.sol";
import {IDAO} from "@aragon/osx-commons-contracts/src/dao/IDAO.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {CostRegistryPlugin} from "./CostRegistryPlugin.sol";

/// @title CostRegistryPluginSetup (Release 1, Build 1)
/// @notice Deploys the UUPS proxy + emits the 3 permission grants (same shape
///         as Payroll: the crank disburses funds via the DAO, so the plugin
///         needs EXECUTE on the DAO; mutations + upgrades are DAO-gated).
contract CostRegistryPluginSetup is PluginUpgradeableSetup {
    using ProxyLib for address;

    uint16 internal constant THIS_BUILD = 1;

    bytes32 private constant EXECUTE_PERMISSION_ID = keccak256("EXECUTE_PERMISSION");

    constructor() PluginUpgradeableSetup(address(new CostRegistryPlugin())) {}

    /// @inheritdoc IPluginSetup
    /// @param _data ABI-encoded `(address paymentToken)` — the USDC address.
    function prepareInstallation(
        address _dao,
        bytes calldata _data
    ) external returns (address plugin, PreparedSetupData memory preparedSetupData) {
        address paymentToken = abi.decode(_data, (address));

        bytes memory initCalldata = abi.encodeCall(
            CostRegistryPlugin.initialize,
            (IDAO(_dao), IERC20(paymentToken))
        );

        plugin = implementation().deployUUPSProxy(initCalldata);

        PermissionLib.MultiTargetPermission[]
            memory permissions = new PermissionLib.MultiTargetPermission[](4);

        // 1) DAO → plugin: EXECUTE_PERMISSION (lets the crank issue transfers via DAO.execute).
        permissions[0] = PermissionLib.MultiTargetPermission({
            operation: PermissionLib.Operation.Grant,
            where: _dao,
            who: plugin,
            condition: address(0),
            permissionId: EXECUTE_PERMISSION_ID
        });
        // 2) plugin → DAO: MANAGE_COSTS (vote-gated register / update / remove).
        permissions[1] = PermissionLib.MultiTargetPermission({
            operation: PermissionLib.Operation.Grant,
            where: plugin,
            who: _dao,
            condition: address(0),
            permissionId: CostRegistryPlugin(plugin).MANAGE_COSTS_PERMISSION_ID()
        });
        // 3) plugin → DAO: UPGRADE_PLUGIN (vote-gated UUPS upgrades).
        permissions[2] = PermissionLib.MultiTargetPermission({
            operation: PermissionLib.Operation.Grant,
            where: plugin,
            who: _dao,
            condition: address(0),
            permissionId: keccak256("UPGRADE_PLUGIN_PERMISSION")
        });
        // 4) plugin → DAO: UPDATE_PAYMENT_TOKEN (vote-gated setPaymentToken).
        permissions[3] = PermissionLib.MultiTargetPermission({
            operation: PermissionLib.Operation.Grant,
            where: plugin,
            who: _dao,
            condition: address(0),
            permissionId: CostRegistryPlugin(plugin).UPDATE_PAYMENT_TOKEN_PERMISSION_ID()
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
        permissions = new PermissionLib.MultiTargetPermission[](4);

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
            permissionId: keccak256("MANAGE_COSTS_PERMISSION")
        });
        permissions[2] = PermissionLib.MultiTargetPermission({
            operation: PermissionLib.Operation.Revoke,
            where: _payload.plugin,
            who: _dao,
            condition: address(0),
            permissionId: keccak256("UPGRADE_PLUGIN_PERMISSION")
        });
        permissions[3] = PermissionLib.MultiTargetPermission({
            operation: PermissionLib.Operation.Revoke,
            where: _payload.plugin,
            who: _dao,
            condition: address(0),
            permissionId: keccak256("UPDATE_PAYMENT_TOKEN_PERMISSION")
        });
    }
}
