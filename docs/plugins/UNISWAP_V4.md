# UniswapV4Plugin

Per-plugin spec for the Cyberdyne DAO UniswapV4Plugin (TRD §6.1, ROADMAP P3).

| | |
|---|---|
| Source | `src/plugins/uniswap-v4/UniswapV4Plugin.sol` |
| Setup | `src/plugins/uniswap-v4/UniswapV4PluginSetup.sol` |
| Base | `PluginUUPSUpgradeable` (OSx commons v1.4) |
| Permission IDs | `TRIGGER_SWAP_PERMISSION`, `UPDATE_ROUTER_PERMISSION`, `MANAGE_ALLOWLIST_PERMISSION`, `MANAGE_POSITIONS_PERMISSION` |
| External integrations | Uniswap Universal Router (V4-capable), Permit2, Uniswap V4 PoolManager, **v4-periphery PositionManager** |

## 1. What it does

- Routes DAO-approved **swaps** through Uniswap's **Universal Router** using **Permit2** for token approvals.
- Drives the **full V4 LP lifecycle** (mint / increase / decrease / burn / collect) through the **v4-periphery PositionManager** via a single pass-through `modifyLiquidities` entry — see §3a.
- Plugin is **a pure execution gate** — it never custodies funds. `tokenIn` / input currencies are debited from the DAO; `tokenOut` / output currencies / position NFTs land in the DAO.
- Every swap proposal carries opaque `commands` + `inputs` bytes (Universal Router command set); every LP proposal carries opaque `unlockData` bytes (v4 action stream). The plugin doesn't decode them — the proposal builder owns route/action construction; the plugin owns slippage + allowlist + deadline + the surrounding approve/Permit2/reset batch.
- Allowlist optional: empty at install = no token restriction; non-empty flips `allowlistEnforced = true` and gates `tokenIn` + `tokenOut` (swap) and every input/output currency (LP) against the list per op.

## 2. Trust + custody model

- Plugin holds **no funds** before, during, or after a swap. All ERC20 lives in the DAO.
- DAO grants the plugin `EXECUTE_PERMISSION` so the plugin's `IExecutor.execute(callId, actions, 0)` batch moves DAO treasury through approve → Permit2 → router.
- All vote-gated mutators (`swap`, `setUniversalRouter`, `setAllowedToken`) require permissions granted only to the DAO at install; proposals are the only way to reach them.
- Plugin upgrades require `UPGRADE_PLUGIN_PERMISSION` on the plugin, granted only to the DAO. UUPS via `_authorizeUpgrade` inherited from `PluginUUPSUpgradeable`.

## 3. Swap path (TRD §6.1)

`swap(commands, inputs, deadline, tokenIn, amountIn, tokenOut, minAmountOut)`:

1. **Deadline guard.** `if (block.timestamp > deadline) revert DeadlineExpired()`.
2. **Allowlist gate.** If `allowlistEnforced`, both `tokenIn` and `tokenOut` must be in `allowedToken`.
3. **Snapshot `tokenOut` balance** on the DAO (`balanceBefore`).
4. **Build a 3-action `Action[]` batch:**
   1. `IERC20(tokenIn).approve(permit2, amountIn)` — exact-amount ERC20 allowance, DAO → Permit2.
   2. `IPermit2.approve(tokenIn, universalRouter, uint160(amountIn), uint48(deadline))` — Permit2's internal allowance, expires at deadline.
   3. `IUniversalRouter.execute(commands, inputs, deadline)` — router executes the proposal's commands.
5. **Submit via `IExecutor.execute(callId, actions, 0)`** with `allowFailureMap = 0` (any sub-action revert reverts the whole batch).
6. **Compute slippage.** `received = IERC20(tokenOut).balanceOf(dao) - balanceBefore`; revert `SlippageExceeded(received, minAmountOut)` if short.
7. **Emit `SwapExecuted(tokenIn, amountIn, tokenOut, received)`**.

### Why `callId` includes a nonce

`callId = keccak256(abi.encodePacked("UNI_V4_SWAP:", swapNonce))` with `swapNonce` incremented on every successful swap (after the `callId` is built). This makes the `IExecutor.Executed` callId **unique per swap**, even within the same block, so the subgraph correlates `SwapExecuted ↔ Executed` 1:1 without ambiguity. LP ops use a parallel scheme `keccak256("UNI_V4_LP:" || lpNonce)` so swap and LP histories don't alias.

## 3a. LP lifecycle — `modifyLiquidities` pass-through

V4 LP (mint / increase / decrease / burn) routes through **a single entry point**:

