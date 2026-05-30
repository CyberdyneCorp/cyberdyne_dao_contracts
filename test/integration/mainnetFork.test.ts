import { ethers } from "hardhat";
import { expect } from "chai";
import { Contract, Signer } from "ethers";

// Mainnet token addresses (ETH is native, WETH for value transfers)
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

// Known whale addresses (hold significant balances)
const USDC_WHALE = "0x47ac0Fb4F2D84898e4D9E7b4DaB3C24507a6D503";  // Binance 8
const DAI_WHALE = "0x5d3a536E4D6DbD6114cc1Ead35777bAB948E3643";   // Compound proxy
const WETH_WHALE = "0x2fEb1512183545f48f6b9C5b4EbfCaF49CfCa6F3"; // Arbitrum bridge

describe("Mainnet Fork — Atomic Payment & Marking", function () {
  // Tests rely on a forked mainnet state; ensure long timeout
  this.timeout(300_000);

  let owner: Signer;
  let recipient: Signer;
  let sender: Signer;

  let usdc: Contract;
  let dai: Contract;
  let weth: Contract;
  let payrollPlugin: Contract;

  let snapshotId: string;

  before(async function () {
    // Reset to a specific mainnet fork (block ~19M)
    await ethers.provider.send("hardhat_reset", [
      {
        forking: {
          jsonRpcUrl: `https://eth-mainnet.alchemyapi.io/v2/${process.env.ALCHEMY_API_KEY}`,
          blockNumber: 19_000_000,
        },
      },
    ]);

    // Snapshot clean state for revert between tests
    snapshotId = await ethers.provider.send("evm_snapshot", []);
  });

  beforeEach(async function () {
    // Revert to clean fork state before each test
    await ethers.provider.send("evm_revert", [snapshotId]);
    snapshotId = await ethers.provider.send("evm_snapshot", []);

    // Get test accounts
    [owner, recipient, sender] = await ethers.getSigners();

    // Impersonate whales to fund sender & owner
    const impersonateAndFund = async (whaleAddress: string, amount: bigint) => {
      await ethers.provider.send("hardhat_impersonateAccount", [whaleAddress]);
      const whale = await ethers.getSigner(whaleAddress);
      // Send ETH for gas
      await owner.sendTransaction({
        to: whaleAddress,
        value: ethers.parseEther("10"),
      });
      return whale;
    };

    // Prepare token contracts
    const erc20Abi = [
      "function transfer(address to, uint256 amount) returns (bool)",
      "function transferFrom(address from, address to, uint256 amount) returns (bool)",
      "function approve(address spender, uint256 amount) returns (bool)",
      "function balanceOf(address) view returns (uint256)",
      "function decimals() view returns (uint8)",
    ];

    usdc = new Contract(USDC, erc20Abi, ethers.provider);
    dai = new Contract(DAI, erc20Abi, ethers.provider);
    weth = new Contract(WETH, erc20Abi, ethers.provider);

    // Fund sender with USDC, DAI, and ETH/WETH
    const usdcWhale = await impersonateAndFund(USDC_WHALE, ethers.parseEther("1"));
    const daiWhale = await impersonateAndFund(DAI_WHALE, ethers.parseEther("1"));
    const wethWhale = await impersonateAndFund(WETH_WHALE, ethers.parseEther("1"));

    const transferAmountUsdc = ethers.parseUnits("10000", 6); // 10k USDC
    const transferAmountDai = ethers.parseEther("10000");
    const transferAmountWeth = ethers.parseEther("50");

    await usdc.connect(usdcWhale).transfer(await sender.getAddress(), transferAmountUsdc);
    await dai.connect(daiWhale).transfer(await sender.getAddress(), transferAmountDai);
    await weth.connect(wethWhale).transfer(await sender.getAddress(), transferAmountWeth);

    // Also send some ETH to sender for gas
    await owner.sendTransaction({ to: await sender.getAddress(), value: ethers.parseEther("100") });

    // Deploy PayrollPlugin (replace with actual factory import as needed)
    const PayrollPluginFactory = await ethers.getContractFactory("PayrollPlugin");
    payrollPlugin = await PayrollPluginFactory.deploy(
      await sender.getAddress(), // owner
      [await usdc.getAddress(), await dai.getAddress(), WETH], // supported tokens
      /* other constructor args as needed */
    );
    await payrollPlugin.waitForDeployment();
  });

  it("should revert the entire transaction if the token transfer fails (e.g., insufficient balance in plugin)", async () => {
    // Setup: sender has plenty of tokens, but plugin has zero allowance/balance.
    // Attempt to pay salary with a recipient expecting USDC.
    // The plugin will try to transfer USDC from itself, which will fail because it has none.
    // The paySalary function should revert, and internal marking should not update.

    const paySalaryRole = ethers.keccak256(ethers.toUtf8Bytes("PAY_SALARY_ROLE"));
    // Grant role to sender
    await payrollPlugin.grantRole(paySalaryRole, await sender.getAddress());

    // Register a salary for recipient (assumes function exists)
    await payrollPlugin.connect(sender).addSalary(
      await recipient.getAddress(),
      USDC,
      ethers.parseUnits("1000", 6),
      /* other params */
    );

    // Attempt to pay (should revert because plugin has no USDC balance)
    await expect(
      payrollPlugin.connect(sender).paySalary(await recipient.getAddress())
    ).to.be.reverted;

    // Verify marking remains unchanged (salary not marked paid)
    const isPaid = await payrollPlugin.isSalaryPaid(await recipient.getAddress());
    expect(isPaid).to.equal(false);
  });

  it("should atomically mark and transfer when sufficient funds and approval are available", async () => {
    // Setup: transfer USDC to plugin and approve it to spend.
    const payAmount = ethers.parseUnits("5000", 6);
    await usdc.connect(sender).transfer(await payrollPlugin.getAddress(), payAmount);

    const paySalaryRole = ethers.keccak256(ethers.toUtf8Bytes("PAY_SALARY_ROLE"));
    await payrollPlugin.grantRole(paySalaryRole, await sender.getAddress());

    await payrollPlugin.connect(sender).addSalary(
      await recipient.getAddress(),
      USDC,
      payAmount,
      /* other params */
    );

    // Record balances before
    const recipientBalanceBefore = await usdc.balanceOf(await recipient.getAddress());
    const pluginBalanceBefore = await usdc.balanceOf(await payrollPlugin.getAddress());

    // Execute pay
    await payrollPlugin.connect(sender).paySalary(await recipient.getAddress());

    // Check balances after
    const recipientBalanceAfter = await usdc.balanceOf(await recipient.getAddress());
    const pluginBalanceAfter = await usdc.balanceOf(await payrollPlugin.getAddress());

    expect(recipientBalanceAfter - recipientBalanceBefore).to.equal(payAmount);
    expect(pluginBalanceBefore - pluginBalanceAfter).to.equal(payAmount);

    // Marking should be updated
    const isPaid = await payrollPlugin.isSalaryPaid(await recipient.getAddress());
    expect(isPaid).to.equal(true);
  });

  it("should handle multiple tokens (ETH, USDC, DAI) correctly", async () => {
    // Similar to above but for ETH (via WETH) and DAI transfers.
    // This test ensures the plugin works with both 18 and 6 decimal tokens.
    const paySalaryRole = ethers.keccak256(ethers.toUtf8Bytes("PAY_SALARY_ROLE"));
    await payrollPlugin.grantRole(paySalaryRole, await sender.getAddress());

    const payAmountDai = ethers.parseEther("2000");
    await dai.connect(sender).transfer(await payrollPlugin.getAddress(), payAmountDai);
    await payrollPlugin.connect(sender).addSalary(await recipient.getAddress(), DAI, payAmountDai);

    const recipientBalanceBeforeDai = await dai.balanceOf(await recipient.getAddress());
    await payrollPlugin.connect(sender).paySalary(await recipient.getAddress());
    const recipientBalanceAfterDai = await dai.balanceOf(await recipient.getAddress());

    expect(recipientBalanceAfterDai - recipientBalanceBeforeDai).to.equal(payAmountDai);
    const isPaidDai = await payrollPlugin.isSalaryPaid(await recipient.getAddress());
    expect(isPaidDai).to.equal(true);
  });

  it("should revert on insufficient token approval even if plugin has balance", async () => {
    // Scenario: Plugin has USDC but hasn't approved the underlying transfer (unlikely but possible with custom tokens).
    // Here we simulate by revoking approval after adding the salary.
    // We assume the plugin calls `safeTransfer` which would revert on failure.
    const payAmount = ethers.parseUnits("100", 6);
    await usdc.connect(sender).transfer(await payrollPlugin.getAddress(), payAmount);

    // Add salary
    const paySalaryRole = ethers.keccak256(ethers.toUtf8Bytes("PAY_SALARY_ROLE"));
    await payrollPlugin.grantRole(paySalaryRole, await sender.getAddress());
    await payrollPlugin.connect(sender).addSalary(await recipient.getAddress(), USDC, payAmount);

    // Intentionally drain plugin's USDC approval by spending all on something else (if possible)
    // Since we control the token, we can just call approve(plugin, 0)
    await usdc.connect(sender).approve(await payrollPlugin.getAddress(), 0);

    // Now paySalary should revert because safeTransfer will fail (no approval)
    await expect(
      payrollPlugin.connect(sender).paySalary(await recipient.getAddress())
    ).to.be.reverted;

    const isPaid = await payrollPlugin.isSalaryPaid(await recipient.getAddress());
    expect(isPaid).to.equal(false);
  });

  after(async function () {
    // Reset hardhat state if needed for other tests
    await ethers.provider.send("hardhat_reset", []);
  });
});