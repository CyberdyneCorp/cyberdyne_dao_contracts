// Coverage gate: 90% lines AND branches on src/plugins/**.
// CI reads coverage/coverage-summary.json and fails the build below threshold.

module.exports = {
  skipFiles: [
    // Pure interfaces — no executable logic to cover.
    "plugins/uniswap-v4/IUniswapV4Plugin.sol",
    "plugins/uniswap-v4/IUniversalRouter.sol",
    "plugins/uniswap-v4/IPermit2.sol",
    "plugins/uniswap-v4/IV4PositionManager.sol",
    "plugins/uniswap-v3/IUniswapV3Plugin.sol",
    "plugins/uniswap-v3/INonfungiblePositionManager.sol",
    "plugins/aave/IAaveLendingPlugin.sol",
    "plugins/aave/adapters/IAaveAdapter.sol",
    "plugins/aave/adapters/IAavePool.sol",
    "plugins/payroll/IPayrollPlugin.sol",
    "plugins/cost-registry/ICostRegistryPlugin.sol",
    // Vendored 3rd-party math lib.
    "plugins/payroll/lib/BokkyPooBahsDateTimeLibrary.sol",
    // P4-stub: AAVE v4 adapter is a placeholder until v4 launches (TRD §16
    // #1). All methods revert NotImplemented; testing it would only assert
    // the revert. Re-enable when v4 lands.
    "plugins/aave/adapters/AaveV4Adapter.sol",
    // Test-only mocks. Live under src/ so Hardhat compiles them, but they
    // don't ship and don't count toward coverage.
    "test/mocks/MinimalDAO.sol",
    "test/mocks/TestERC20.sol",
    "test/mocks/RevertingRecipient.sol",
    "test/mocks/MockUniversalRouter.sol",
    "test/mocks/MockPermit2.sol",
    "test/mocks/MockAavePool.sol",
    "test/mocks/MockNonfungiblePositionManager.sol",
    "test/mocks/MockV4PositionManager.sol",
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
