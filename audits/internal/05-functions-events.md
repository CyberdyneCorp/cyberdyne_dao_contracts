# External-function + event coverage cross-check

Per-plugin: every external function and every event must appear in at least one test. Tests searched: the plugin's own dir + shared specs at `test/plugins/*.ts` + e2e. Inherited OSx + OZ-proxy surface is filtered out.

## PayrollPlugin

- Plugin-specific functions: **33** (33 referenced)
- Plugin-specific events: **10** (10 referenced)
- ✓ every plugin-specific external function and event is referenced.

## UniswapV4Plugin

- Plugin-specific functions: **21** (21 referenced)
- Plugin-specific events: **5** (5 referenced)
- ✓ every plugin-specific external function and event is referenced.

## UniswapV3Plugin

- Plugin-specific functions: **22** (22 referenced)
- Plugin-specific events: **7** (7 referenced)
- ✓ every plugin-specific external function and event is referenced.

## AaveLendingPlugin

- Plugin-specific functions: **20** (20 referenced)
- Plugin-specific events: **6** (6 referenced)
- ✓ every plugin-specific external function and event is referenced.

## CostRegistryPlugin

- Plugin-specific functions: **23** (23 referenced)
- Plugin-specific events: **7** (7 referenced)
- ✓ every plugin-specific external function and event is referenced.
