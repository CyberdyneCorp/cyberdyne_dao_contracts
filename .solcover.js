// Coverage gate: 90% lines AND branches on src/plugins/**.
// CI reads coverage/coverage-summary.json and fails the build below threshold.

module.exports = {
  skipFiles: [
    // Pure interfaces — no executable logic to cover.
    "plugins/uniswap-v4/IUniswapV4Plugin.sol",
    "plugins/uniswap-v4/IUniversalRouter.sol",
    "plugins/uniswap-v4/IPermit2.sol",
    "plugins/aave/IAaveLendingPlugin.sol",
    "plugins/aave/adapters/IAaveAdapter.sol",
    "plugins/payroll/IPayrollPlugin.sol",
    // Vendored 3rd-party math lib.
    "plugins/payroll/lib/BokkyPooBahsDateTimeLibrary.sol",
    // Test-only mocks. Live under src/ so Hardhat compiles them, but they
    // don't ship and don't count toward coverage.
    "test/mocks/MinimalDAO.sol",
    "test/mocks/TestERC20.sol",
    "test/mocks/RevertingRecipient.sol",
  ],
  istanbulFolder: "./coverage",
  istanbulReporter: ["html", "lcov", "text", "json-summary"],
  configureYulOptimizer: true,
  // Mocha defaults are fine. solidity-coverage instruments by source, so the
  // src/plugins/** filter is enforced by skipFiles + the CI threshold script.
  measureFunctionCoverage: true,
  measureBranchCoverage: true,
  measureLineCoverage: true,
  measureStatementCoverage: true,
};
