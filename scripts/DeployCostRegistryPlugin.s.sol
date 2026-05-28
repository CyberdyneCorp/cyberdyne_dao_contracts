// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.17;

import {Script, console2} from "forge-std/Script.sol";

import {CostRegistryPluginSetup} from "../src/plugins/cost-registry/CostRegistryPluginSetup.sol";
import {IPluginRepo, IPluginRepoFactory} from "./lib/IOsxFramework.sol";
import {OsxAddresses} from "./lib/OsxAddresses.sol";

/// @title DeployCostRegistryPlugin
/// @notice Publishes a fresh `PluginRepo` for CostRegistryPlugin via
///         `PluginRepoFactory.createPluginRepoWithFirstVersion`.
/// @dev    Idempotency-free by design — each run creates a NEW repo (subdomain
///         must be unique on the OSx `PluginRepoRegistry`). Override via the
///         `SUBDOMAIN` env var if you re-run on a chain that already has one.
contract DeployCostRegistryPlugin is Script {
    function run() external returns (IPluginRepo repo, CostRegistryPluginSetup setup) {
        string memory subdomain = vm.envOr("SUBDOMAIN", string("cyberdyne-cost-registry"));
        address maintainer = vm.envOr("MAINTAINER", msg.sender);

        IPluginRepoFactory factory = IPluginRepoFactory(
            OsxAddresses.pluginRepoFactory(block.chainid)
        );

        vm.startBroadcast();

        setup = new CostRegistryPluginSetup();
        repo = factory.createPluginRepoWithFirstVersion(
            subdomain,
            address(setup),
            maintainer,
            bytes("ipfs://"),
            bytes("ipfs://")
        );

        vm.stopBroadcast();

        console2.log("CostRegistryPluginSetup:", address(setup));
        console2.log("CostRegistryPluginRepo:", address(repo));
        console2.log("Maintainer:", maintainer);
        console2.log("Subdomain:", subdomain);
    }
}
