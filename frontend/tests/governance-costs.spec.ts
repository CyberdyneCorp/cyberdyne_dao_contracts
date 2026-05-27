import {test, expect} from "@playwright/test";
import {injectAnvilProvider, connectWallet} from "./fixtures/inject-provider";
import {submitProposal, voteExecute, onchain, evmSnapshot, evmRevert} from "./fixtures/governance";

// Full write coverage for the CostRegistry plugin, driven through the UI.
// Each test runs against the clean seeded state via an anvil snapshot/revert.
// Seeded entries (id order): AWS, Datadog, OpenAI, GitHub, Cloudflare.

let snap: string;
test.beforeEach(async ({page}) => {
  snap = await evmSnapshot();
  await injectAnvilProvider(page);
});
test.afterEach(async () => {
  await evmRevert(snap);
});

// The register/update form is the one containing the "AWS" name placeholder.
function registerForm(page: import("@playwright/test").Page) {
  return page.locator("div.form").filter({has: page.getByPlaceholder("AWS")}).first();
}

test("registerEntry via vote → execute (new entry shows on /costs)", async ({page}) => {
  const name = `E2E-${Date.now()}`;
  await page.goto("/costs");
  await connectWallet(page);
  const form = registerForm(page);
  await form.getByPlaceholder("AWS").fill(name);
  await form.getByPlaceholder("cloud bill").fill("e2e managed cost");
  await form.getByPlaceholder("500").fill("123");
  await form.getByPlaceholder("30").fill("30");
  await form.getByPlaceholder("0x...").fill("0x976EA74026E726554dB657fA54763abd0C3a0aa9");
  await form.getByRole("button", {name: "Build"}).click();
  const id = await submitProposal(page);
  await voteExecute(page, id);

  await page.goto("/costs");
  await connectWallet(page);
  await expect(page.getByText(name)).toBeVisible({timeout: 30_000});
});

test("updateEntry via vote → execute (entry #0 renamed)", async ({page}) => {
  await page.goto("/costs");
  await connectWallet(page);
  const form = registerForm(page);
  // id 0 = AWS → rename to AWS-prod, keep it a valid entry.
  await form.getByPlaceholder("blank = new").fill("0");
  await form.getByPlaceholder("AWS").fill("AWS-prod");
  await form.getByPlaceholder("cloud bill").fill("prod cloud");
  await form.getByPlaceholder("500").fill("1500");
  await form.getByPlaceholder("30").fill("30");
  await form.getByPlaceholder("0x...").fill("0x976EA74026E726554dB657fA54763abd0C3a0aa9");
  await form.getByRole("button", {name: "Build"}).click();
  const id = await submitProposal(page);
  await voteExecute(page, id);

  await page.goto("/costs");
  await connectWallet(page);
  await expect(page.getByText("AWS-prod")).toBeVisible({timeout: 30_000});
});

test("removeEntry via vote → execute (row flips to removed)", async ({page}) => {
  await page.goto("/costs");
  await connectWallet(page);
  // The remove form: a div.form with the "0" id placeholder and no name field.
  const removeForm = page
    .locator("div.form")
    .filter({has: page.getByPlaceholder("0", {exact: true})})
    .filter({hasNot: page.getByPlaceholder("AWS")});
  await removeForm.getByPlaceholder("0", {exact: true}).fill("1"); // Datadog
  await removeForm.getByRole("button", {name: "Build"}).click();
  const id = await submitProposal(page);
  await voteExecute(page, id);

  await page.goto("/costs");
  await connectWallet(page);
  await expect(page.getByText("removed").first()).toBeVisible({timeout: 30_000});
});

test("setMaxEntries via vote → execute (verified on-chain)", async ({page}) => {
  await page.goto("/costs");
  await connectWallet(page);
  const form = page
    .locator("div.form")
    .filter({has: page.getByPlaceholder("500", {exact: true})})
    .filter({hasNot: page.getByPlaceholder("AWS")});
  await form.getByPlaceholder("500", {exact: true}).fill("900");
  await form.getByRole("button", {name: "Build"}).click();
  const id = await submitProposal(page);
  await voteExecute(page, id);

  const cost = onchain("E2E_COST", ["function MAX_ENTRIES() view returns (uint256)"]);
  expect((await cost.MAX_ENTRIES()).toString()).toBe("900");
});

test("processDue crank confirms a tx (permissionless)", async ({page}) => {
  await page.goto("/costs");
  await connectWallet(page);
  await page.getByRole("button", {name: "processDue"}).click();
  await expect(page.getByText(/Confirmed in block|Submitted/)).toBeVisible({timeout: 30_000});
});
