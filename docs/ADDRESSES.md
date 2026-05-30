# External Address Book

Canonical contract addresses the Cyberdyne DAO deploy + plugins depend on, per
network. **Source of truth in-repo:**

- **Aragon OSx core** — `lib/osx/packages/artifacts/src/addresses.json` (Aragon's
  upstream artifacts).
- **Plugins' external deps** (Uniswap / Aave / USDC) and the TokenVoting repo —
  `scripts/lib/OsxAddresses.sol` (used by `DeployCyberdyneDao.s.sol`) and
  `test/helpers/addresses.ts` (used by the fork tests).

> **Repo support status.** `OsxAddresses.sol` only configures the protocol/USDC
> addresses for **Ethereum mainnet (1)** and **Base (8453)** (plus Sepolia /
> Base-Sepolia for OSx core). **Arbitrum (42161) is NOT yet wired** — Aragon OSx
> is deployed there, but a `DeployCyberdyneDao` run on Arbitrum reverts
> `UnsupportedChain` until a `chainId == 42161` branch is added to
> `OsxAddresses.sol` with the Uniswap/Aave/USDC values below. The Arbitrum rows
> here are verified from official sources (Uniswap docs, Aave address-book) to
> make adding that branch a copy-paste.

> **Verify-before-mainnet flags (carried from the repo's own TODOs):**
> - **Universal Router** has been redeployed historically; confirm on
>   `developers.uniswap.org` before a real deploy. `setUniversalRouter` is the
>   vote-gated fix path.
> - **TokenVoting PluginRepo** is published by a separate Aragon repo (not the
>   OSx core artifacts) and must be verified per chain via the on-chain
>   `PluginRepoRegistry` "token-voting" subdomain. Only mainnet is hardcoded.

---

## Aragon OSx core

| Contract | Ethereum (1) | Base (8453) | Arbitrum (42161) |
|---|---|---|---|
| DAOFactory | `0x246503df057A9a85E0144b6867a828c99676128B` | `0xcc602EA573a42eBeC290f33F49D4A87177ebB8d2` | `0x49e04AB7af7A263b8ac802c1cAe22f5b4E4577Cd` |
| DAORegistry | `0x7a62da7B56fB3bfCdF70E900787010Bc4c9Ca42e` | `0xeB98a71d69a1e12B62c10368D9dA5364CE0f7178` | `0xB5146Fd572C669ABC353902e43F47fda4609E38A` |
| PluginRepoFactory | `0xcf59C627b7a4052041C4F16B4c635a960e29554A` | `0xAAAb8c6b83a5C7b1462af4427d97b33197388C38` | `0x7F5F2BB64efD9c542F26ABa34D59e1895FcDF69D` |
| PluginRepoRegistry | `0x5B3B36BdC9470963A2734D6a0d2F6a64C21C159f` | `0xB5eB5C011827C9F5787ceE3Abc72d247E36a5a0D` | `0xCe0B4124dea6105bfB85fB4461c4D39f360E9ef3` |
| PluginSetupProcessor | `0xE978942c691e43f65c1B7c7F8f1dc8cDF061B13f` | `0x91a851E9Ed7F2c6d41b15F76e4a88f5A37067cC9` | `0x308a1DC5020c4B5d992F5543a7236c465997fecB` |
| Executor | `0x56ce4D8006292Abf418291FaE813C1E3769240A4` | `0x304eBcA6a98F3a2d4424388814ddbFf8904Bd1cE` | `0x198b64a53b39f454e56626d9262cBf67E7C13138` |
| Management DAO | `0x58C1F7Bc62Bb63fb137bc8F6d8ea6321a0501d29` | `0xBeb2271224D22BdA388B513268873387E5BfC27f` | `0xc3F1f4d3B4E24b6F019120205e12A01D733BEb55` |
| **TokenVoting PluginRepo** | `0xb7401cD221ceAFC54093168B814Cc3d42579287f` | ⚠️ verify (not in repo) | ⚠️ verify (not in repo) |

## Uniswap V3 + V4

| Contract | Consumed by | Ethereum (1) | Base (8453) | Arbitrum (42161) |
|---|---|---|---|---|
| V3 NonfungiblePositionManager | UniswapV3Plugin | `0xC36442b4a4522E871399CD717aBDD847Ab11FE88` | `0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1` | `0xC36442b4a4522E871399CD717aBDD847Ab11FE88` |
| V4 PoolManager | UniswapV4Plugin | `0x000000000004444c5dc75cB358380D2e3dE08A90` | `0x498581fF718922c3f8e6A244956aF099B2652b2b` | `0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32` |
| V4 PositionManager | UniswapV4Plugin (LP) | `0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e` | `0x7C5f5A4bBd8fD63184577525326123B519429bDc` | `0xd88F38F930b7952f2DB2432Cb002E7abbF3dD869` |
| Universal Router | UniswapV4Plugin (swap) | `0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af` | `0x6fF5693b99212Da76ad316178A184AB56D299b43` | `0xA51afAFe0263b40EdaEf0Df8781eA9aa03E381a3` |
| Permit2 | V3 + V4 plugins | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| V4 StateView (read-only)¹ | frontend / off-chain | `0x7fFE42C4a5DEeA5b0feC41C94C136Cf115597227` | `0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71` | `0x76Fd297e2D437cd7f76d50F01AfE6160f86e9990` |

- Permit2 is the **same canonical address on every EVM chain**.
- ¹ StateView is not consumed by the on-chain plugins; it's a V4 read helper some
  UI/quote paths use. Mainnet/Base values are from Uniswap's deployment docs and
  are **not** in the repo address book — supply via env if a read path needs it.

## Aave

| Contract | Ethereum (1) | Base (8453) | Arbitrum (42161) |
|---|---|---|---|
| Aave **v3** Pool | `0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2` | `0xA238Dd80C259a72e81d7e4664a9801593F98d1c5` | `0x794a61358D6845594F94dc1DB02A252b5b4814aD` |
| Aave **v3** PoolAddressesProvider | `0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e` | `0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D` | `0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb` |
| Aave **v4** | — not deployed — | — not deployed — | — not deployed — |

> **Aave v4 is not live on any network.** The plugin's adapter pattern
> (`AaveV3Adapter` / `AaveV4Adapter`) lets the DAO swap the adapter via a single
> vote when v4 ships — no plugin redeploy. There is no v4 address to list yet.

## Tokens (treasury funding / CostRegistry payment token)

| Token | Ethereum (1) | Base (8453) | Arbitrum (42161) |
|---|---|---|---|
| USDC | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` |
| WETH | `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` | `0x4200000000000000000000000000000000000006` | `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1` |

> Arbitrum USDC is **native** USDC (`0xaf88…5831`), not bridged USDC.e.

---

## Adding Arbitrum support (checklist)

1. Add a `chainId == 42161` branch to each resolver in `scripts/lib/OsxAddresses.sol`
   (`daoFactory`, `pluginRepoFactory`, `usdc`, `aaveV3Pool`, `universalRouter`,
   `permit2`, `uniswapV4PoolManager`, `uniswapV3PositionManager`,
   `uniswapV4PositionManager`) using the values above.
2. Add an `arbitrum` entry to `EXTERNAL` in `test/helpers/addresses.ts`.
3. Verify + hardcode (or pass via `TOKEN_VOTING_REPO`) the Arbitrum TokenVoting
   PluginRepo from the on-chain `PluginRepoRegistry` "token-voting" subdomain.
4. Add an `arbitrumFork` Hardhat network + run the fork suite against it before
   any real deploy.

## Sources

- Aragon OSx core: `lib/osx/packages/artifacts/src/addresses.json` (in-repo).
- Uniswap V4 + Universal Router + StateView: <https://developers.uniswap.org/contracts/v4/deployments>
- Uniswap V3 NonfungiblePositionManager: <https://developers.uniswap.org/contracts/v3/reference/deployments/arbitrum-deployments>
- Aave v3: <https://github.com/aave-dao/aave-address-book> (`src/AaveV3Arbitrum.sol`)
