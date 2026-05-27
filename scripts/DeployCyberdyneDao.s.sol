// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.17;

import {Script, console2} from "forge-std/Script.sol";

import {PayrollPluginSetup} from "../src/plugins/payroll/PayrollPluginSetup.sol";
import {UniswapV4PluginSetup} from "../src/plugins/uniswap-v4/UniswapV4PluginSetup.sol";
import {AaveLendingPluginSetup} from "../src/plugins/aave/AaveLendingPluginSetup.sol";
import {CostRegistryPluginSetup} from "../src/plugins/cost-registry/CostRegistryPluginSetup.sol";
import {UniswapV3PluginSetup} from "../src/plugins/uniswap-v3/UniswapV3PluginSetup.sol";
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
        IPluginRepo uniswapV3Repo;
        UniswapV3PluginSetup uniswapV3Setup;
    }

    /// @notice Installed plugin INSTANCE addresses (the proxies the DAO talks
    ///         to), captured from `DAOFactory.createDao`. These — not the repos
    ///         — are what the frontend / subgraph consume. `governance` is the
    ///         TokenVoting instance (address(0) if no repo was configured).
    struct Installed {
        address governance;
        address payroll;
        address uniswapV4;
        address aave;
        address costRegistry;
        address uniswapV3;
    }

    Installed public installed;

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

        p.uniswapV3Setup = new UniswapV3PluginSetup();
        p.uniswapV3Repo = pluginRepoFactory.createPluginRepoWithFirstVersion(
            _uniqueSubdomain("cyberdyne-uniswap-v3"),
            address(p.uniswapV3Setup),
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

        IDAOFactory.InstalledPlugin[] memory plugins;
        (dao, plugins) = daoFactory.createDao(daoSettings, pluginSettings);

        // Map installed instances by the SAME order _buildPluginSettings used:
        // [TokenVoting?], payroll, uniswapV4, aave, costRegistry, uniswapV3.
        bool hasTV = _resolveTokenVotingRepo() != address(0);
        uint256 i = hasTV ? 1 : 0;
        if (hasTV) installed.governance = plugins[0].plugin;
        installed.payroll = plugins[i++].plugin;
        installed.uniswapV4 = plugins[i++].plugin;
        installed.aave = plugins[i++].plugin;
        installed.costRegistry = plugins[i++].plugin;
        installed.uniswapV3 = plugins[i++].plugin;
    }

    /// @dev Single source of truth for whether/which TokenVoting repo is used,
    ///      so `_createDao`'s offset matches `_buildPluginSettings`.
    function _resolveTokenVotingRepo() internal view returns (address) {
        return vm.envOr("TOKEN_VOTING_REPO", OsxAddresses.tokenVotingRepo(block.chainid));
    }

    function _buildPluginSettings(
        PublishedPlugins memory p
    ) internal view returns (IDAOFactory.PluginSettings[] memory pluginSettings) {
        // Resolve the TokenVoting PluginRepo: explicit env override first,
        // else the per-chain value in OsxAddresses (address(0) = not yet
        // configured → TokenVoting is skipped, DAO is created with the 3
        // Cyberdyne plugins only).
        address tokenVotingRepo = _resolveTokenVotingRepo();
        // 5 Cyberdyne plugins (payroll, uniswap-v4, aave, cost-registry,
        // uniswap-v3) + optional TokenVoting.
        uint256 pluginCount = (tokenVotingRepo != address(0)) ? 6 : 5;
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
                OsxAddresses.uniswapV4PositionManager(block.chainid),
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

        // UniswapV3Plugin: full LP lifecycle via the V3 NonfungiblePositionManager.
        // Empty allowlist = no token restriction (turn on with a vote later).
        pluginSettings[idx++] = IDAOFactory.PluginSettings({
            pluginSetupRef: PluginSetupRef({
                versionTag: Tag({release: 1, build: 1}),
                pluginSetupRepo: p.uniswapV3Repo
            }),
            data: abi.encode(OsxAddresses.uniswapV3PositionManager(block.chainid), new address[](0))
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
        // VotingMode: 0 Standard (default — vote then a separate execute tx),
        // 1 EarlyExecution (execute as soon as the outcome is decided), 2
        // VoteReplacement. EarlyExecution is convenient for single-holder
        // testnet/demo DAOs where a passing vote should be executable at once.
        voting.votingMode = uint8(vm.envOr("VOTE_MODE", uint256(voting.votingMode)));

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
        console2.log("Uniswap V3 repo:", address(p.uniswapV3Repo));

        // Installed plugin INSTANCES — what the frontend PUBLIC_DAO_* env wants.
        console2.log("--- installed plugin instances ---");
        console2.log("governance (TokenVoting):", installed.governance);
        console2.log("payroll:", installed.payroll);
        console2.log("uniswapV4:", installed.uniswapV4);
        console2.log("aave:", installed.aave);
        console2.log("costRegistry:", installed.costRegistry);
        console2.log("uniswapV3:", installed.uniswapV3);
        // Ready-to-paste frontend env line:
        // PUBLIC_DAO_MAINNET=dao,payroll,uniswapV4,aave,governance,costRegistry,uniswapV3
        console2.log("PUBLIC_DAO line (dao,payroll,uniswapV4,aave,governance,costRegistry,uniswapV3):");
        console2.log(
            string(
                abi.encodePacked(
                    vm.toString(dao),
                    ",",
                    vm.toString(installed.payroll),
                    ",",
                    vm.toString(installed.uniswapV4),
                    ",",
                    vm.toString(installed.aave),
                    ",",
                    vm.toString(installed.governance),
                    ",",
                    vm.toString(installed.costRegistry),
                    ",",
                    vm.toString(installed.uniswapV3)
                )
            )
        );
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
        // Installed plugin INSTANCES (frontend/subgraph consume these).
        vm.serializeAddress(root, "governance", installed.governance);
        vm.serializeAddress(root, "payroll", installed.payroll);
        vm.serializeAddress(root, "uniswapV4", installed.uniswapV4);
        vm.serializeAddress(root, "aave", installed.aave);
        vm.serializeAddress(root, "costRegistry", installed.costRegistry);
        vm.serializeAddress(root, "uniswapV3", installed.uniswapV3);
        vm.serializeAddress(root, "payrollSetup", address(p.payrollSetup));
        vm.serializeAddress(root, "payrollRepo", address(p.payrollRepo));
        vm.serializeAddress(root, "uniswapSetup", address(p.uniswapSetup));
        vm.serializeAddress(root, "uniswapRepo", address(p.uniswapRepo));
        vm.serializeAddress(root, "aaveSetup", address(p.aaveSetup));
        vm.serializeAddress(root, "aaveRepo", address(p.aaveRepo));
        vm.serializeAddress(root, "aaveAdapter", address(p.aaveAdapter));
        vm.serializeAddress(root, "costRegistrySetup", address(p.costRegistrySetup));
        vm.serializeAddress(root, "costRegistryRepo", address(p.costRegistryRepo));
        vm.serializeAddress(root, "uniswapV3Setup", address(p.uniswapV3Setup));
        string memory finalJson = vm.serializeAddress(
            root,
            "uniswapV3Repo",
            address(p.uniswapV3Repo)
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
