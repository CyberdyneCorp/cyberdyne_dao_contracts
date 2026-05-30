import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, Signer } from "ethers";

// Types for test artifacts
let permit2: Contract;
let token: Contract;
let weth: Contract;
let v4Router: Contract;
let plugin: Contract;
let owner: Signer;
let user: Signer;
let addr1: string;
let addr2: string;

// Helper to zero-out allowance after swap call
async function getPermit2Allowance(token: Contract, owner: string, spender: string): Promise<bigint> {
  return await token.allowance(owner, spender);
}

describe("UniswapV4Plugin - Permit2 Allowance Cleanup & Zero-Address Validation", function () {
  before(async function () {
    [owner, user] = await ethers.getSigners();
    addr1 = await owner.getAddress();
    addr2 = await user.getAddress();
  });

  beforeEach(async function () {
    // Deploy a simple ERC20 mock with minimal functionality
    const TokenMock = await ethers.getContractFactory("ERC20Mock");
    token = await TokenMock.deploy("Test Token", "TST", 18);
    await token.deployed();

    // Deploy a simple WETH mock
    const WETH9Mock = await ethers.getContractFactory("WETH9Mock");
    weth = await WETH9Mock.deploy();
    await weth.deployed();

    // Deploy a simple Permit2 mock that simulates token transfer and allowance management
    const Permit2Mock = await ethers.getContractFactory("Permit2Mock");
    permit2 = await Permit2Mock.deploy(token.address);
    await permit2.deployed();

    // Deploy a Uniswap V4 Router mock (minimal interface)
    const V4RouterMock = await ethers.getContractFactory("V4RouterMock");
    v4Router = await V4RouterMock.deploy();
    await v4Router.deployed();

    // Deploy the UniswapV4Plugin with the mocks
    const PluginFactory = await ethers.getContractFactory("UniswapV4PluginFix");
    plugin = await PluginFactory.deploy(
      permit2.address,
      weth.address,
      v4Router.address
    );
    await plugin.deployed();
  });

  describe("Zero-Address Validation", function () {
    it("should revert constructor if permit2 address is zero", async function () {
      const Factory = await ethers.getContractFactory("UniswapV4PluginFix");
      await expect(
        Factory.deploy(ethers.constants.AddressZero, weth.address, v4Router.address)
      ).to.be.revertedWith("InvalidPermit2Address"); // custom error expected
    });

    it("should revert constructor if weth address is zero", async function () {
      const Factory = await ethers.getContractFactory("UniswapV4PluginFix");
      await expect(
        Factory.deploy(permit2.address, ethers.constants.AddressZero, v4Router.address)
      ).to.be.revertedWith("InvalidWethAddress");
    });

    it("should revert constructor if v4 router address is zero", async function () {
      const Factory = await ethers.getContractFactory("UniswapV4PluginFix");
      await expect(
        Factory.deploy(permit2.address, weth.address, ethers.constants.AddressZero)
      ).to.be.revertedWith("InvalidV4RouterAddress");
    });

    it("should revert swap if token address is zero", async function () {
      await expect(
        plugin.connect(user).swap(
          ethers.constants.AddressZero,
          ethers.constants.AddressZero,
          addr2,
          1000,
          0
        )
      ).to.be.revertedWith("InvalidTokenAddress");
    });

    it("should revert swap if recipient address is zero", async function () {
      await expect(
        plugin.connect(user).swap(
          token.address,
          ethers.constants.AddressZero,
          ethers.constants.AddressZero,
          1000,
          0
        )
      ).to.be.revertedWith("InvalidRecipientAddress");
    });
  });

  describe("Permit2 Allowance Cleanup", function () {
    it("should reset token allowance to 0 after a successful swap", async function () {
      // Mint tokens to user and approve Permit2
      const amountIn = ethers.utils.parseEther("100");
      await token.mint(addr2, amountIn);
      await token.connect(user).approve(permit2.address, amountIn);

      // Record allowance before swap (should be amountIn)
      let allowanceBefore = await getPermit2Allowance(token, addr2, permit2.address);
      expect(allowanceBefore).to.equal(amountIn);

      // Simulate a swap: user calls swap via plugin
      // The plugin will transfer tokens to itself (or to V4) using Permit2, then the mock router will complete
      await plugin.connect(user).swap(
        token.address,
        ethers.constants.AddressZero, // zero for native token path
        addr2,
        amountIn,
        1 // min amount out (small)
      );

      // After swap, plugin should have reset allowance to 0
      let allowanceAfter = await getPermit2Allowance(token, addr2, permit2.address);
      expect(allowanceAfter).to.equal(0);
    });

    it("should reset allowance even if swap fails (revert cleanup)", async function () {
      // Setup: approve large allowance
      const amountIn = ethers.utils.parseEther("50");
      await token.mint(addr2, amountIn);
      await token.connect(user).approve(permit2.address, amountIn);

      // Let the mock router revert on purpose (by passing a flag)
      await expect(
        plugin.connect(user).swap(
          token.address,
          ethers.constants.AddressZero,
          addr2,
          amountIn,
          BigInt(2e18) // min amount out too high to force failure
        )
      ).to.be.reverted; // revert expected but allowance should still be reset

      // Check that allowance is 0 due to cleanup in revert path
      let allowanceAfter = await getPermit2Allowance(token, addr2, permit2.address);
      expect(allowanceAfter).to.equal(0);
    });

    it("should handle multiple swaps and reset allowance each time", async function () {
      const amount1 = ethers.utils.parseEther("10");
      const amount2 = ethers.utils.parseEther("20");
      
      // Mint and approve for both swaps
      await token.mint(addr2, amount1.add(amount2));
      await token.connect(user).approve(permit2.address, ethers.constants.MaxUint256);

      // First swap
      await plugin.connect(user).swap(token.address, ethers.constants.AddressZero, addr2, amount1, 1);
      let allowanceAfter1 = await getPermit2Allowance(token, addr2, permit2.address);
      expect(allowanceAfter1).to.equal(0);

      // Approve again for second swap
      await token.connect(user).approve(permit2.address, amount2);
      
      // Second swap
      await plugin.connect(user).swap(token.address, ethers.constants.AddressZero, addr2, amount2, 1);
      let allowanceAfter2 = await getPermit2Allowance(token, addr2, permit2.address);
      expect(allowanceAfter2).to.equal(0);
    });
  });
});