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

## 3a. Concurrent v3 + v4 — multi-adapter registry (v1.1 design)

> **Status: design-only.** AAVE v4 is not live yet, so its Pool ABI and
> addresses aren't final and the v4 adapter bodies / fork tests can't be
> written. This section is the plan for letting the DAO hold **v3 and v4
> positions at the same time**; the routing infrastructure below is
> implementable and mock-testable today, the live v4 wiring lands when v4
> ships.

### Why the single-adapter model isn't enough

v1 stores **one** active `adapter`; `setAdapter` swaps it. That supports a
*migration* (all new ops move to the new version) but not *coexistence* —
you can't supply to v4 while a v3 position is still open, and you can't
`withdraw`/`repay` a v3 position once the adapter points at v4 (§3, §11).
Supporting both versions concurrently means routing each call to a chosen
adapter rather than a single global pointer.

### Design: an adapter registry + per-call selection

Replace the single `adapter` pointer with a small registry inside the
plugin (the `IAaveAdapter` interface itself is **unchanged** — it stays the
stateless calldata-builder, so `AaveV3Adapter` / `AaveV4Adapter` need no
edits):

```
mapping(uint256 => IAaveAdapter) public adapterOf;   // adapterId → adapter
uint256[] public adapterIds;                          // enumerable set
uint256 public defaultAdapterId;                      // used by no-id overloads
```

`adapterId` is a stable, explicit key (e.g. `uint256(keccak256("AAVE_V3"))`,
`…("AAVE_V4")`) so the subgraph can attribute every position to a protocol
version permanently.

**Vote-gated admin** (all under `UPDATE_ADAPTER_PERMISSION`):

| Function | Effect |
|---|---|
| `registerAdapter(uint256 id, IAaveAdapter a)` | Add an adapter to the set. |
| `deregisterAdapter(uint256 id)` | Remove it. Blocks *new* ops only; existing positions live on AAVE and stay readable/withdrawable by re-registering. |
| `setDefaultAdapter(uint256 id)` | Pick the adapter the back-compat overloads use. |

**Lending ops gain an adapter-selecting overload**, with the existing
signatures kept as thin wrappers over the default — so the current API,
tests, and frontend keep working unchanged:

```
function supply(uint256 adapterId, address asset, uint256 amount) external;
function supply(address asset, uint256 amount) external;   // → defaultAdapterId
// …same for withdraw / borrow / repay
```

This directly closes the two §11 limitations: `withdraw(v3Id, …)` winds
down a v3 position while `supply(v4Id, …)` opens a v4 one — both live at
once. The old migration-only `setAdapter` becomes sugar for
`registerAdapter + setDefaultAdapter`.

### What changes (and what doesn't)

- **Unchanged:** `IAaveAdapter`, both concrete adapters, the calldata-builder
  custody model (DAO still calls the Pool directly; plugin holds nothing),
  and the asset allowlist (asset addresses are identical across versions, so
  one allowlist covers all adapters).
- **New events:** `AdapterRegistered(id, adapter)`,
  `AdapterDeregistered(id)`, `DefaultAdapterUpdated(oldId, newId)`. The
  per-op events (`Supplied`/`Withdrawn`/`Borrowed`/`Repaid`) gain an
  `adapterId` (or indexed adapter address) so the indexer can split balances
  by version — **a subgraph schema change** to land with the refactor.
- **Storage / UUPS:** add the registry slots from `__gap` and, in the
  upgrade reinitializer, register the existing v3 adapter as `defaultAdapterId`
  so live positions carry over. Re-review the §8 storage-layout diff before
  shipping.

### Reads

Per-version position state stays on AAVE itself (the authoritative path):
`aToken.balanceOf(dao)` / variable-debt `balanceOf(dao)` /
`Pool.getUserAccountData(dao)` per registered pool. The `/lending` frontend
view iterates `adapterIds` and reads each pool.

### Sequencing + risk

Land the registry refactor in v1.1 (mock-tested with two `MockAavePool`s),
keep `AaveV4Adapter` a stub, then fill its bodies + fork-test when v4 is
live. **Risk (TRD §16 #1):** if v4's call shape diverges materially (the
announced GHO-native liquidity layer), `IAaveAdapter` may need a v2; the
registry still holds, but adapters of different interface versions would
need an interface-version tag.

## 3b. Governance-path: `preview…Actions` helpers

Each fund-moving entry (`supply`, `withdraw`, `borrow`, `repay`) ships a
`view` sibling that returns the exact `Action[]` the wrapper would forward
to `IExecutor.execute`. Governance proposals call the preview, then submit
the returned batch as a TokenVoting proposal so the outer `dao.execute`
runs the action batch directly — no nested `dao.execute`, no reentrancy
guard collision. See
[TRD §9a — Governance-path action builders](../TRD.md#9a-governance-path-action-builders-previewactions)
for the full pattern + rationale.

Helpers: `previewSupplyActions`, `previewWithdrawActions`,
`previewBorrowActions`, `previewRepayActions`. Admin ops (`setAdapter`,
`setAllowedAsset`) are single-call plugin mutators and need no preview.

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

- **Single active adapter — no concurrent v3 + v4, and adapter swap loses
  the `withdraw` path to legacy positions** (§3). v1.1 design: the
  multi-adapter registry in **§3a**, which adds per-call adapter selection
  (`supply(adapterId, …)` etc.) and lets the DAO operate both protocol
  versions at once.
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
