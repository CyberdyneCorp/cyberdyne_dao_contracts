# Per-plugin coverage

Source: `coverage/coverage-summary.json` (`npx hardhat coverage`, 2026-05-28T10:11Z).
Threshold: 90% per metric per plugin (roadmap P8 + `scripts/check-coverage.js`).

| Plugin | Lines | Branches | Functions | Statements | Files | Status |
|---|---:|---:|---:|---:|---:|---|
| PayrollPlugin | 99.35% | 93.75% | 100.00% | 98.21% | 2 | ✓ ≥ 90% |
| UniswapV4Plugin | 98.25% | 91.67% | 100.00% | 97.26% | 2 | ✓ ≥ 90% |
| UniswapV3Plugin | 95.40% | 90.63% | 100.00% | 95.65% | 2 | ✓ ≥ 90% |
| AaveLendingPlugin | 100.00% | 100.00% | 100.00% | 100.00% | 4 | ✓ ≥ 90% |
| CostRegistryPlugin | 100.00% | 94.12% | 100.00% | 100.00% | 2 | ✓ ≥ 90% |

### Overall

- Lines 98.8%, Branches 93.99%, Functions 100%, Statements 98.42%

### Note on the coverage gate

`scripts/check-coverage.js` only enforces 3 plugin paths (payroll, uniswap-v4, aave). **UniswapV3Plugin** and **CostRegistryPlugin** are not in the `ENFORCED` array — coverage is computed but not gated for those two. Adding them to the gate is a small lift and would close that hole before P8 sign-off.