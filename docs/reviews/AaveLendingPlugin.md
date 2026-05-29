# Internal review — AaveLendingPlugin

> Phase 8 (P8) per-plugin sign-off. **Two contributor approvals required** before this plugin is included in the external-audit scope (`audits/external/SCOPE.md`).

| | |
|---|---|
| Plugin | `AaveLendingPlugin` |
| Spec | [`docs/plugins/AAVE.md`](../plugins/AAVE.md) |
| Commit / tag under review | `v0.9.0-rc1` _(fill in exact SHA when signing)_ |
| Coverage at review | 100.00% lines / 100.00% branches |
| Slither evidence | [`audits/internal/02-slither.md`](../../audits/internal/02-slither.md) |
| Storage layout | [`audits/internal/01-storage-layouts.md`](../../audits/internal/01-storage-layouts.md) |

## Files in scope

- `src/plugins/aave/AaveLendingPlugin.sol`
- `src/plugins/aave/IAaveLendingPlugin.sol`
- `src/plugins/aave/AaveLendingPluginSetup.sol`
- `src/plugins/aave/adapters/IAaveAdapter.sol`
- `src/plugins/aave/adapters/AaveV3Adapter.sol`
- `src/plugins/aave/adapters/AaveV4Adapter.sol`
- `src/plugins/aave/adapters/IAavePool.sol`
- `src/plugins/aave/conditions/BorrowHealthCondition.sol`

## Plugin-specific focus areas

These are the highest-risk invariants for this plugin — confirm each explicitly:

1. `onBehalfOf = DAO` on every supply/withdraw/borrow/repay — aTokens & debt always issued to the treasury.
2. Adapter calldata-builder pattern cannot be pointed at an arbitrary `pool` to exfiltrate approvals; `setAdapter` is vote-gated.
3. `repay` 3-action batch resets the dust allowance to zero; `supply` 2-action batch is exact-amount.
4. `BorrowHealthCondition` enforces the `minHealthFactor` floor on BOTH the permission-condition (`isGranted`) and post-trade (`assertHealthFactor`) paths; governor-only floor updates.
5. `AaveV4Adapter` stub reverts `NotImplemented` on every entry point (no half-wired v4 path).

### Security review checklist

Each reviewer confirms (or files a finding for) every line:

- [ ] **Access control** — every state-mutating function is gated by the correct permission ID; no missing `auth(...)` modifier.
- [ ] **Custody** — the plugin never custodies funds or NFTs; the DAO is `msg.sender`/recipient on every external call.
- [ ] **Reentrancy** — no state mutated after an external call without protection; governance path avoids nested `dao.execute`.
- [ ] **Arithmetic** — no unchecked overflow/underflow; casts are safe or bounded.
- [ ] **External calls** — return values checked; approvals scoped and reset; no unbounded approval.
- [ ] **Upgrade safety** — storage layout matches `audits/internal/01-storage-layouts.md`; `__gap` preserved; initializers gated.
- [ ] **Input validation** — zero-address / zero-amount / out-of-range inputs revert with named errors.
- [ ] **DoS / gas** — loops are bounded (pagination); a single bad actor cannot brick a shared path.
- [ ] **Events** — every state change emits the documented event with correct args (see `audits/internal/05-functions-events.md`).
- [ ] **Slither** — all findings reviewed against the per-plugin waiver table (`audits/internal/02-slither.md`); no unwaived High/Medium.
- [ ] **Tests** — coverage ≥ 90% (lines + branches); fork tests pass on `mainnetFork` + `baseFork`; no `it.only`/`vm.skip`.
- [ ] **Spec parity** — behavior matches the plugin spec doc; no undocumented privileged surface.


## Findings

| # | Severity | Description | Status | Resolved in |
|---|----------|-------------|--------|-------------|
| _none yet_ | | | | |

## Sign-off

Two distinct contributors must review independently and sign below. Reviewer 2 must not be the plugin's primary author.

| Reviewer | Role | Commit SHA reviewed | Verdict (approve / changes-requested) | Date |
|----------|------|---------------------|----------------------------------------|------|
| _______ | Reviewer 1 | | | |
| _______ | Reviewer 2 (independent) | | | |