```
function modifyLiquidities(
    bytes calldata unlockData,
    uint256 deadline,
    address[] calldata inputCurrencies,
    uint256[] calldata maxIn,
    address[] calldata outputCurrencies,
    uint256[] calldata minOut
) external auth(MANAGE_POSITIONS_PERMISSION_ID)
```

The proposal builds the **v4 action stream** off-chain (Uniswap SDK) and forwards `unlockData = abi.encode(bytes actions, bytes[] params)` verbatim. Each byte in `actions` is one entry from the v4-periphery `Actions` enum (`MINT_POSITION=0x02`, `INCREASE_LIQUIDITY=0x00`, `DECREASE_LIQUIDITY=0x01`, `BURN_POSITION=0x03`, `SETTLE_PAIR=0x0d`, `TAKE_PAIR=0x11`), and `params[i]` is the abi-encoded args for action `i`.

**Action batch shaped by the plugin** for any LP op:

```
for each input currency i:
  1. DAO → Permit2:               IERC20(currency).approve(permit2, maxIn[i])         // exact
  2. Permit2 → PositionManager:   IPermit2.approve(currency, PM, maxIn[i], deadline)
then:
  3.                              IV4PositionManager.modifyLiquidities(unlockData, deadline)
finally, for each input currency i:
  4. DAO → Permit2:               IERC20(currency).approve(permit2, 0)                // reset
```

The whole batch is sent through `IExecutor.execute(callId, actions, allowFailureMap=0)`. Any sub-action failure reverts the full batch — no half-finished state, no lingering allowance.

**Output slippage guard.** Before the call, the plugin snapshots the DAO's balance of every `outputCurrencies[i]`; after the call, it asserts `received_i = balanceAfter_i - balanceBefore_i ≥ minOut[i]` (reverts `OutputShortfall` otherwise). This is the V4-LP analogue of the swap path's `minAmountOut` check.

**Position NFTs.** The position NFT is minted to whichever `owner` the proposal encodes in `MINT_POSITION` params. **The plugin decodes `unlockData` defensively and reverts `MintRecipientMustBeDao(encodedOwner, dao)` if any `MINT_POSITION` action carries a non-DAO owner** — proposal review no longer has to catch this. Both `modifyLiquidities` and `previewModifyLiquiditiesActions` run the check, so a malformed proposal fails to build the action batch in the first place. An empty/too-short `unlockData` payload reverts `UnlockDataTooShort` with a clear reason rather than an opaque abi-decode error.

**Why pass-through.** V4 LP ops are intentionally compositional: a single `modifyLiquidities` can chain MINT/INCREASE/DECREASE/SETTLE/TAKE actions, with hooks. Forcing the plugin to expose one signature per combination would multiply the surface area without buying more safety — every code path already routes back through `DAO.execute`, so allowlist + slippage are the meaningful guardrails. Same model the swap path already uses for `commands`/`inputs`.

**Set the PositionManager.** v4PositionManager may be `address(0)` at install (LP ops revert `PositionManagerUnset` until set). Call the vote-gated `setV4PositionManager(address)` to wire it — reuses `UPDATE_ROUTER_PERMISSION` (both router and PM are external Uniswap endpoints) so the install grant list stays at 6.

### `previewModifyLiquiditiesActions(...) view returns (Action[])`

