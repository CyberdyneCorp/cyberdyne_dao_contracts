# UniswapV3Plugin

Per-plugin spec for the Cyberdyne DAO UniswapV3Plugin — vote-gated management of
the DAO's Uniswap V3 liquidity positions (full lifecycle).

| | |
|---|---|
| Source | `src/plugins/uniswap-v3/UniswapV3Plugin.sol` |
| Setup | `src/plugins/uniswap-v3/UniswapV3PluginSetup.sol` |
| Base | `PluginUUPSUpgradeable` (OSx commons v1.4) |
| Permission ID | `MANAGE_POSITIONS_PERMISSION` |
| Manages | Uniswap V3 NonfungiblePositionManager (NPM) |

## 1. What it does

Through a DAO vote, the plugin runs the whole Uniswap V3 position lifecycle:

- `mint` — open a new position; the NFT is minted **to the DAO**.
- `increaseLiquidity` — add to an existing DAO-owned position.
- `decreaseLiquidity` — remove liquidity (freed tokens become collectable).
- `collect` — pull owed tokens (fees + decreased liquidity) **to the DAO**.
- `burn` — close an empty position.

Plus vote-gated admin: `setPositionManager` (NPM migration) and
`setAllowedToken` (optional token allowlist, off by default).

## 2. Trust + custody model

Same calldata-builder / no-custody pattern as `AaveLendingPlugin` (see
`docs/plugins/AAVE.md §2-3`):

- The plugin holds **no tokens and no position NFTs**. It builds an `Action[]`
  and the **DAO executes** it (`IExecutor.execute`), so `msg.sender` at the NPM
  is the DAO. Positions are minted with `recipient = dao()`, and `collect`'s
  recipient is forced to the DAO — an NFT or collected tokens can never be
  routed elsewhere.
- The DAO owns the position NFT, so it is `msg.sender`-authorized for
  `decreaseLiquidity` / `collect` / `burn` with no extra approval.
- Plugin holds `EXECUTE_PERMISSION` on the DAO; mutations + manager + allowlist
  + upgrades are gated on the DAO (i.e. a passed proposal).

## 3. Allowance lifecycle

`mint` and `increaseLiquidity` pull tokens from the DAO, so each builds:

```
approve(token0, NPM, amount0Desired)
approve(token1, NPM, amount1Desired)
NPM.mint / NPM.increaseLiquidity
approve(token0, NPM, 0)   ← reset
approve(token1, NPM, 0)   ← reset
```

Exact-amount approvals reset to zero in the same batch, so no DAO→NPM allowance
ever lingers (enforced by `invariant_zeroResidualAllowance`).
`decreaseLiquidity` / `collect` / `burn` move nothing in and need no approvals.

## 3a. Governance-path: `preview…Actions` helpers

Each fund-moving entry point ships a `view` sibling that returns the exact
`Action[]` the wrapper would forward to `IExecutor.execute`. Governance
proposals call the preview, then submit the returned batch as a TokenVoting
proposal so the outer `dao.execute` runs the action batch directly — no nested
`dao.execute`, no reentrancy guard collision. See
[TRD §9a — Governance-path action builders](../TRD.md#9a-governance-path-action-builders-previewactions)
for the full pattern + rationale.

Helpers: `previewMintActions`, `previewIncreaseLiquidityActions`,
`previewDecreaseLiquidityActions`, `previewCollectActions`,
`previewBurnActions`. Admin ops (`setPositionManager`, `setAllowedToken`) are
single-call mutators and need no preview.

## 4. tokenId surfacing

`mint` decodes the NPM return from the executor's `execResults` to emit the new
`tokenId` in `PositionMinted` — so indexers/UI learn the id without scanning NFT
`Transfer` logs. `increaseLiquidity` / `collect` likewise decode their amounts.

## 5. ETH handling

ERC20-only. To use ETH in a position, wrap it to WETH first (a `WETH.deposit`
action in the same proposal); the plugin never holds a payable surface.

## 6. Events (full table in `docs/EVENTS.md`)

| Event | Trigger | Indexed |
|---|---|---|
| `PositionMinted(tokenId, token0, token1, fee, liquidity, amount0, amount1)` | `mint` | `tokenId`, `token0`, `token1` |
| `LiquidityIncreased(tokenId, liquidity, amount0, amount1)` | `increaseLiquidity` | `tokenId` |
| `LiquidityDecreased(tokenId, liquidity)` | `decreaseLiquidity` | `tokenId` |
| `FeesCollected(tokenId, amount0, amount1)` | `collect` | `tokenId` |
| `PositionBurned(tokenId)` | `burn` | `tokenId` |
| `PositionManagerUpdated(previous, current)` | `setPositionManager` | both |
| `AllowedTokenSet(token, allowed)` | `setAllowedToken` + init seed | `token` |

## 7. Storage layout (UUPS upgrade safety)

Snapshot at `docs/storage-layouts/UniswapV3Plugin.md`. Plugin state starts at
slot **301**: `positionManager` (301), `allowedToken` mapping (302),
`allowlistEnforced` (303), `_opNonce` (304), then `__gap[46]`. Upgrades may
consume from `__gap` but must never reorder 301..304.

## 8. Slither audit notes (waivers)

| Finding | Location | Disposition |
|---|---|---|
| `unused-return` on `IExecutor.execute` | mint/increase/collect | Intentional — only the decoded amounts / failureMap are needed. |
| `reentrancy-events` | all ops | Accepted: the only external call is to our own DAO; OSx `DAO.execute` is `nonReentrant`. |
| `timestamp` (deadline compare) | mint/increase/decrease | Design intent — Uniswap deadlines are timestamp-based. |
| `naming-convention` `_dao`/`__gap` | various | OSx project convention. |
| `solc-version` `0.8.17` | all files | Intentional. Project-wide pin to `0.8.17` for Cancun-safe deployment to mainnet / Base / Sepolia (matches OSx framework version). |
| `unused-state` on `__gap` | UniswapV3Plugin | Intentional. Reserves slots for future upgrades without breaking the storage layout (OZ upgrade-safety pattern). |

CI gate: `slither --fail-high`. None high-severity.

## 9. Tests

- Unit: `test/plugins/uniswap-v3/UniswapV3Plugin.unit.test.ts` — 14 cases vs a
  `MockNonfungiblePositionManager` (mint/increase/decrease/collect/burn,
  allowlist, custody, deadline, manager update, permission gating). ≥90%
  coverage (lines 93.75% / branches 90.63%).
- Invariant: `test/invariants/UniswapV3.invariant.t.sol` — plugin holds no
  tokens/ETH, zero residual allowance, opNonce monotonic.
- Fork: `test/plugins/uniswap-v3/UniswapV3Plugin.fork.test.ts` — 6 cases
  against the canonical NPM on mainnet-state forks (`mainnetFork` and
  `localFork`): mint a real USDC/WETH position, `increaseLiquidity` grows
  it, `decreaseLiquidity + collect` returns funds to the DAO, `burn`
  removes the NFT, deadline-expired guard reverts, and allowlist
  enforcement rejects non-listed live tokens.
- Permission matrix: `test/plugins/PluginSetup.unit.test.ts` — 5-grant install
  set (EXECUTE, MANAGE_POSITIONS, UPDATE_POSITION_MANAGER, MANAGE_ALLOWLIST,
  UPGRADE_PLUGIN).
