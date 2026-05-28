// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.17;

import {Script, console2} from "forge-std/Script.sol";

import {UniswapV3PluginSetup} from "../src/plugins/uniswap-v3/UniswapV3PluginSetup.sol";
import {IPluginRepo, IPluginRepoFactory} from "./lib/IOsxFramework.sol";
import {OsxAddresses} from "./lib/OsxAddresses.sol";

/// @title DeployUniswapV3Plugin
/// @notice Publishes a fresh `PluginRepo` for UniswapV3Plugin via
///         `PluginRepoFactory.createPluginRepoWithFirstVersion`.
/// @dev    Idempotency-free by design — each run creates a NEW repo (subdomain
///         must be unique on the OSx `PluginRepoRegistry`). Override via the
///         `SUBDOMAIN` env var if you re-run on a chain that already has one.
contract DeployUniswapV3Plugin is Script {
    function run() external returns (IPluginRepo repo, UniswapV3PluginSetup setup) {
        string memory subdomain = vm.envOr("SUBDOMAIN", string("cyberdyne-uniswap-v3"));
        address maintainer = vm.envOr("MAINTAINER", msg.sender);

        IPluginRepoFactory factory = IPluginRepoFactory(
            OsxAddresses.pluginRepoFactory(block.chainid)
        );

        vm.startBroadcast();

        setup = new UniswapV3PluginSetup();
        repo = factory.createPluginRepoWithFirstVersion(
            subdomain,
            address(setup),
            maintainer,
            bytes("ipfs://"),
            bytes("ipfs://")
        );

        vm.stopBroadcast();

        console2.log("UniswapV3PluginSetup:", address(setup));
        console2.log("UniswapV3PluginRepo:", address(repo));
        console2.log("Maintainer:", maintainer);
        console2.log("Subdomain:", subdomain);
    }
}
