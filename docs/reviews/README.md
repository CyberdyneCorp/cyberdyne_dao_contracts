# Internal security reviews (Phase 8)

Per-plugin sign-off records for the Cyberdyne DAO plugins. This is the **P8 exit gate**: every plugin needs **two independent contributor approvals** (the second reviewer must not be the primary author) before the code enters the external audit (P9, [`audits/external/SCOPE.md`](../../audits/external/SCOPE.md)).

These templates are deliberately not pre-signed — they are filled in by reviewers against a frozen commit. The supporting evidence each reviewer leans on lives in [`audits/internal/`](../../audits/internal/): Slither runs + waivers, storage layouts, coverage, test-quality, and functions/events audits.

## Review status

| Plugin | Reviewer 1 | Reviewer 2 | Status |
|--------|-----------|-----------|--------|
| [PayrollPlugin](PayrollPlugin.md) | _pending_ | _pending_ | ☐ |
| [UniswapV4Plugin](UniswapV4Plugin.md) | _pending_ | _pending_ | ☐ |
| [UniswapV3Plugin](UniswapV3Plugin.md) | _pending_ | _pending_ | ☐ |
| [AaveLendingPlugin](AaveLendingPlugin.md) | _pending_ | _pending_ | ☐ |
| [CostRegistryPlugin](CostRegistryPlugin.md) | _pending_ | _pending_ | ☐ |

## Process

1. Freeze the commit (tag `v0.9.0-rc1`); record its SHA in each review file.
2. Each reviewer works the checklist independently and logs findings in the plugin's file.
3. Findings are fixed (or formally accepted with justification) before sign-off.
4. Both reviewers record their verdict + date. Update the status table above.
5. When all five are ✅, P8 is closed and the audit scope letter is sent.
