import {test, expect} from "@playwright/test";
import {injectAnvilProvider, connectWallet} from "./fixtures/inject-provider";

// Governance write loop for the CostRegistry plugin (a different plugin + ABI
// path than the payroll flow in governance.spec.ts), end-to-end through the UI:
//   Costs "Propose: register entry" → Build → Submit as proposal
//   → Proposals → vote Yes → Execute → assert the new entry shows on /costs.
//
// This exercises the CostRegistryPlugin.registerEntry write path against the
// deployed build — the kind of path where a hidden ABI/overload mismatch
// (like the createProposal 5-arg/7-arg bug) would otherwise hide.

test("propose → vote → execute: register a cost entry", async ({page}) => {
  // Unique name per run so the entry is findable and re-runs don't collide
  // (registerEntry does not dedupe names).
  const name = `E2E-${Date.now()}`;
  const PAYEE = "0x" + Date.now().toString(16).padStart(40, "0");

  await injectAnvilProvider(page);

  // 1. Build + submit from the Costs page register form.
  await page.goto("/costs");
  await connectWallet(page);
  await page.getByRole("heading", {name: /Propose: register \/ update entry/i}).waitFor();

  // Scope to the register form (the one whose name field placeholder is "AWS").
  const form = page.locator("div.form").filter({has: page.getByPlaceholder("AWS")}).first();
  await form.getByPlaceholder("AWS").fill(name);
  await form.getByPlaceholder("cloud bill").fill("e2e managed cost");
  await form.getByPlaceholder("500").fill("123");
  await form.getByPlaceholder("30").fill("30");
  await form.getByPlaceholder("0x...").fill(PAYEE);
  await form.getByRole("button", {name: "Build"}).click();

  const submit = page.getByRole("button", {name: /Submit as proposal/i});
  await submit.click();
  const created = page.getByText(/Proposal\s+\d+\s+created/i);
  await expect(created).toBeVisible({timeout: 30_000});
  const proposalId = (await created.textContent())!.match(/Proposal\s+(\d+)/i)![1];

  // 2. Vote + execute, targeting our exact proposal by its id cell.
  await page.goto("/proposals");
  await connectWallet(page);
  await page.getByRole("button", {name: /^Refresh$/}).click();
  const row = page
    .getByRole("row")
    .filter({has: page.getByRole("cell", {name: proposalId, exact: true})});
  await expect(row).toBeVisible({timeout: 30_000});
  await row.getByRole("button", {name: /^Yes$/}).click();
  const exec = row.getByRole("button", {name: /^Execute$/});
  await expect(exec).toBeVisible({timeout: 30_000});
  await exec.click();
  await expect(row.getByText(/^executed$/i)).toBeVisible({timeout: 30_000});

  // 3. The new entry is now live on the Costs page.
  await page.goto("/costs");
  await connectWallet(page);
  await expect(page.getByText(name)).toBeVisible({timeout: 30_000});
  await page.screenshot({path: "test-results/screens/09-costs-registered.png", fullPage: true});
});
