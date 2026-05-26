# UniswapV4Plugin

Per-plugin spec for the Cyberdyne DAO UniswapV4Plugin (TRD §6.1, ROADMAP P3).

| | |
|---|---|
| Source | `src/plugins/uniswap-v4/UniswapV4Plugin.sol` |
| Setup | `src/plugins/uniswap-v4/UniswapV4PluginSetup.sol` |
| Base | `PluginUUPSUpgradeable` (OSx commons v1.4) |
| Permission IDs | `TRIGGER_SWAP_PERMISSION`, `UPDATE_ROUTER_PERMISSION`, `MANAGE_ALLOWLIST_PERMISSION` |
| External integrations | Uniswap Universal Router (V4-capable), Permit2, Uniswap V4 PoolManager |

## 1. What it does

- Routes DAO-approved swaps through Uniswap's **Universal Router** using **Permit2** for token approvals.
- Plugin is **a pure execution gate** — it never custodies funds. `tokenIn` is debited from the DAO and `tokenOut` lands in the DAO.
- Every swap proposal carries opaque `commands` + `inputs` bytes (Universal Router command set) — the plugin doesn't decode them. The proposal builder owns route construction; the plugin owns slippage + allowlist + deadline + the 3-action approve/Permit2/route batch.
- Allowlist optional: empty at install = no token restriction; non-empty flips `allowlistEnforced = true` and gates `tokenIn` + `tokenOut` against the list per swap.

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

`callId = keccak256(abi.encodePacked("UNI_V4_SWAP:", swapNonce))` with `swapNonce` incremented on every successful swap (after the `callId` is built). This makes the `IExecutor.Executed` callId **unique per swap**, even within the same block, so the subgraph correlates `SwapExecuted ↔ Executed` 1:1 without ambiguity.

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
slot 301: universalRouter   (address)
slot 302: permit2           (address)
slot 303: poolManager       (address)
slot 304: allowedToken      (mapping)
slot 305: allowlistEnforced (bool)
slot 306: swapNonce         (uint256)
slot 307..350: __gap[44]
```

Upgrades may consume slots from `__gap` (decreasing the gap size) but must **never** reorder or shrink anything in slots 301..306. The `forge inspect` snapshot is committed under `docs/storage-layouts/` per release tag so audit can diff layouts across versions. Note: the gap is `[44]`, not `[45]` as in the P1 stub, because `swapNonce` (slot 306) consumed one slot.

## 11. Tests

- **Unit**: `test/plugins/uniswap-v4/UniswapV4Plugin.unit.test.ts` — 21 cases. 100% line + 100% branch coverage on `src/plugins/uniswap-v4/UniswapV4Plugin.sol` and `UniswapV4PluginSetup.sol`. Uses `MockUniversalRouter` + `MockPermit2` under `src/test/mocks/` to exercise the full action batch + Permit2 → Router settlement path without an RPC.
- **Fork**: `test/plugins/uniswap-v4/UniswapV4Plugin.fork.test.ts` — runs on `mainnetFork` and `baseFork` when `RPC_MAINNET` / `RPC_BASE` are set. Gated via `onlyOn(...)`; silently skipped on other networks. Uses the V3 `SWAP_EXACT_IN_SINGLE` Universal Router command for the happy path (deepest/most-stable liquidity); the V4-native single-hop encoding is deferred to P5's e2e tests via a flagged `it.skip` and a clear comment in the test preamble.
- **Permission matrix**: `test/plugins/PluginSetup.unit.test.ts` — asserts `prepareInstallation` returns the TRD §9 set verbatim.
