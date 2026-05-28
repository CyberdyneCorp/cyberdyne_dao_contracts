# External-function + event coverage cross-check

Per-plugin: every external function and every event must appear in at least one test. Tests searched: the plugin's own dir + shared specs at `test/plugins/*.ts` + e2e. Inherited OSx + OZ-proxy surface is filtered out.

## PayrollPlugin

- Plugin-specific functions: **32** (32 referenced)
- Plugin-specific events: **9** (9 referenced)
- ✓ every plugin-specific external function and event is referenced.

## UniswapV4Plugin

- Plugin-specific functions: **21** (21 referenced)
- Plugin-specific events: **5** (5 referenced)
- ✓ every plugin-specific external function and event is referenced.

## UniswapV3Plugin

- Plugin-specific functions: **22** (20 referenced)
- Plugin-specific events: **7** (6 referenced)
- ⚠ Unreferenced functions:
  - `allowedToken`
  - `previewIncreaseLiquidityActions`
- ⚠ Unreferenced events:
  - `AllowedTokenSet`

## AaveLendingPlugin

- Plugin-specific functions: **20** (20 referenced)
- Plugin-specific events: **6** (6 referenced)
- ✓ every plugin-specific external function and event is referenced.

## CostRegistryPlugin

- Plugin-specific functions: **23** (23 referenced)
- Plugin-specific events: **7** (7 referenced)
- ✓ every plugin-specific external function and event is referenced.

---

## Findings to surface in P8 Phase B reviews

### UniswapV3Plugin (3 items)

| # | Item | Type | Severity | Action |
|---|---|---|---|---|
| 1 | `previewIncreaseLiquidityActions` not exercised by any test | Function | Low — view helper, no on-chain side effects, but the checklist requires every external function to have a test | Add a `previewIncreaseLiquidityActions` case to `test/plugins/PreviewActions.unit.test.ts` (mirror the existing `previewMintActions` / `previewDecreaseLiquidityActions` pattern) |
| 2 | `allowedToken(address) view` not asserted by V3 tests | Function (getter) | Low | Assert `allowedToken(addr)` returns expected `true`/`false` after `setAllowedToken` in V3's `setAllowedToken` test |
| 3 | `AllowedTokenSet` event not asserted in V3 | Event | Low | Add `.to.emit(plugin, "AllowedTokenSet")` to V3's `setAllowedToken` test (V4 already does this) |

All three are small additions (<10 lines each) and close out the checklist's §6.Tests bullets for the V3 review.
