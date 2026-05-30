import { ethers, upgrades, network, run } from "hardhat";
import { getImplementationAddress } from "@openzeppelin/upgrades-core";
import fs from "fs";
import path from "path";

/**
 * Production-grade deployment/upgrade script for plugins using UUPS proxy pattern.
 * Supports PayrollPlugin, CostRegistryPlugin, UniswapV4Plugin and any future plugin.
 *
 * - Deploys a new proxy if none exists for a given plugin.
 * - Upgrades existing proxies, validating storage layout via OpenZeppelin Upgrades.
 * - Verifies new implementations on Etherscan (skip test networks).
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`\n🚀 Deployer: ${deployer.address}`);
  console.log(`🌐 Network: ${network.name}`);

  // Load proxy addresses from OpenZeppelin manifest (generated after first deploy)
  const manifestPath = path.join(
    __dirname,
    "..",
    "..",
    ".openzeppelin",
    `${network.name}.json`
  );
  let proxyAddresses: Record<string, string> = {};
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (manifest.proxies) {
      for (const [contractName, proxyObj] of Object.entries(manifest.proxies)) {
        proxyAddresses[contractName] = (proxyObj as any).address;
      }
    }
  }

  // Plugin definitions (contract names as in artifacts)
  const plugins = [
    { name: "PayrollPlugin", contract: "PayrollPlugin" },
    { name: "CostRegistryPlugin", contract: "CostRegistryPlugin" },
    { name: "UniswapV4Plugin", contract: "UniswapV4Plugin" },
  ];

  for (const plugin of plugins) {
    console.log(`\n📦 Processing ${plugin.name}:`);

    const proxyAddr = proxyAddresses[plugin.name];
    const factory = await ethers.getContractFactory(plugin.contract);

    if (!proxyAddr) {
      console.log("  → No existing proxy found. Deploying new proxy...");
      const deployed = await upgrades.deployProxy(factory, [], {
        initializer: "initialize",
        kind: "uups",
      });
      await deployed.deployed();
      console.log(`  ✅ Proxy deployed at: ${deployed.address}`);
      await verifyImplementation(deployed.address);
    } else {
      console.log(`  → Upgrading proxy at ${proxyAddr}...`);
      const upgraded = await upgrades.upgradeProxy(proxyAddr, factory);
      await upgraded.deployed();
      const impl = await getImplementationAddress(ethers.provider, upgraded.address);
      console.log(`  ✅ Upgraded. New implementation: ${impl}`);
      await verifyImplementation(upgraded.address);
    }
  }

  console.log("\n✅ Deployment/Upgrade finished successfully.");
}

/**
 * Verifies the implementation contract on Etherscan (if not a local network).
 * Silently ignores verification failures (e.g., already verified).
 */
async function verifyImplementation(proxyAddress: string) {
  if (network.name === "hardhat" || network.name === "localhost") return;

  try {
    const implementation = await getImplementationAddress(ethers.provider, proxyAddress);
    console.log(`  🔍 Verifying implementation ${implementation}...`);
    await run("verify:verify", {
      address: implementation,
      constructorArguments: [],
    });
    console.log(`  ✅ Implementation verified.`);
  } catch (err: any) {
    // Verification might fail if contract already verified or API unavailable
    console.warn(`  ⚠️ Verification skipped: ${err.message}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });