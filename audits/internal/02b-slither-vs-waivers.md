# Slither: current findings vs documented waivers

## PayrollPlugin

| Detector | Severity | Count | Status |
|---|---|---:|---|
| `cyclomatic-complexity` | Informational | 1 | ⚠ DRIFT — not in waiver table |
| `incorrect-equality` | Medium | 2 | ⚠ DRIFT — not in waiver table |
| `missing-zero-check` | Low | 1 | ⚠ DRIFT — not in waiver table |
| `naming-convention` | Informational | 12 | ✓ documented |
| `reentrancy-events` | Low | 1 | ✓ documented |
| `timestamp` | Low | 3 | ✓ documented |
| `uninitialized-local` | Medium | 3 | ✓ documented |
| `unused-return` | Medium | 2 | ✓ documented |
| `unused-state` | Informational | 1 | ✓ documented |

## UniswapV4Plugin

| Detector | Severity | Count | Status |
|---|---|---:|---|
| `calls-loop` | Low | 2 | ⚠ DRIFT — not in waiver table |
| `missing-zero-check` | Low | 6 | ✓ documented |
| `naming-convention` | Informational | 11 | ✓ documented |
| `reentrancy-events` | Low | 1 | ✓ documented |
| `solc-version` | Informational | 1 | ✓ documented |
| `timestamp` | Low | 3 | ✓ documented |
| `uninitialized-local` | Medium | 1 | ⚠ DRIFT — not in waiver table |
| `unused-return` | Medium | 2 | ✓ documented |
| `unused-state` | Informational | 1 | ✓ documented |

## UniswapV3Plugin

| Detector | Severity | Count | Status |
|---|---|---:|---|
| `naming-convention` | Informational | 8 | ✓ documented |
| `reentrancy-events` | Low | 5 | ✓ documented |
| `solc-version` | Informational | 1 | ⚠ DRIFT — not in waiver table |
| `timestamp` | Low | 3 | ✓ documented |
| `unused-return` | Medium | 6 | ✓ documented |
| `unused-state` | Informational | 1 | ⚠ DRIFT — not in waiver table |

## AaveLendingPlugin

| Detector | Severity | Count | Status |
|---|---|---:|---|
| `naming-convention` | Informational | 12 | ✓ documented |
| `reentrancy-events` | Low | 4 | ✓ documented |
| `solc-version` | Informational | 1 | ⚠ DRIFT — not in waiver table |
| `unused-return` | Medium | 6 | ✓ documented |
| `unused-state` | Informational | 1 | ✓ documented |

## CostRegistryPlugin

| Detector | Severity | Count | Status |
|---|---|---:|---|
| `naming-convention` | Informational | 11 | ✓ documented |
| `reentrancy-events` | Low | 1 | ✓ documented |
| `solc-version` | Informational | 1 | ⚠ DRIFT — not in waiver table |
| `timestamp` | Low | 6 | ✓ documented |
| `uninitialized-local` | Medium | 1 | ⚠ DRIFT — not in waiver table |
| `unused-return` | Medium | 1 | ✓ documented |
| `unused-state` | Informational | 1 | ⚠ DRIFT — not in waiver table |
