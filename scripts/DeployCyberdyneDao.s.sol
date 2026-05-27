// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.17;

import {Script, console2} from "forge-std/Script.sol";

import {PayrollPluginSetup} from "../src/plugins/payroll/PayrollPluginSetup.sol";
import {UniswapV4PluginSetup} from "../src/plugins/uniswap-v4/UniswapV4PluginSetup.sol";
import {AaveLendingPluginSetup} from "../src/plugins/aave/AaveLendingPluginSetup.sol";
import {CostRegistryPluginSetup} from "../src/plugins/cost-registry/CostRegistryPluginSetup.sol";
import {AaveV3Adapter} from "../src/plugins/aave/adapters/AaveV3Adapter.sol";
import {IAavePool} from "../src/plugins/aave/adapters/IAavePool.sol";

import {IDAOFactory, IPluginRepo, IPluginRepoFactory, PluginSetupRef, Tag} from "./lib/IOsxFramework.sol";
import {OsxAddresses} from "./lib/OsxAddresses.sol";
import {TokenVotingParams} from "./lib/TokenVotingParams.sol";

/// @title DeployCyberdyneDao
/// @notice One-ceremony bootstrap per TRD §8 + ROADMAP P5.
///         Phase 1: publish 3 PluginRepos (Payroll, Uniswap V4, AAVE).
///         Phase 2: DAOFactory.createDao installs all 3 in a single tx.
///         Phase 3: writes deployments/<chain>-<timestamp>.json with every
///                  resulting address for the frontend repo to consume.
///
/// @dev    TokenVoting is installed as plugins[0] when a PluginRepo address
///         resolves (env `TOKEN_VOTING_REPO`, else `OsxAddresses.tokenVotingRepo`).
///         Its install data is built with TYPED params via TokenVotingParams
///         (no more raw pre-encoded bytes) — voting settings + a fresh
///         GovernanceERC20 allocation, overridable by env. If no repo address
///         resolves, the DAO is created with the 3 Cyberdyne plugins only.
///
///         > ONE VERIFICATION STEP REMAINS: the per-chain TokenVoting repo
///         > address in OsxAddresses.tokenVotingRepo is address(0) until
///         > verified against each target chain (the published address +
///         > pinned build determine the install-data ABI). Until then, pass
///         > a verified address via TOKEN_VOTING_REPO. See ROADMAP P11.
///
///         Run example (anvil fork of mainnet, with TokenVoting):
///         ```
///         export PAY_DAY=15 SUBDOMAIN_DAO=cyberdyne
///         export TOKEN_VOTING_REPO=0x...          # verified repo for this chain
///         export GOV_TOKEN_HOLDER=0xYourTestSigner
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
        IPluginRepo costRegistryRepo;
        CostRegistryPluginSetup costRegistrySetup;
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
        IPluginRepoFactory pluginRepoFactory = IPluginRepoFactory(
            OsxAddresses.pluginRepoFactory(block.chainid)
        );

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

        p.costRegistrySetup = new CostRegistryPluginSetup();
        p.costRegistryRepo = pluginRepoFactory.createPluginRepoWithFirstVersion(
            _uniqueSubdomain("cyberdyne-cost-registry"),
            address(p.costRegistrySetup),
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

    function _buildPluginSettings(
        PublishedPlugins memory p
    ) internal view returns (IDAOFactory.PluginSettings[] memory pluginSettings) {
        // Resolve the TokenVoting PluginRepo: explicit env override first,
        // else the per-chain value in OsxAddresses (address(0) = not yet
        // configured → TokenVoting is skipped, DAO is created with the 3
        // Cyberdyne plugins only).
        address tokenVotingRepo = vm.envOr(
            "TOKEN_VOTING_REPO",
            OsxAddresses.tokenVotingRepo(block.chainid)
        );
        // 4 Cyberdyne plugins (payroll, uniswap, aave, cost-registry) + optional TokenVoting.
        uint256 pluginCount = (tokenVotingRepo != address(0)) ? 5 : 4;
        pluginSettings = new IDAOFactory.PluginSettings[](pluginCount);
        uint256 idx;

        if (tokenVotingRepo != address(0)) {
            pluginSettings[idx++] = IDAOFactory.PluginSettings({
                pluginSetupRef: PluginSetupRef({
                    versionTag: Tag({
                        release: 1,
                        build: uint16(vm.envOr("TOKEN_VOTING_BUILD", uint256(3)))
                    }),
                    pluginSetupRepo: IPluginRepo(tokenVotingRepo)
                }),
                data: _tokenVotingInstallData()
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

        // CostRegistry pays recurring operating costs in USDC. Token override
        // via COST_USDC (testnets without canonical USDC), else per-chain default.
        address costUsdc = vm.envOr("COST_USDC", OsxAddresses.usdc(block.chainid));
        pluginSettings[idx++] = IDAOFactory.PluginSettings({
            pluginSetupRef: PluginSetupRef({
                versionTag: Tag({release: 1, build: 1}),
                pluginSetupRepo: p.costRegistryRepo
            }),
            data: abi.encode(costUsdc)
        });
    }

    /// @dev Build the TokenVoting `prepareInstallation` payload from env (or
    ///      testnet defaults). Mints a fresh GovernanceERC20 allocated to the
    ///      deployer unless overridden.
    ///
    ///      Env overrides:
    ///        GOV_TOKEN_NAME / GOV_TOKEN_SYMBOL — token identity
    ///        GOV_TOKEN_HOLDER / GOV_TOKEN_SUPPLY — single-holder allocation
    ///        VOTE_SUPPORT / VOTE_PARTICIPATION (ppm), VOTE_DURATION (seconds)
    ///
    ///      For a multi-holder genesis or per-mainnet voting params, edit this
    ///      function directly — the env path is the fast testnet route.
    ///      See the Governance Token Spec note for the parameter rationale.
    function _tokenVotingInstallData() internal view returns (bytes memory) {
        TokenVotingParams.VotingSettings memory voting = TokenVotingParams
            .defaultTestnetVotingSettings();
        voting.supportThreshold = uint32(
            vm.envOr("VOTE_SUPPORT", uint256(voting.supportThreshold))
        );
        voting.minParticipation = uint32(
            vm.envOr("VOTE_PARTICIPATION", uint256(voting.minParticipation))
        );
        voting.minDuration = uint64(vm.envOr("VOTE_DURATION", uint256(voting.minDuration)));

        TokenVotingParams.TokenSettings memory token = TokenVotingParams.TokenSettings({
            addr: address(0), // mint a fresh GovernanceERC20
            name: vm.envOr("GOV_TOKEN_NAME", string("Cyberdyne Governance")),
            symbol: vm.envOr("GOV_TOKEN_SYMBOL", string("CYBR"))
        });

        address[] memory receivers = new address[](1);
        receivers[0] = vm.envOr("GOV_TOKEN_HOLDER", msg.sender);
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = vm.envOr("GOV_TOKEN_SUPPLY", uint256(1_000_000 ether));
        TokenVotingParams.MintSettings memory mint = TokenVotingParams.MintSettings({
            receivers: receivers,
            amounts: amounts
        });

        return TokenVotingParams.encodeInstallData(voting, token, mint);
    }

    function _logAndPersist(address dao, PublishedPlugins memory p) internal {
        console2.log("DAO:", dao);
        console2.log("Payroll repo:", address(p.payrollRepo));
        console2.log("Uniswap V4 repo:", address(p.uniswapRepo));
        console2.log("AAVE repo:", address(p.aaveRepo));
        console2.log("AAVE adapter:", address(p.aaveAdapter));
        console2.log("Cost registry repo:", address(p.costRegistryRepo));
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
        vm.serializeAddress(root, "aaveAdapter", address(p.aaveAdapter));
        vm.serializeAddress(root, "costRegistrySetup", address(p.costRegistrySetup));
        string memory finalJson = vm.serializeAddress(
            root,
            "costRegistryRepo",
            address(p.costRegistryRepo)
        );

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
