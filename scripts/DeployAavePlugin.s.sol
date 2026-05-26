// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.17;

import {Script, console2} from "forge-std/Script.sol";

import {AaveLendingPluginSetup} from "../src/plugins/aave/AaveLendingPluginSetup.sol";
import {AaveV3Adapter} from "../src/plugins/aave/adapters/AaveV3Adapter.sol";
import {IAavePool} from "../src/plugins/aave/adapters/IAavePool.sol";
import {IPluginRepo, IPluginRepoFactory} from "./lib/IOsxFramework.sol";
import {OsxAddresses} from "./lib/OsxAddresses.sol";

/// @title DeployAavePlugin
/// @notice Publishes a fresh `PluginRepo` for AaveLendingPlugin AND deploys a
///         `AaveV3Adapter` pointing at the AAVE v3 Pool on the target chain.
///         The DAO bootstrap (DeployCyberdyneDao) passes the adapter address
///         into AaveLendingPlugin's `prepareInstallation` payload.
contract DeployAavePlugin is Script {
    function run() external returns (IPluginRepo repo, AaveLendingPluginSetup setup, AaveV3Adapter adapter) {
        string memory subdomain = vm.envOr("SUBDOMAIN", string("cyberdyne-aave"));
        address maintainer = vm.envOr("MAINTAINER", msg.sender);

        IPluginRepoFactory factory = IPluginRepoFactory(OsxAddresses.pluginRepoFactory(block.chainid));
        address aavePool = OsxAddresses.aaveV3Pool(block.chainid);

        vm.startBroadcast();

        adapter = new AaveV3Adapter(IAavePool(aavePool));
        setup = new AaveLendingPluginSetup();
        repo = factory.createPluginRepoWithFirstVersion(
            subdomain,
            address(setup),
            maintainer,
            bytes("ipfs://"),
            bytes("ipfs://")
        );

        vm.stopBroadcast();

        console2.log("AaveLendingPluginSetup:", address(setup));
        console2.log("AaveLendingPluginRepo:", address(repo));
        console2.log("AaveV3Adapter:", address(adapter));
        console2.log("AavePool (target):", aavePool);
        console2.log("Maintainer:", maintainer);
        console2.log("Subdomain:", subdomain);
    }
}
