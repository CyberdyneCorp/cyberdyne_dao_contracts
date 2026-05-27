// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.17;

/// @title OsxAddresses
/// @notice Per-chain address book for OSx framework + external protocols used
///         by the Cyberdyne DAO bootstrap. Mirrors `test/helpers/addresses.ts`
///         on the Solidity side so deploy scripts don't have to parse JSON.
///
///         OSx addresses are copied verbatim from
///         `lib/osx/packages/artifacts/src/addresses.json` (the upstream source
///         of truth). External-protocol addresses match TRD §10.
/// @dev    Reverts `UnsupportedChain` if called from a chain we haven't
///         configured. Add a branch when a new chain enters scope.
library OsxAddresses {
    error UnsupportedChain(uint256 chainId);

    /// @dev A local anvil/hardhat fork of mainnet reports chainId 31337 but
    ///      holds real mainnet state at mainnet addresses. Resolve it to the
    ///      mainnet (chainId 1) address set so `just fork-local` deploys work.
    function _canonical(uint256 chainId) private pure returns (uint256) {
        return chainId == 31337 ? 1 : chainId;
    }

    function daoFactory(uint256 chainId) internal pure returns (address) {
        chainId = _canonical(chainId);
        if (chainId == 1) return 0x246503df057A9a85E0144b6867a828c99676128B; // mainnet
        if (chainId == 8453) return 0xcc602EA573a42eBeC290f33F49D4A87177ebB8d2; // base
        if (chainId == 11155111) return 0xB815791c233807D39b7430127975244B36C19C8e; // sepolia
        if (chainId == 84532) return 0x016CBa9bd729C30b16849b2c52744447767E9dab; // baseSepolia
        revert UnsupportedChain(chainId);
    }

    function pluginRepoFactory(uint256 chainId) internal pure returns (address) {
        chainId = _canonical(chainId);
        // Mirrors `pluginRepoFactory` entries in npm-artifacts/src/addresses.json.
        if (chainId == 1) return 0xcf59C627b7a4052041C4F16B4c635a960e29554A;
        if (chainId == 8453) return 0xAAAb8c6b83a5C7b1462af4427d97b33197388C38;
        if (chainId == 11155111) return 0x399Ce2a71ef78bE6890EB628384dD09D4382a7f0;
        if (chainId == 84532) return 0xD8Cc78EDB894ff93d757cCa481D2B43b5445E2aE;
        revert UnsupportedChain(chainId);
    }

    function usdc(uint256 chainId) internal pure returns (address) {
        chainId = _canonical(chainId);
        // Payment token for the CostRegistry plugin. Mirrors the USDC entries
        // in npm-artifacts/src/addresses.json / build-addresses.js.
        if (chainId == 1) return 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48; // mainnet
        if (chainId == 8453) return 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913; // base
        revert UnsupportedChain(chainId);
    }

    function aaveV3Pool(uint256 chainId) internal pure returns (address) {
        chainId = _canonical(chainId);
        // TRD §10. Testnets don't run AAVE — set explicitly when needed.
        if (chainId == 1) return 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2; // mainnet
        if (chainId == 8453) return 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5; // base
        revert UnsupportedChain(chainId);
    }

    function universalRouter(uint256 chainId) internal pure returns (address) {
        chainId = _canonical(chainId);
        // TRD §10 marks this TBD; pinned here from docs.uniswap.org deployments.
        // TODO: verify before mainnet deploy — Universal Router has been
        // redeployed historically and our `setUniversalRouter` is the migration
        // path if Uniswap ships another revision.
        if (chainId == 1) return 0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af; // mainnet
        if (chainId == 8453) return 0x6fF5693b99212Da76ad316178A184AB56D299b43; // base
        revert UnsupportedChain(chainId);
    }

    function permit2(uint256 chainId) internal pure returns (address) {
        // Permit2 is the same canonical address on every EVM chain.
        (chainId);
        return 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    }

    function uniswapV4PoolManager(uint256 chainId) internal pure returns (address) {
        chainId = _canonical(chainId);
        if (chainId == 1) return 0x000000000004444c5dc75cB358380D2e3dE08A90; // mainnet
        if (chainId == 8453) return 0x498581fF718922c3f8e6A244956aF099B2652b2b; // base
        revert UnsupportedChain(chainId);
    }

    /// @notice TokenVoting plugin `PluginRepo` address per chain.
    /// @dev    Returns `address(0)` ("not configured") for every chain by
    ///         default. The TokenVoting repo is published by the SEPARATE
    ///         `aragon/token-voting-plugin` repo — its addresses are NOT in
    ///         the OSx core `npm-artifacts/addresses.json` we mirror elsewhere
    ///         in this file, and they must be VERIFIED against each target
    ///         chain before use (the build pinned at the repo determines the
    ///         install-data ABI — see TokenVotingParams.sol).
    ///
    ///         Resolution order in DeployCyberdyneDao:
    ///           1. `TOKEN_VOTING_REPO` env var (explicit override), else
    ///           2. this function's return (hardcode verified values below).
    ///
    ///         Sources to verify from:
    ///           - github.com/aragon/token-voting-plugin (deployments)
    ///           - the "aragon/osx-artifacts" npm package / Aragon's registry
    ///           - on-chain: PluginRepoRegistry events for the "token-voting"
    ///             subdomain on the target chain
    function tokenVotingRepo(uint256 chainId) internal pure returns (address) {
        // TODO(P11): fill in + VERIFY per chain before testnet/mainnet deploy.
        // Left as address(0) deliberately — fabricating an unverified address
        // here is worse than an honest "not configured" that the deploy script
        // treats as "skip TokenVoting" (or requires the env override).
        (chainId);
        return address(0);
    }
}
