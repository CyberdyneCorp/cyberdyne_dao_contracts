# Internal Review Checklist

Per-plugin signoff template. Each plugin requires **two contributors** to complete the checklist before the plugin enters the external audit scope (ROADMAP P8 → P9).

Each reviewer fills in one column. Disagreements are resolved by a third reviewer or the author. Findings that don't fit the checklist go in the "Other findings" section at the end with a tracking issue link.

---

## How to use

1. Copy this file to `docs/reviews/<plugin>-<reviewer>-<YYYY-MM-DD>.md`.
2. Mark every box: `[x]` pass, `[!]` finding (write up below), `[-]` not applicable.
3. Sign off with your handle + commit hash you reviewed.
4. PR adds the file under `docs/reviews/`. Merge once both reviewers' files exist for the plugin.

---

## Per-plugin checklist

**Plugin under review:** `<PayrollPlugin | UniswapV4Plugin | AaveLendingPlugin>`
**Reviewer:** `<handle>`
**Commit hash:** `<sha>`
**Date:** `<YYYY-MM-DD>`

### 1. Specification alignment

- [ ] Plugin implements every external function listed in TRD §6.{1,2,3}
- [ ] Every event in TRD §6 (and `docs/EVENTS.md`) is emitted at the right point (after state change, before external call where possible)
- [ ] Every `auth(PERMISSION_ID)` modifier maps to a permission listed in TRD §9
- [ ] No undocumented external functions or events
- [ ] Storage layout (`docs/storage-layouts/<plugin>.md`) matches the implementation; `__gap` size correct

### 2. Custody + fund flow

- [ ] Plugin has **no** `receive()`, no `fallback()`, no payable functions other than what spec requires
- [ ] Every fund movement goes through `IExecutor(dao()).execute(...)`; plugin never calls `IERC20.transfer` / `.transferFrom` directly
- [ ] Adapter / router approvals are exact-amount (not `type(uint256).max`)
- [ ] Residual allowances are zeroed (or proven to be drained by the external call); enforced by invariant test
- [ ] `onBehalfOf = dao()` (or equivalent) on every external protocol call that issues receipts (aTokens, debt tokens, LP tokens)

### 3. Access control

- [ ] Every state-changing function except the documented permissionless ones has `auth(...)`
- [ ] Permissionless functions are explicitly listed in `docs/plugins/<plugin>.md`; their authorization rationale is documented
- [ ] `PluginSetup.prepareInstallation` returns exactly the §9 permission set (not more, not less); verified by `test/plugins/PluginSetup.unit.test.ts`
- [ ] `prepareUninstallation` produces the exact inverse (all `Revoke`)
- [ ] `prepareUpdate` for build N either implements a real upgrade path or reverts `InvalidUpdatePath(fromBuild, thisBuild)`

### 4. UUPS upgrade safety

- [ ] Inherits `PluginUUPSUpgradeable`; `initialize` is `initializer`-guarded
- [ ] Constructor of the impl is empty / `_disableInitializers()` only
- [ ] Storage layout snapshot in `docs/storage-layouts/<plugin>.md` matches current code (regenerate with `forge inspect <Plugin> storage-layout`)
- [ ] `__gap` reserves enough slots for at least one future state variable per plugin field
- [ ] No `selfdestruct`, `delegatecall` to untrusted targets, or `assembly` blocks (or if present, each one is justified and reviewed)

### 5. External protocol assumptions

- [ ] Every assumption about the external protocol's behavior is stated in code comment OR `docs/plugins/<plugin>.md` (e.g. "AAVE.repay caps at outstanding debt", "Universal Router consumes the full Permit2 allowance")
- [ ] Each assumption has a corresponding invariant or fork test that would catch a violation
- [ ] Adapter pattern (where present) keeps the plugin agnostic to the protocol version

### 6. Tests

- [ ] Unit tests cover every external function (happy + at least one revert path)
- [ ] Unit tests cover every event (assertion on args + indexed params)
- [ ] Unit tests cover every permission grant (positive: succeeds with permission; negative: reverts without)
- [ ] Fork tests exercise the plugin against the REAL external protocol on mainnet + base
- [ ] Coverage gate `scripts/check-coverage.js` passes at ≥90% on the plugin's path
- [ ] Foundry invariant tests cover the no-custody invariant + plugin-specific invariants; pass at CI profile (50k sequences)
- [ ] No `vm.skip`, `it.only`, `it.skip` (without explicit deferred-to-Pn comment), or commented-out tests

### 7. Slither

- [ ] `slither src/plugins/<plugin>/ --filter-paths "lib/|node_modules/|test/" --fail-high` exits 0
- [ ] Every info/low/medium finding is triaged in `docs/plugins/<plugin>.md §9` with disposition (false positive / design intent / accepted with reasoning / fixed)
- [ ] No medium or high findings remain unaddressed

### 8. Deploy scripts

- [ ] `scripts/Deploy<Plugin>.s.sol` exists and compiles
- [ ] Script reads addresses from `scripts/lib/OsxAddresses.sol` (no inline addresses except in `OsxAddresses.sol` itself)
- [ ] Script logs the resulting addresses via `console2.log`
- [ ] Bootstrap script (`DeployCyberdyneDao.s.sol`) integrates the plugin into the all-in-one ceremony correctly

### 9. Documentation

- [ ] `docs/plugins/<plugin>.md` is current (all sections populated, no stale references)
- [ ] `docs/EVENTS.md` entry matches the plugin's emitted events 1:1
- [ ] `docs/THREAT_MODEL.md` references the plugin where relevant; new attack vectors discovered during review are added
- [ ] `docs/storage-layouts/<plugin>.md` regenerated and matches HEAD

### 10. Other findings (non-checklist)

Anything notable that doesn't fit a box above. Each finding gets a one-line summary + severity + tracking issue link.

| # | Summary | Severity | Tracking issue |
|---|---|---|---|

---

**Signoff**

I have reviewed the commit above against this checklist. Every checked box is verified; every unchecked / `[!]` box is explained either in §10 or in the linked issue.

— `<handle>` on `<YYYY-MM-DD>`
