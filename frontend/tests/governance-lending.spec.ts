import {test, expect} from "@playwright/test";
import {injectAnvilProvider, connectWallet} from "./fixtures/inject-provider";
import {submitProposal, voteExecute, evmSnapshot, evmRevert} from "./fixtures/governance";

// AAVE write coverage via the lending propose form (preview multi-action path).
// The seed supplied 15,000 USDC + 2 WETH as collateral, so withdraw/borrow have
// the state they need. Each test runs against the clean seeded state.

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

let snap: string;
test.beforeEach(async ({page}) => {
  snap = await evmSnapshot();
  await injectAnvilProvider(page);
});
test.afterEach(async () => {
  await evmRevert(snap);
});

function lendingForm(page: import("@playwright/test").Page) {
  // The propose-lending form is the only one with an "Operation" select.
  return page.locator("div.form").filter({
    has: page.locator('select').filter({has: page.locator('option[value="supply"]')}),
  });
}

async function buildLending(
  page: import("@playwright/test").Page,
  op: "supply" | "withdraw" | "borrow" | "repay",
  amount: string
): Promise<string> {
  const form = lendingForm(page);
  // Operation <select> (the first one in the form).
  await form.locator('select').filter({has: page.locator('option[value="supply"]')}).selectOption(op);
  // Asset is a TokenSelect — choose USDC by value.
  await form.locator("label").filter({hasText: /^Asset/}).locator("select").selectOption(USDC);
  await form.getByPlaceholder("100").fill(amount);
  await form.getByRole("button", {name: "Build"}).click();
  return submitProposal(page);
}

test("AAVE supply via vote → execute", async ({page}) => {
  await page.goto("/lending");
  await connectWallet(page);
  const id = await buildLending(page, "supply", "100");
  await voteExecute(page, id);
});

test("AAVE withdraw via vote → execute", async ({page}) => {
  await page.goto("/lending");
  await connectWallet(page);
  const id = await buildLending(page, "withdraw", "100");
  await voteExecute(page, id);
});

test("AAVE borrow via vote → execute (DAO takes on debt)", async ({page}) => {
  await page.goto("/lending");
  await connectWallet(page);
  const id = await buildLending(page, "borrow", "500");
  await voteExecute(page, id);

  // Debt now exists → the "No debt." banner is gone.
  await page.goto("/lending");
  await connectWallet(page);
  await expect(page.getByText(/No debt\./)).toHaveCount(0, {timeout: 30_000});
});

test("AAVE borrow then repay via vote → execute", async ({page}) => {
  await page.goto("/lending");
  await connectWallet(page);
  const borrowId = await buildLending(page, "borrow", "500");
  await voteExecute(page, borrowId);

  // Repay needs existing debt (just created) + USDC in the treasury (borrowed).
  await page.goto("/lending");
  await connectWallet(page);
  const repayId = await buildLending(page, "repay", "200");
  await voteExecute(page, repayId);
});
