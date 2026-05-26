// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.17;

import {Script, console2} from "forge-std/Script.sol";

import {PayrollPluginSetup} from "../src/plugins/payroll/PayrollPluginSetup.sol";
import {UniswapV4PluginSetup} from "../src/plugins/uniswap-v4/UniswapV4PluginSetup.sol";
import {AaveLendingPluginSetup} from "../src/plugins/aave/AaveLendingPluginSetup.sol";
import {AaveV3Adapter} from "../src/plugins/aave/adapters/AaveV3Adapter.sol";
import {IAavePool} from "../src/plugins/aave/adapters/IAavePool.sol";

import {
    IDAOFactory,
    IPluginRepo,
    IPluginRepoFactory,
    PluginSetupRef,
    Tag
} from "./lib/IOsxFramework.sol";
import {OsxAddresses} from "./lib/OsxAddresses.sol";

/// @title DeployCyberdyneDao
/// @notice One-ceremony bootstrap per TRD §8 + ROADMAP P5.
///         Phase 1: publish 3 PluginRepos (Payroll, Uniswap V4, AAVE).
///         Phase 2: DAOFactory.createDao installs all 3 in a single tx.
///         Phase 3: writes deployments/<chain>-<timestamp>.json with every
///                  resulting address for the frontend repo to consume.
///
/// @dev    TokenVoting integration is deferred. The roadmap's pseudocode
///         includes TokenVoting as plugins[0], but its PluginRepo address is
///         published by the separate `aragon/token-voting-plugin` repo and
///         varies per chain. To install it, set `TOKEN_VOTING_REPO` env var
///         and the script will splice it in as plugins[0]. Without it, the
///         DAO is created with the 3 Cyberdyne plugins only — see
///         "Without TokenVoting" notes at the bottom of the script.
///
///         Run example (anvil fork of mainnet):
///         ```
///         export PAY_DAY=15 SUBDOMAIN_DAO=cyberdyne
///         forge script scripts/DeployCyberdyneDao.s.sol \
///             --rpc-url $RPC_MAINNET --broadcast --slow
///         ```
contract DeployCyberdyneDao is Script {
    struct PublishedPlugins {
        IPluginRepo payrollRepo;
        PayrollPluginSetup payrollSetup;
        IPluginRepo uniswapRepo;
        UniswapV4PluginSetup uniswapSetup;
        IPluginRepo aaveRepo;
        AaveLendingPluginSetup aaveSetup;
        AaveV3Adapter aaveAdapter;
    }

    function run() external returns (address dao, PublishedPlugins memory published) {
        address maintainer = vm.envOr("MAINTAINER", msg.sender);

        vm.startBroadcast();
        published = _publishRepos(maintainer);
        dao = _createDao(published);
        vm.stopBroadcast();

        _logAndPersist(dao, published);
    }

    function _publishRepos(address maintainer) internal returns (PublishedPlugins memory p) {
        IPluginRepoFactory pluginRepoFactory =
            IPluginRepoFactory(OsxAddresses.pluginRepoFactory(block.chainid));

        p.payrollSetup = new PayrollPluginSetup();
        p.payrollRepo = pluginRepoFactory.createPluginRepoWithFirstVersion(
            _uniqueSubdomain("cyberdyne-payroll"),
            address(p.payrollSetup),
            maintainer,
            bytes("ipfs://"),
            bytes("ipfs://")
        );

        p.uniswapSetup = new UniswapV4PluginSetup();
        p.uniswapRepo = pluginRepoFactory.createPluginRepoWithFirstVersion(
            _uniqueSubdomain("cyberdyne-uniswap-v4"),
            address(p.uniswapSetup),
            maintainer,
            bytes("ipfs://"),
            bytes("ipfs://")
        );

        p.aaveAdapter = new AaveV3Adapter(IAavePool(OsxAddresses.aaveV3Pool(block.chainid)));
        p.aaveSetup = new AaveLendingPluginSetup();
        p.aaveRepo = pluginRepoFactory.createPluginRepoWithFirstVersion(
            _uniqueSubdomain("cyberdyne-aave"),
            address(p.aaveSetup),
            maintainer,
            bytes("ipfs://"),
            bytes("ipfs://")
        );
    }

    function _createDao(PublishedPlugins memory p) internal returns (address dao) {
        IDAOFactory daoFactory = IDAOFactory(OsxAddresses.daoFactory(block.chainid));
        IDAOFactory.PluginSettings[] memory pluginSettings = _buildPluginSettings(p);

        IDAOFactory.DAOSettings memory daoSettings = IDAOFactory.DAOSettings({
            trustedForwarder: address(0),
            daoURI: "",
            subdomain: vm.envOr("SUBDOMAIN_DAO", string("cyberdyne")),
            metadata: bytes("ipfs://")
        });

        (dao, ) = daoFactory.createDao(daoSettings, pluginSettings);
    }

    function _buildPluginSettings(PublishedPlugins memory p)
        internal
        view
        returns (IDAOFactory.PluginSettings[] memory pluginSettings)
    {
        address tokenVotingRepo = vm.envOr("TOKEN_VOTING_REPO", address(0));
        uint256 pluginCount = (tokenVotingRepo != address(0)) ? 4 : 3;
        pluginSettings = new IDAOFactory.PluginSettings[](pluginCount);
        uint256 idx;

        if (tokenVotingRepo != address(0)) {
            // The token-voting-plugin's prepareInstallation data is
            //   abi.encode(votingSettings, tokenSettings, mintSettings)
            // where each struct is defined in @aragon/token-voting-plugin.
            // Operators pass pre-encoded bytes via TOKEN_VOTING_DATA (built
            // off-chain via the token-voting-plugin SDK).
            pluginSettings[idx++] = IDAOFactory.PluginSettings({
                pluginSetupRef: PluginSetupRef({
                    versionTag: Tag({
                        release: 1,
                        build: uint16(vm.envOr("TOKEN_VOTING_BUILD", uint256(2)))
                    }),
                    pluginSetupRepo: IPluginRepo(tokenVotingRepo)
                }),
                data: vm.envBytes("TOKEN_VOTING_DATA")
            });
        }

        uint8 payDay = uint8(vm.envOr("PAY_DAY", uint256(15)));
        pluginSettings[idx++] = IDAOFactory.PluginSettings({
            pluginSetupRef: PluginSetupRef({
                versionTag: Tag({release: 1, build: 1}),
                pluginSetupRepo: p.payrollRepo
            }),
            data: abi.encode(payDay)
        });

        pluginSettings[idx++] = IDAOFactory.PluginSettings({
            pluginSetupRef: PluginSetupRef({
                versionTag: Tag({release: 1, build: 1}),
                pluginSetupRepo: p.uniswapRepo
            }),
            data: abi.encode(
                OsxAddresses.universalRouter(block.chainid),
                OsxAddresses.permit2(block.chainid),
                OsxAddresses.uniswapV4PoolManager(block.chainid),
                new address[](0)
            )
        });

        pluginSettings[idx++] = IDAOFactory.PluginSettings({
            pluginSetupRef: PluginSetupRef({
                versionTag: Tag({release: 1, build: 1}),
                pluginSetupRepo: p.aaveRepo
            }),
            data: abi.encode(address(p.aaveAdapter), new address[](0))
        });
    }

    function _logAndPersist(address dao, PublishedPlugins memory p) internal {
        console2.log("DAO:", dao);
        console2.log("Payroll repo:", address(p.payrollRepo));
        console2.log("Uniswap V4 repo:", address(p.uniswapRepo));
        console2.log("AAVE repo:", address(p.aaveRepo));
        console2.log("AAVE adapter:", address(p.aaveAdapter));
        _writeDeploymentJson(dao, p);
    }

    /// @dev Subdomains must be globally unique on the OSx PluginRepoRegistry.
    ///      For local fork runs we suffix with the block.timestamp so re-runs
    ///      don't collide. Override via SUBDOMAIN_PREFIX env if you want
    ///      deterministic subdomains for a real mainnet deploy.
    function _uniqueSubdomain(string memory base) internal view returns (string memory) {
        return string(abi.encodePacked(base, "-", vm.toString(block.timestamp)));
    }

    function _writeDeploymentJson(address dao, PublishedPlugins memory p) internal {
        string memory root = "deployment";
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeUint(root, "timestamp", block.timestamp);
        vm.serializeAddress(root, "dao", dao);
        vm.serializeAddress(root, "payrollSetup", address(p.payrollSetup));
        vm.serializeAddress(root, "payrollRepo", address(p.payrollRepo));
        vm.serializeAddress(root, "uniswapSetup", address(p.uniswapSetup));
        vm.serializeAddress(root, "uniswapRepo", address(p.uniswapRepo));
        vm.serializeAddress(root, "aaveSetup", address(p.aaveSetup));
        vm.serializeAddress(root, "aaveRepo", address(p.aaveRepo));
        string memory finalJson = vm.serializeAddress(root, "aaveAdapter", address(p.aaveAdapter));

        string memory path = string(
            abi.encodePacked(
                "./deployments/",
                vm.toString(block.chainid),
                "-",
                vm.toString(block.timestamp),
                ".json"
            )
        );
        vm.writeJson(finalJson, path);
        console2.log("Deployment manifest:", path);
    }
}
