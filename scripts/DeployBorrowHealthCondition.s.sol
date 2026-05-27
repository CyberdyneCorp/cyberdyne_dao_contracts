// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.17;

import {Script, console2} from "forge-std/Script.sol";

import {BorrowHealthCondition, IAavePoolView} from "../src/plugins/aave/conditions/BorrowHealthCondition.sol";
import {OsxAddresses} from "./lib/OsxAddresses.sol";

/// @title DeployBorrowHealthCondition
/// @notice Deploys a `BorrowHealthCondition` pinned to the chain's AAVE v3 Pool
///         and a configurable health-factor floor (`MIN_HEALTH_FACTOR`, 18-dec,
///         default 1.5e18). Wire it to lending afterward via a governance vote:
///         - operator borrows: `dao.grantWithCondition(aavePlugin, operator,
///           TRIGGER_LENDING_PERMISSION_ID, condition)`;
///         - governance borrows: append `condition.assertHealthFactor(dao)` as
///           the final action of each borrow proposal.
contract DeployBorrowHealthCondition is Script {
    function run() external returns (BorrowHealthCondition condition) {
        uint256 minHealthFactor = vm.envOr("MIN_HEALTH_FACTOR", uint256(1.5e18));
        address pool = OsxAddresses.aaveV3Pool(block.chainid);

        vm.startBroadcast();
        condition = new BorrowHealthCondition(IAavePoolView(pool), minHealthFactor);
        vm.stopBroadcast();

        console2.log("BorrowHealthCondition:", address(condition));
        console2.log("  AAVE pool:", pool);
        console2.log("  minHealthFactor:", minHealthFactor);
    }
}
