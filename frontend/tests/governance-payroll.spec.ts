import {test, expect} from "@playwright/test";
import {injectAnvilProvider, connectWallet} from "./fixtures/inject-provider";
import {
  submitProposal,
  voteExecute,
  buildAdminAction,
  onchain,
  evmSnapshot,
  evmRevert,
} from "./fixtures/governance";

// Full write coverage for the Payroll plugin, driven through the UI. Each test
// runs against the clean seeded state via an anvil snapshot/revert.

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
// Seeded recipient #0 (anvil acct #1), USDC 5000e6.
const SEEDED_PAYEE = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

let snap: string;
test.beforeEach(async ({page}) => {
  snap = await evmSnapshot();
  await injectAnvilProvider(page);
});
test.afterEach(async () => {
  await evmRevert(snap);
});

test("setMaxRecipients via vote → execute (verified on-chain)", async ({page}) => {
  await page.goto("/payroll");
  await connectWallet(page);
  const form = page.locator("div.form").filter({has: page.getByPlaceholder("500", {exact: true})});
  await form.getByPlaceholder("500", {exact: true}).fill("750");
  await form.getByRole("button", {name: "Build"}).click();
  const id = await submitProposal(page);
  await voteExecute(page, id);

  const payroll = onchain("E2E_PAYROLL", ["function MAX_RECIPIENTS() view returns (uint256)"]);
  expect((await payroll.MAX_RECIPIENTS()).toString()).toBe("750");
});

test("setAmount via vote → execute (verified on the payroll page)", async ({page}) => {
  await page.goto("/payroll");
  await connectWallet(page);
  const form = page.locator("div.form").filter({has: page.getByPlaceholder("1500", {exact: true})});
  await form.getByPlaceholder("0x...", {exact: true}).fill(SEEDED_PAYEE);
  await form.getByPlaceholder(/0x0 = ETH/).fill(USDC);
  await form.getByPlaceholder("1500", {exact: true}).fill("9999");
  await form.getByRole("button", {name: "Build"}).click();
  const id = await submitProposal(page);
  await voteExecute(page, id);

  await page.goto("/payroll");
  await connectWallet(page);
  // Amounts now render human-readable (formatToken): 9999000000 → "9,999 USDC".
  await expect(page.getByText("9,999 USDC")).toBeVisible({timeout: 30_000});
});

test("removeRecipient via the proposals admin builder (count drops)", async ({page}) => {
  const id = await buildAdminAction(page, "payroll-removeRecipient", SEEDED_PAYEE);
  await voteExecute(page, id);

  await page.goto("/payroll");
  await connectWallet(page);
  await expect(page.getByText(/Active recipients \(3\)/)).toBeVisible({timeout: 30_000});
});

test("setPayDayOfMonth via the proposals admin builder", async ({page}) => {
  const id = await buildAdminAction(page, "payroll-setPayDayOfMonth", "20");
  await voteExecute(page, id);

  await page.goto("/payroll");
  await connectWallet(page);
  await expect(page.getByText(/Pay day of month:\s*20/)).toBeVisible({timeout: 30_000});
});

test("forcePayPeriod (preview) via vote → execute", async ({page}) => {
  await page.goto("/payroll");
  await connectWallet(page);
  // No crank has run (lastPayoutPeriod = 0), so a recent past month qualifies.
  const now = new Date();
  const m0 = now.getUTCMonth(); // 0-based
  const year = m0 === 0 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
  const month = m0 === 0 ? 12 : m0; // previous calendar month, 1..12
  const form = page.locator("div.form").filter({has: page.getByPlaceholder("2027", {exact: true})});
  await form.getByPlaceholder("2027", {exact: true}).fill(String(year));
  await form.getByPlaceholder("2", {exact: true}).fill(String(month));
  await form.getByRole("button", {name: "Build"}).click();
  const id = await submitProposal(page);
  await voteExecute(page, id); // executes the recovery batch (pays active recipients once)
});

test("executePayroll crank pays the period (last-paid updates)", async ({page}) => {
  await page.goto("/payroll");
  await connectWallet(page);
  await expect(page.getByText(/Last paid period:/)).toBeVisible();
  await page.getByRole("button", {name: "executePayroll()"}).click();
  await expect(page.getByText(/Confirmed in block/)).toBeVisible({timeout: 30_000});

  await page.goto("/payroll");
  await connectWallet(page);
  await expect(page.getByText(/Last paid period:\s*\d{4}-\d{2}/)).toBeVisible({timeout: 30_000});
});

test("executePayrollPage crank (paginated) confirms a tx", async ({page}) => {
  await page.goto("/payroll");
  await connectWallet(page);
  await page.getByRole("button", {name: "Run page"}).click();
  await expect(page.getByText(/Confirmed in block/)).toBeVisible({timeout: 30_000});
});
