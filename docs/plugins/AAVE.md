# AaveLendingPlugin

Per-plugin spec for the Cyberdyne DAO AAVE lending plugin (TRD §6.2, ROADMAP P4).

| | |
|---|---|
| Source | `src/plugins/aave/AaveLendingPlugin.sol` |
| Setup | `src/plugins/aave/AaveLendingPluginSetup.sol` |
| Base | `PluginUUPSUpgradeable` (OSx commons v1.4) |
| Adapters | `adapters/AaveV3Adapter.sol`, `adapters/AaveV4Adapter.sol` (stub) |
| Pool interface | `adapters/IAavePool.sol` (inline, no aave-v3-origin submodule) |
| Permission IDs | `TRIGGER_LENDING_PERMISSION`, `UPDATE_ADAPTER_PERMISSION`, `MANAGE_ALLOWLIST_PERMISSION` |

## 1. What it does

- Vote-gated DAO `supply` / `withdraw` / `borrow` / `repay` against AAVE.
- Calls are routed through a pluggable `IAaveAdapter` so the same plugin can
  serve AAVE v3 today and AAVE v4 tomorrow via a single `setAdapter` vote.
- Asset allowlist gates which underlyings the DAO can touch. Enforcement
  flips on the first `setAllowedAsset(asset, true)` and stays on for the
  life of the plugin.
- Custody never sits on the plugin. `onBehalfOf = dao()` on every adapter
  call, so aTokens and debt tokens are issued directly to the DAO.

## 2. Trust + custody model

- Plugin holds **no funds**, no aTokens, no debt tokens. Everything lives
  on the DAO.
- Plugin is granted `EXECUTE_PERMISSION` on the DAO so it can issue
  `IExecutor.execute(callId, actions, 0)` batches that approve the pool
  and call the adapter in a single atomic step.
- Adapters are stateless and pass-through. `AaveV3Adapter` is just a thin
  wrapper over `IAavePool` — no storage, no owner, no upgrade path.
- Plugin upgrades require `UPGRADE_PLUGIN_PERMISSION` on the plugin,
  granted only to the DAO. UUPS via `_authorizeUpgrade` inherited from
  `PluginUUPSUpgradeable`.

## 3. Adapter pattern + v3 → v4 migration playbook

The adapter is a vote-controlled storage pointer. Swapping AAVE versions
is **one proposal**, not a redeploy:

1. Deploy the new adapter (e.g. `AaveV4Adapter` wrapping the AAVE v4 Pool).
2. Submit a proposal whose only action is
   `plugin.setAdapter(newAdapter)`.
3. Vote + execute. The `AdapterUpdated(old, new)` event fires; subsequent
   `supply` / `withdraw` / `borrow` / `repay` calls route through the new
   adapter.

**Legacy position handling (v1 limitation):** the old adapter remains
deployed and the legacy positions live on the AAVE protocol it pointed at.
Because the DAO is the holder of those aTokens / debt tokens, the AAVE
protocol itself remains the authoritative read path — anyone can call
`Pool.getReserveData` / `aToken.balanceOf(dao)` on the old version
directly.

What the plugin CANNOT do today after a swap: route a `withdraw` /
`repay` through the OLD adapter. To wind down a legacy position the DAO
either (a) temporarily votes the old adapter back in, withdraws, votes
the new one back; or (b) waits for the v1.1 "withdraw via specific
adapter" addition (TRD §16 #4). For v1 mainnet — fine: the v3 → v4
transition is years away and migration cadence is deliberately slow.

## 4. Allowance lifecycle

Each `supply` and `repay` builds a 2-action batch:

```
Action[0]: IERC20(asset).approve(adapter.poolAddress(), amount)
Action[1]: adapter.supply / adapter.repay (...)
```

The approval is for **exact-amount** (not `type(uint256).max`) and is
consumed by the pool's `transferFrom` inside the same `dao.execute`
call. Post-execute, the DAO's allowance to the pool is **0**. Unit test
`supply: DAO funds the adapter via approve+transferFrom and gets aTokens`
asserts this invariant.

`withdraw` and `borrow` don't need an approval — the pool pushes the
underlying to the DAO directly.

## 5. Borrow guardrail (v1 → v1.1)

- **v1 (today):** every `borrow` proposal must include a human-readable
  description of the post-borrow health factor target. Reviewers verify
  via `Pool.getUserAccountData(dao)` on a fork before voting. There is
  no on-chain guardrail.
