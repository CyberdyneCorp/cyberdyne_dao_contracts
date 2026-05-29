# External audit (Phase 9)

Artifacts for the external security audit.

- [`SCOPE.md`](SCOPE.md) — scope-of-work letter handed to the audit firm: in-scope files, out-of-scope dependencies, trust model, accepted risks, build instructions, and requested deliverables. Pinned to tag `v0.9.0-rc1`.
- `report-*.pdf` / `findings.md` — _added when the auditor delivers_ (P9 exit). Findings are then extracted into GitHub issues and tracked through remediation (P10).

The internal pre-audit evidence (Slither, coverage, storage layouts, per-plugin sign-offs) lives in [`../internal/`](../internal/) and [`../../docs/reviews/`](../../docs/reviews/).