Every fund-moving entry point on this plugin (`swap`, `modifyLiquidities`) ships a sibling `view` helper that returns the exact `Action[]` the wrapper would forward to `IExecutor.execute`. Governance proposals call that helper, then submit the returned batch as a TokenVoting proposal so the outer `dao.execute` runs the action batch directly — no nested `dao.execute`, no reentrancy guard collision. See [TRD §9a — Governance-path action builders](../TRD.md#9a-governance-path-action-builders-previewactions) for the full pattern and rationale.

Helpers exposed: `previewSwapActions`, `previewModifyLiquiditiesActions`. Admin ops (`setUniversalRouter`, `setV4PositionManager`, `setAllowedToken`) don't need preview helpers — they're single-call mutators on the plugin itself, callable as a one-action proposal directly.

## 4. Allowance lifecycle (TRD §11 security note)

The plugin approves **exactly `amountIn`** to Permit2, not `type(uint256).max`. After the Universal Router pulls `amountIn` via Permit2 during step 4.iii of the batch, the DAO's ERC20 allowance to Permit2 lands at **zero**.

The fork test `UniswapV4Plugin.fork.test.ts` explicitly asserts `IERC20.allowance(dao, PERMIT2) == 0` after a successful swap. Anyone wishing to audit this can reproduce locally against the pinned block.

Permit2's internal allowance (the second-layer approval set in step 4.ii) is time-bounded to `deadline` and naturally expires; it doesn't matter what value it leaves behind on Permit2 itself because that allowance scope is `(tokenIn, router)` keyed and the router only acts on calldata it receives in `execute`.

## 5. Allowlist semantics

- **Empty allowlist at install** → `allowlistEnforced = false`. Any token pair is fair game (proposal review is the only gate).
- **Non-empty initial list** → `allowlistEnforced = true` from genesis; init seeds every entry and emits one `AllowedTokenSet(token, true)` per entry.
- **`setAllowedToken(token, true)` for the first time** (when `allowlistEnforced == false`) flips enforcement on. **The flag never flips back** — auditors flagged "implicit un-enforcement on next empty allowlist" as a footgun, so once turned on, enforcement is sticky and only DAO upgrade can change the contract code.
- `setAllowedToken(token, false)` removes an entry but does NOT turn enforcement off.

## 6. Universal Router migration

`setUniversalRouter(newRouter)` (vote-gated via `UPDATE_ROUTER_PERMISSION`) replaces the stored router address and emits `UniversalRouterUpdated(previous, current)`. The plugin makes **no assumption** about the router's command set version, so swapping from a V3-era router to a V4-capable one (or to a future revision) requires no plugin upgrade — only a vote on the new address. The proposal builder then encodes commands compatible with the new router.

## 7. Deadline + slippage guards

Two independent guards:

1. **`deadline` (proposal-supplied)** — front-loaded check (`block.timestamp > deadline`). Also flows into the Permit2 expiration field and the router's own `execute(commands, inputs, deadline)` call (which re-checks).
2. **`minAmountOut` (proposal-supplied)** — checked AFTER the router runs, by reading the DAO's tokenOut balance pre/post. This catches any router-side weirdness (partial fills, fee surprises, MEV sandwich tightness) that the router's own min-out doesn't surface. The router's internal min-out is set to a sentinel by the proposal builder (we use 0 in fork tests) precisely because the plugin's check is the authoritative one.

## 8. Events (full table in `docs/EVENTS.md`)

| Event | Trigger | Indexed |
|---|---|---|
| `SwapExecuted(tokenIn, amountIn, tokenOut, amountOutActual)` | `swap` | `tokenIn`, `tokenOut` |
| `AllowedTokenSet(token, allowed)` | `initialize` (per seed), `setAllowedToken` | `token` |
| `UniversalRouterUpdated(previous, current)` | `setUniversalRouter` | `previous`, `current` |
| `V4PositionManagerUpdated(previous, current)` | `setV4PositionManager` | `previous`, `current` |
| `LiquidityModified(opNonce)` | `modifyLiquidities` | `opNonce` |

## 9. Slither audit notes (waivers)

`slither src/plugins/uniswap-v4/ --filter-paths "lib/|node_modules/|test/"` produces these findings; each is reviewed and accepted:

| Finding | Severity | Location | Disposition |
|---|---|---|---|
| `reentrancy-balance` | High | `swap` | **Suppressed via `// slither-disable-next-line reentrancy-balance` at the function declaration.** The balance-before / balance-after delta is the slippage guard mandated by TRD §6.1. OSx `DAO.execute` is `nonReentrant` (TRD §11), so re-entry into `swap` during the `IExecutor.execute` external call is structurally impossible. Even if the router credited the DAO extra `tokenOut` during the call (which would itself be a router bug), the slippage check would still pass against the proposal's `minAmountOut` — it's never used to debit anything, only to gate the revert. |
| `reentrancy-events` | Low | `swap` | Suppressed alongside `reentrancy-balance`. The only external call is to our own DAO (`nonReentrant`); event emit-after-call is the correct order because we need the post-call `received` value in the event payload. |
| `unused-return` | Medium | `IExecutor.execute` in `swap` | Intentional. `swap` uses `allowFailureMap = 0`, so any per-action failure already reverts the whole batch — we have no use for the returned `execResults` bytes or the `failureMap` bitmap. |
| `missing-zero-check` (×4) | Low | `initialize` (`_universalRouter`, `_permit2`, `_poolManager`), `setUniversalRouter` (`newRouter`) | Accepted. Zero-address would simply make every swap revert during the action batch (`ERC20.approve(0x0, …)` reverts, `Permit2.approve(0x0, …)` reverts on the Permit2 side, router call to `0x0` returns success on a non-contract so the balance check then reverts with `SlippageExceeded(0, minAmountOut)`). No funds at risk; misconfiguration surfaces immediately on the first swap attempt. The DAO vote that supplies these addresses is the canonical gate. |
| `timestamp` | Low | `block.timestamp > deadline` in `swap` | Design intent. The deadline guard is by definition timestamp-driven (Uniswap, Permit2, and the Universal Router all use the same comparison internally). Miner timestamp jitter (±15 s on Ethereum, ~2 s on Base) is negligible at the proposal-deadline granularity we expect (minutes to tens of minutes). |
| `solc-version` | Informational | all files | Pinned to `0.8.17` to match Aragon OSx v1.4.0 audited build verbatim (TRD §3). The known compiler issues at this version don't affect any code path we use. |
| `naming-convention` (multiple) | Informational | leading-underscore params, `__gap` | Intentional. Matches OSx's project-wide convention of leading-underscore for function parameters and double-underscore for inherited gaps (per OpenZeppelin's upgradeable storage-gaps guide). |
| `unused-state` | Informational | `__gap` | Intentional. Reserves slots for future upgrades without breaking storage layout (OZ upgrade-safety pattern). |

