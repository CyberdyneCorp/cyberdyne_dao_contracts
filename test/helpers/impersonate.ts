import {ethers, network} from "hardhat";
import type {BigNumberish, Signer} from "ethers";

/** Impersonate an account, top up its ETH balance, and return a Signer. */
export async function impersonate(
  addr: string,
  ethBalance: BigNumberish = ethers.utils.parseEther("100")
): Promise<Signer> {
  await network.provider.send("hardhat_impersonateAccount", [addr]);
  await network.provider.send("hardhat_setBalance", [
    addr,
    ethers.utils.hexValue(ethers.BigNumber.from(ethBalance)),
  ]);
  return ethers.getSigner(addr);
}

export async function stopImpersonating(addr: string): Promise<void> {
  await network.provider.send("hardhat_stopImpersonatingAccount", [addr]);
}

// Minimal ERC20 ABI for whale-funded transfers in fork tests.
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
];

/**
 * Send `amount` of `token` from a whale account to `recipient`. Use in fork
 * tests to seed the DAO with realistic balances without requiring a faucet.
 */
export async function fundFromWhale(
  token: string,
  whale: string,
  recipient: string,
  amount: BigNumberish
): Promise<void> {
  const whaleSigner = await impersonate(whale);
  const erc20 = new ethers.Contract(token, ERC20_ABI, whaleSigner);
  const bal = await erc20.balanceOf(whale);
  if (bal.lt(amount)) {
    throw new Error(`Whale ${whale} has ${bal.toString()} of ${token}, need ${amount.toString()}`);
  }
  const tx = await erc20.transfer(recipient, amount);
  await tx.wait();
  await stopImpersonating(whale);
}

export async function setEthBalance(addr: string, eth: BigNumberish): Promise<void> {
  await network.provider.send("hardhat_setBalance", [
    addr,
    ethers.utils.hexValue(ethers.BigNumber.from(eth)),
  ]);
}
