import {expect} from "chai";
import {ethers, network} from "hardhat";
import {
  PayrollPlugin__factory,
  UniswapV4Plugin__factory,
  AaveLendingPlugin__factory,
} from "../typechain-types";

describe("Smoke (P0/P1 toolchain check)", () => {
  it("deploys every plugin implementation", async () => {
    const [deployer] = await ethers.getSigners();

    const payroll = await new PayrollPlugin__factory(deployer).deploy();
    const uniswap = await new UniswapV4Plugin__factory(deployer).deploy();
    const aave = await new AaveLendingPlugin__factory(deployer).deploy();

    await Promise.all([payroll.deployed(), uniswap.deployed(), aave.deployed()]);

    expect(payroll.address).to.properAddress;
    expect(uniswap.address).to.properAddress;
    expect(aave.address).to.properAddress;
  });

  it("plugin stubs expose the right permission IDs", async () => {
    const [deployer] = await ethers.getSigners();
    const payroll = await new PayrollPlugin__factory(deployer).deploy();
    const uniswap = await new UniswapV4Plugin__factory(deployer).deploy();
    const aave = await new AaveLendingPlugin__factory(deployer).deploy();

    expect(await payroll.MANAGE_PAYROLL_PERMISSION_ID()).to.equal(
      ethers.utils.id("MANAGE_PAYROLL_PERMISSION")
    );
    expect(await uniswap.TRIGGER_SWAP_PERMISSION_ID()).to.equal(
      ethers.utils.id("TRIGGER_SWAP_PERMISSION")
    );
    expect(await aave.TRIGGER_LENDING_PERMISSION_ID()).to.equal(
      ethers.utils.id("TRIGGER_LENDING_PERMISSION")
    );
  });

  it("knows the network it's running on", async () => {
    const chainId = (await ethers.provider.getNetwork()).chainId;
    expect(typeof chainId).to.equal("number");
    expect(network.name).to.be.a("string");
  });
});
