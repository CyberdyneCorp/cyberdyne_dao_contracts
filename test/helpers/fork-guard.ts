import {network} from "hardhat";

/**
 * Gate a describe-block to a set of Hardhat networks.
 *
 *   onlyOn(["mainnetFork", "localFork"], () => describe("...", () => { ... }));
 *
 * Other networks are skipped (the describe block isn't even registered),
 * keeping CI logs clean across the fork matrix.
 */
export function onlyOn(networks: string[], fn: () => void): void {
  if (networks.includes(network.name)) {
    fn();
  }
}

export function skipOn(networks: string[], fn: () => void): void {
  if (!networks.includes(network.name)) {
    fn();
  }
}

/**
 * True if the current network has Hardhat's forking config wired (fork tests
 * need an RPC URL to be set; unit tests run on the in-memory `hardhat` net).
 */
export function isForkedNetwork(): boolean {
  const cfg = network.config as {forking?: {url?: string}};
  return Boolean(cfg.forking?.url);
}

export function requireFork(): void {
  if (!isForkedNetwork() && network.name !== "localFork") {
    throw new Error(
      `Test requires a fork network. Current: ${network.name}. ` +
        `Run with --network mainnetFork|baseFork|localFork.`
    );
  }
}
