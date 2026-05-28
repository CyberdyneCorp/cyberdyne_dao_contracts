# Proposed Slither waiver-table additions

Drift surfaced by [`02b-slither-vs-waivers.md`](./02b-slither-vs-waivers.md): three Medium-severity detectors fire today but aren't yet in the per-plugin waiver tables. The patterns are the same false-positives already waived elsewhere in the project. Proposed dispositions below — copy-paste into the appropriate `docs/plugins/<PLUGIN>.md` waiver table as part of the per-plugin internal review (P8 Phase B).

Low / Informational drift (`cyclomatic-complexity`, `missing-zero-check`, `calls-loop`, `solc-version`) is **not** an exit-criteria gate (the gate is "zero unresolved high/medium") but is listed at the end for completeness.

---

## Medium-severity additions (gate-affecting)

### PayrollPlugin

Add to `docs/plugins/PAYROLL.md` §9 waiver table:

| Finding | Location | Disposition |
|---|---|---|
| `incorrect-equality` on period strict-equality | `_runPayroll` (`_cursorPeriod == currentPeriod`), `_calcBountyAmount` (`_bountyAccumPeriod == currentPeriod`) | Intentional. The comparison is against a discrete uint period counter (a `year*12+month` index), not a wall-clock timestamp. Period identity *is* the semantic check ("did the cursor land on this exact month?"); a `>=` would be wrong because the cursor must reset when the period rolls over. The detector flags strict equality as a timestamp-jitter risk, which doesn't apply to a calendar period number. |

### UniswapV4Plugin

Add to `docs/plugins/UNISWAP_V4.md` §9 waiver table:

| Finding | Severity | Location | Disposition |
|---|---|---|---|
| `uninitialized-local` on loop counter `k` | Medium | `_enforceOutputs` / `_snapshotBalances` | False positive. The counter defaults to 0 in Solidity; this is the idiomatic write-cursor pattern into a freshly-allocated memory array, identical to Payroll's `count` / `j` and similarly waived. |

### CostRegistryPlugin

Add to `docs/plugins/COST_REGISTRY.md` §8 waiver table:

| Finding | Location | Disposition |
|---|---|---|
| `uninitialized-local` on cursor `count` | `_processDue` | False positive. Standard Solidity zero-default for a write cursor; the variable is written before it's read. Same pattern as Payroll's documented `uninitialized-local` waiver. |

---

## Low / Informational additions (cosmetic, not gate-blocking)

These can be added in the same pass for completeness, but don't block P8 closure.

### PayrollPlugin

| Finding | Location | Disposition |
|---|---|---|
| `missing-zero-check` on `token` param | `setAmount` / `addRecipient` | Accepted. `address(0)` is the documented sentinel for native ETH (TRD §6.1); the zero-address branch is the intended ETH code path, not a missing check. |
| `cyclomatic-complexity` on `_runPayroll` | `_runPayroll` | Accepted. Function aggregates the page/full crank, per-recipient failure tolerance, bounty bookkeeping, and the cursor advance — splitting would obscure the effects-before-interactions ordering the reentrancy waiver depends on. |

### UniswapV4Plugin

| Finding | Severity | Location | Disposition |
|---|---|---|---|
| `calls-loop` | Low | `_enforceOutputs`, `_snapshotBalances` | Accepted. The bounded loop iterates `outputCurrencies` / `inputCurrencies` arrays sized by the proposal's own input (max O(n) per LP op). The external call inside is to known ERC20s in the allowlist, not user-controlled code. |

### UniswapV3Plugin, AaveLendingPlugin, CostRegistryPlugin

| Finding | Severity | Location | Disposition |
|---|---|---|---|
| `solc-version` `0.8.17` | Informational | — | Intentional. Project-wide pin to `0.8.17` for Cancun-safe deployment to mainnet/Base/Sepolia (PUSH0 + selfdestruct semantics). Matches OSx framework version. |
| `unused-state` on `__gap` | Informational | — | Intentional. Reserves storage slots for future upgrades (OZ upgrade-safety pattern). Already documented for Payroll / V4 / AAVE — propagate same disposition to V3 + CostRegistry. |

---

## Summary

- **Medium drift to waive**: 3 detectors across 3 plugins (PayrollPlugin, UniswapV4Plugin, CostRegistryPlugin).
- **Low/Info drift**: 4 cosmetic additions across 4 plugins, optional.
- **Code changes needed**: None — every drift item is a documented false-positive pattern already waived in adjacent plugins, just not yet propagated.

Once these rows are merged into the plugin docs, the P8 exit criterion **"Zero unresolved high/medium Slither findings"** is satisfied.
