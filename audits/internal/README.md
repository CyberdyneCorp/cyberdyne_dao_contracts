# P8 Phase A — mechanical pre-work for the internal review

This folder holds the artifacts produced by the P8 closeout pre-work — every check that can be run against the code without human judgment. Phase B (per-plugin signed review checklists under `docs/reviews/`) builds on top of these.

Generated against HEAD on 2026-05-28 (Payroll's `description` extension —
`setRecipientDescription` + `RecipientDescriptionSet` event refreshed in
this run).

## Artifacts

| # | File | What it covers |
|---|---|---|
| 1 | [`01-storage-layouts.md`](./01-storage-layouts.md) | Forge `storage-layout` regenerated for all 5 plugins; compared against `docs/storage-layouts/<plugin>.md`. |
| 2 | [`02-slither.md`](./02-slither.md) | Slither sweep per plugin, severity counts. |
| 2 | [`02b-slither-vs-waivers.md`](./02b-slither-vs-waivers.md) | Cross-check of current Slither output against the documented waiver tables. |
| 2 | [`02c-proposed-waiver-additions.md`](./02c-proposed-waiver-additions.md) | Proposed rows to add to each plugin's waiver table to close the drift. |
| 2 | `slither-<plugin>.{txt,json}` | Raw Slither output per plugin (5 plugins × 2 formats). |
| 3 | [`03-coverage.md`](./03-coverage.md) | Per-plugin coverage breakdown from `npx hardhat coverage` against the 90 % gate. |
| 4 | [`04-test-quality.md`](./04-test-quality.md) | Scan for `vm.skip` / `.only` / `.skip` / commented-out tests / `TODO|FIXME|XXX`. |
| 5 | [`05-functions-events.md`](./05-functions-events.md) | Every external function + event in each plugin's ABI cross-referenced against test files. |

## Headline results

### Exit criteria status (P8)

| Gate | Status | Note |
|---|---|---|
| Zero unresolved High Slither findings | ✅ | 0 across all 5 plugins. |
| Zero unresolved Medium Slither findings | ⚠ **partial** | All Medium findings are false-positive patterns; **3 categories aren't yet in the per-plugin waiver tables** — see [`02c-proposed-waiver-additions.md`](./02c-proposed-waiver-additions.md). One-pass doc update closes this. |
| Invariant tests pass over ≥ 50,000 fuzz runs in CI | ✅ | 25/25 invariants on 50k sequences (existing). |
| Threat model reviewed and merged | ⚠ paperwork | File exists at `docs/THREAT_MODEL.md`; needs a signed acknowledgement in Phase B. |
| ≥ 2 contributors signed off per plugin | 🔴 not started | Empty `docs/reviews/`. Phase B work. |

### Code-side findings (real, small, surface during review)

- **UniswapV3Plugin**: 3 test-coverage gaps (1 unreferenced preview helper, 1 unasserted view getter, 1 unasserted event) — see [`05-functions-events.md`](./05-functions-events.md). Each is a <10-line test addition.
- **Slither waivers**: 3 Medium-severity detectors fire today but aren't in the waiver tables (PayrollPlugin `incorrect-equality`, UniswapV4Plugin + CostRegistryPlugin `uninitialized-local`). All same-pattern false-positives already waived elsewhere. Drop-in copy from [`02c-proposed-waiver-additions.md`](./02c-proposed-waiver-additions.md).
- **Coverage gate**: `scripts/check-coverage.js` enforces only 3 plugin paths; UniswapV3Plugin and CostRegistryPlugin coverage is computed but ungated. Two-line `ENFORCED` array update.

### Done in Phase A (no follow-up needed)

- Storage-layout snapshots: zero drift.
- Test-quality scan: 0 `.only` / 0 `vm.skip` / 0 `.skip` / 0 commented-out tests; 0 TODOs in `src/`; 1 TODO in `test/helpers/addresses.ts:72` (Universal Router pre-mainnet verification — already known).
- New standalone deploy scripts created: `scripts/DeployUniswapV3Plugin.s.sol`, `scripts/DeployCostRegistryPlugin.s.sol` (compiled, mirror the 3 existing scripts).

## What Phase B does on top of this

For each of the 5 plugins, two reviewers fill in a copy of [`docs/INTERNAL_REVIEW_CHECKLIST.md`](../../docs/INTERNAL_REVIEW_CHECKLIST.md) and drop it under `docs/reviews/<plugin>-<reviewer>-<YYYY-MM-DD>.md`. The mechanical boxes are pre-verifiable from this folder; the subjective ones (spec alignment, fund-flow review, external-protocol assumptions, etc.) need a human.

Suggested PR sequence:

1. Apply `02c-proposed-waiver-additions.md` to the 5 plugin docs.
2. Fix the 3 V3 test gaps in `05-functions-events.md`.
3. Extend `scripts/check-coverage.js` ENFORCED to include V3 + CostRegistry.
4. Open the 5 review PRs (10 files total, one per reviewer per plugin) referencing this commit.
