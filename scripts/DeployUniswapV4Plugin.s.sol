// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.17;

import {Script, console2} from "forge-std/Script.sol";

import {UniswapV4PluginSetup} from "../src/plugins/uniswap-v4/UniswapV4PluginSetup.sol";
import {IPluginRepo, IPluginRepoFactory} from "./lib/IOsxFramework.sol";
import {OsxAddresses} from "./lib/OsxAddresses.sol";

/// @title DeployUniswapV4Plugin
/// @notice Publishes a fresh `PluginRepo` for UniswapV4Plugin.
contract DeployUniswapV4Plugin is Script {
    function run() external returns (IPluginRepo repo, UniswapV4PluginSetup setup) {
        string memory subdomain = vm.envOr("SUBDOMAIN", string("cyberdyne-uniswap-v4"));
        address maintainer = vm.envOr("MAINTAINER", msg.sender);

        IPluginRepoFactory factory = IPluginRepoFactory(
            OsxAddresses.pluginRepoFactory(block.chainid)
        );

        vm.startBroadcast();

        setup = new UniswapV4PluginSetup();
        repo = factory.createPluginRepoWithFirstVersion(
            subdomain,
            address(setup),
            maintainer,
            bytes("ipfs://"),
            bytes("ipfs://")
        );

        vm.stopBroadcast();

        console2.log("UniswapV4PluginSetup:", address(setup));
        console2.log("UniswapV4PluginRepo:", address(repo));
        console2.log("Maintainer:", maintainer);
        console2.log("Subdomain:", subdomain);
    }
}