- **v1.1 (planned, TRD §16 #1):** `BorrowHealthCondition` contract
  attached to `TRIGGER_LENDING_PERMISSION_ID` via
  `dao.grantWithCondition`. The condition reads
  `Pool.getUserAccountData(dao)` post-action and reverts the whole
  `dao.execute` if `healthFactor < minHealthFactor`. Drops reliance on
  reviewer attention.

## 6. Events (full table in `docs/EVENTS.md`)

| Event | Trigger | Indexed |
|---|---|---|
| `Supplied(asset, amount)` | `supply` | `asset` |
| `Withdrawn(asset, amount, received)` | `withdraw` | `asset` |
| `Borrowed(asset, amount, interestRateMode)` | `borrow` | `asset` |
| `Repaid(asset, amount, interestRateMode, paid)` | `repay` | `asset` |
| `AdapterUpdated(previous, current)` | `setAdapter` | `previous`, `current` |
| `AllowedAssetSet(asset, allowed)` | `setAllowedAsset` + init seed | `asset` |

`received` (Withdrawn) and `paid` (Repaid) are computed as the DAO's
balance delta — they reflect what the pool actually moved, which may be
less than the requested amount when the user passes `type(uint256).max`
or the pool partial-fills.

## 7. Call-id scheme

Each lending operation issues a unique `callId` to `IExecutor.execute`,
formed as `keccak256(tag || _opNonce)` where `_opNonce` is a strictly
increasing counter:

| Operation | Tag |
|---|---|
| `supply` | `"AAVE_SUPPLY:"` |
| `withdraw` | `"AAVE_WITHDRAW:"` |
| `borrow` | `"AAVE_BORROW:"` |
| `repay` | `"AAVE_REPAY:"` |

The subgraph can join the resulting `IDAO.Executed(callId, ...)` event to
the matching `Supplied` / `Withdrawn` / `Borrowed` / `Repaid` event by
walking the tx receipt — same pattern used in `docs/EVENTS.md` for
Uniswap and Payroll.

## 8. Storage layout (UUPS upgrade safety)

Layout snapshot at the current head is at
`docs/storage-layouts/AaveLendingPlugin.md` (regenerate via
`forge inspect AaveLendingPlugin storage-layout`). Plugin-specific state
starts at slot **301** (after the inherited gap chain):

```
slot 301: adapter (IAaveAdapter)
slot 302: allowedAsset (mapping)
slot 303: allowlistEnforced (bool)
slot 304: _opNonce (uint256)
slot 305..350: __gap[46]
```

Upgrades may consume slots from `__gap` (decreasing the gap size) but
must **never** reorder or shrink anything in slots 301..304. The `forge
inspect` snapshot is committed per release tag so audit can diff layouts
across versions.

## 9. Slither audit notes (waivers)

`slither src/plugins/aave/ --filter-paths "lib/|node_modules/|test/"`
produces these findings; each is reviewed and accepted:

| Finding | Location | Disposition |
|---|---|---|
| `unused-return` on `IExecutor.execute` | supply / withdraw / borrow / repay | Intentional. The execute return is `(execResults bytes[], failureMap uint256)`. We pass `allowFailureMap = 0` (every action must succeed), so a non-zero `failureMap` is impossible by construction, and the per-action results aren't needed — the plugin reads back via `IERC20.balanceOf(dao)` to compute `received` / `paid`. |
| `reentrancy-events` (event after external call) | supply / withdraw / borrow / repay | Accepted in our trust model. The only external call is to our own DAO. The DAO then calls AAVE; AAVE doesn't call us back. The event is emitted post-execute precisely so the `received` / `paid` field is the actual balance delta — not the input amount. The plugin holds no funds, so a hypothetical reentry through AAVE could not double-spend us. |
| `solc-version 0.8.17 has known severe issues` | every file | Accepted by project policy. TRD §3 pins `solc 0.8.17` to match the audited Aragon OSx v1.4.0 build verbatim. The three listed issues (VerbatimInvalidDeduplication, FullInlinerNonExpressionSplitArgumentEvaluationOrder, MissingSideEffectsOnSelectorAccess) don't affect our codebase — no inline assembly using `verbatim`, no inliner-sensitive expressions, no `.selector` usage on storage-loaded variables. |
| `naming-convention` on `_dao` / `_adapter` / `_initialAllowlist` / `__gap` / `POOL` | various | Intentional. Leading underscore on function parameters matches OSx upstream convention. `__gap` matches OpenZeppelin's upgradeable storage_gaps guide. `POOL` is uppercase per Solidity style for immutables. |
| `unused-state` on `__gap` | AaveLendingPlugin | Intentional. Reserves slots for future upgrades without breaking the storage layout (OZ upgrade-safety pattern). |

CI gate: `slither --fail-high`. None of the above are high-severity; this
list updates if the implementation changes.

## 10. Tests

- Unit: `test/plugins/aave/AaveLendingPlugin.unit.test.ts` — 29 cases.
  100% lines/branches on `AaveLendingPlugin.sol`, `AaveV3Adapter.sol`,
  and `AaveLendingPluginSetup.sol`. Drives the plugin via `MinimalDAO`
  and `MockAaveAdapter` (custody-faithful) plus the v3 wrapper against
  `MockAavePool` (signature-faithful).
- Fork: `test/plugins/aave/AaveLendingPlugin.fork.test.ts` — runs on
  `mainnetFork` and `baseFork` against the real AAVE v3 Pool. Covers
  supply / withdraw / borrow (WETH collateral → USDC) / repay /
  adapter migration. Skipped on the in-memory `hardhat` network via
  `onlyOn(["mainnetFork", "baseFork"], ...)`.
- Permission matrix: `test/plugins/PluginSetup.unit.test.ts` already
  asserts `prepareInstallation` returns the TRD §9 set verbatim.

## 11. Known limitations + future work

- **Adapter swap loses the `withdraw` path to legacy positions** — see
  §3. v1.1 candidate: `withdrawVia(adapter, asset, amount)` with the
  adapter passed explicitly.
- **No on-chain health-factor guardrail on `borrow`** — see §5. v1.1
  candidate: `BorrowHealthCondition`.
- **`interestRateMode` is passed through unchecked.** AAVE v3 has
  effectively removed stable-rate borrows on mainnet (legacy debt only).
  Validation belongs in the proposal review, not the plugin, so the
  plugin stays version-agnostic — a future AAVE rate-mode shape would
  break a baked-in check.
- **Allowlist enforcement is one-way.** Once `allowlistEnforced` flips
  true (first `setAllowedAsset(_, true)` or initial seed), it stays
  true. Disabling enforcement is a deliberate non-feature: v1.1 can ship
  a `disableAllowlist()` if real ops ever needs it.
