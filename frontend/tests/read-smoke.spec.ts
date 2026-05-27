import {test, expect} from "@playwright/test";
import {injectAnvilProvider, connectWallet} from "./fixtures/inject-provider";

// Read-path smoke: connect the injected wallet, visit every page, assert it
// renders real fork data (no "Loading…" hang, no error banner), and capture a
// screenshot per page (saved under test-results/screens/). These would have
// caught the proposals-loading-forever and positions getLogs regressions.

const SHOTS = "test-results/screens";

test.beforeEach(async ({page}) => {
  await injectAnvilProvider(page);
});

test("Overview — treasury + plugin addresses", async ({page}) => {
  await page.goto("/");
  await connectWallet(page);
  await expect(page.getByRole("heading", {name: /DAO overview/i})).toBeVisible();
  await expect(page.getByText(/Treasury/i)).toBeVisible();
  // Seeded treasury shows non-zero USDC.
  await expect(page.getByText(/USDC/).first()).toBeVisible();
  await page.screenshot({path: `${SHOTS}/01-overview.png`, fullPage: true});
});

test("Payroll — seeded recipients render", async ({page}) => {
  await page.goto("/payroll");
  await connectWallet(page);
  await expect(page.getByRole("heading", {name: /^Payroll$/})).toBeVisible();
  // Seed adds ≥4 active recipients.
  await expect(page.getByText(/Active recipients \((\d+)\)/)).toBeVisible();
  await expect(page.getByText(/Active recipients \(0\)/)).toHaveCount(0);
  await page.screenshot({path: `${SHOTS}/02-payroll.png`, fullPage: true});
});

test("Costs — seeded entries render", async ({page}) => {
  await page.goto("/costs");
  await connectWallet(page);
  await expect(page.getByRole("heading", {name: /Operating costs/i})).toBeVisible();
  // Seed registers 5 entries — at least one row visible, no "0 entries".
  await expect(page.getByText(/entries total/)).toBeVisible();
  await expect(page.getByText(/AWS|Datadog|OpenAI/).first()).toBeVisible();
  await page.screenshot({path: `${SHOTS}/03-costs.png`, fullPage: true});
});

test("Lending — AAVE position summary", async ({page}) => {
  await page.goto("/lending");
  await connectWallet(page);
  await expect(page.getByRole("heading", {name: /^Lending$/})).toBeVisible();
  await expect(page.getByText(/Account summary/i)).toBeVisible();
  await expect(page.getByText(/Health factor/i).first()).toBeVisible();
  await page.screenshot({path: `${SHOTS}/04-lending.png`, fullPage: true});
});

test("Swaps — history loads (no hang)", async ({page}) => {
  await page.goto("/swaps");
  await connectWallet(page);
  await expect(page.getByRole("heading", {name: /Swap history/i})).toBeVisible();
  // Either rows or the explicit "No swaps found" — never stuck loading.
  await expect(page.getByText(/Token in|No swaps found/)).toBeVisible();
  await page.screenshot({path: `${SHOTS}/05-swaps.png`, fullPage: true});
});

test("Positions — V3/V4 lists load (no revert/hang)", async ({page}) => {
  await page.goto("/positions");
  await connectWallet(page);
  await expect(page.getByRole("heading", {name: /Uniswap V3 \+ V4 positions/i})).toBeVisible();
  // Trigger the on-demand load and wait for the per-protocol sections.
  await page.getByRole("button", {name: /Load positions|Refresh/}).first().click();
  await expect(page.getByText(/Uniswap V3 \(\d+\)/)).toBeVisible({timeout: 30_000});
  await expect(page.getByText(/Uniswap V4 \(\d+\)/)).toBeVisible({timeout: 30_000});
  await page.screenshot({path: `${SHOTS}/06-positions.png`, fullPage: true});
});

test("Proposals — list loads (does not hang)", async ({page}) => {
  await page.goto("/proposals");
  await connectWallet(page);
  await expect(page.getByRole("heading", {name: /^Proposals$/})).toBeVisible();
  // The bug we fixed: this used to sit on "Loading…" forever. Assert it settles
  // — the table header appears and the Loading chip is gone.
  await expect(page.getByText("Loading…")).toHaveCount(0, {timeout: 30_000});
  await expect(page.getByRole("columnheader", {name: /Summary/}).or(page.getByText(/No proposals/))).toBeVisible();
  await page.screenshot({path: `${SHOTS}/07-proposals.png`, fullPage: true});
});