CI gate: `slither --fail-high`. With the inline suppressions above, the remaining findings are all Medium-or-below and the gate passes (`exit=0`). The waiver list updates if the implementation changes.

## 10. Storage layout (UUPS upgrade safety)

Layout snapshot at the current head is at `docs/storage-layouts/UniswapV4Plugin.md` (regenerate via `forge inspect UniswapV4Plugin storage-layout`). Plugin-specific state starts at slot **301** (after the inherited gap chain):

```
slot 301: universalRouter    (address)
slot 302: permit2            (address)
slot 303: poolManager        (address)
slot 304: allowedToken       (mapping)
slot 305: allowlistEnforced  (bool)
slot 306: swapNonce          (uint256)
slot 307: v4PositionManager  (address)   — added with the V4 LP extension
slot 308: lpNonce            (uint256)   — added with the V4 LP extension
slot 309..350: __gap[42]
```

Upgrades may consume slots from `__gap` (decreasing the gap size) but must **never** reorder or shrink anything in slots 301..308. The `forge inspect` snapshot is committed under `docs/storage-layouts/` per release tag so audit can diff layouts across versions. The gap shrank from `[44]` to `[42]` because `v4PositionManager` and `lpNonce` each consumed one slot (append-only).

## 11. Tests

- **Unit**: `test/plugins/uniswap-v4/UniswapV4Plugin.unit.test.ts` — 30 cases (21 swap + 9 LP). 100% line / 95.24% branch coverage on `src/plugins/uniswap-v4/UniswapV4Plugin.sol`. Uses `MockUniversalRouter` + `MockPermit2` + `MockV4PositionManager` to exercise the full action batch + Permit2 settlement without an RPC. LP suite covers `setV4PositionManager`, `PositionManagerUnset`, deadline/length-mismatch guards, allowlist on both input + output currencies, the post-call `OutputShortfall` slippage guard, and the independent `lpNonce` (separate from `swapNonce`).
- **Fork**: `test/plugins/uniswap-v4/UniswapV4Plugin.fork.test.ts` — runs on `mainnetFork` and `baseFork` when `RPC_MAINNET` / `RPC_BASE` are set. Gated via `onlyOn(...)`; silently skipped on other networks. Uses the V3 `SWAP_EXACT_IN_SINGLE` Universal Router command for the happy path (deepest/most-stable liquidity); the V4-native single-hop encoding + a live LP-mint fork test are deferred behind a flagged `it.skip` until the v4 PositionManager + v4 PoolManager pool with adequate liquidity at the pinned block is staked out.
- **Invariant**: `test/invariants/UniswapV4.invariant.t.sol` — 6 invariants. Swap-era (5): no `tokenIn`/`tokenOut`/ETH custody on the plugin, zero residual DAO→Permit2 allowance, `swapNonce` monotonic. LP-era (1): `lpNonce` monotonic in its own counter space. Handler exercises both `swap` and `modifyLiquidities` (random pull/push legs); the existing custody + zero-allowance invariants automatically apply to the LP code path.
- **Permission matrix**: `test/plugins/PluginSetup.unit.test.ts` — asserts `prepareInstallation` returns the **6**-grant set (EXECUTE / TRIGGER_SWAP / UPDATE_ROUTER / MANAGE_ALLOWLIST / UPGRADE_PLUGIN / MANAGE_POSITIONS).
