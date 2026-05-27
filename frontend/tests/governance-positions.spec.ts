import {test, expect} from "@playwright/test";
import {injectAnvilProvider, connectWallet} from "./fixtures/inject-provider";
import {submitProposal, voteExecute, evmSnapshot, evmRevert} from "./fixtures/governance";

// Uniswap V3 LP write coverage via the positions page (preview multi-action).
// The seed minted 2 V3 positions, so a third mint asserts the count increments.
// V4 LP + swap need pasted v4/router calldata (no StateView configured), so
// they're covered as calldata smokes in governance-admin.spec.ts and by the
// positions read-smoke; full V4 execute is left to the contract fork tests.

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"; // lower address
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"; // higher address

let snap: string;
test.beforeEach(async ({page}) => {
  snap = await evmSnapshot();
  await injectAnvilProvider(page);
});
test.afterEach(async () => {
  await evmRevert(snap);
});

test("V3 mint via vote → execute (position count increments)", async ({page}) => {
  await page.goto("/positions");
  await connectWallet(page);

  const form = page
    .locator("div.form")
    .filter({has: page.getByPlaceholder("0x… (lower addr)")});
  await form.getByPlaceholder("0x… (lower addr)").fill(USDC);
  await form.getByPlaceholder("0x… (higher addr)").fill(WETH);
  await form.getByPlaceholder("3000").fill("3000");
  await form.getByPlaceholder("1000").fill("1000");
  await form.getByLabel("dec0").fill("6");
  await form.getByPlaceholder("0.5").fill("0.3");
  await form.getByLabel("dec1").fill("18");
  // full-range checkbox is checked by default → no tick inputs needed.
  await form.getByRole("button", {name: "Build"}).click();
  const id = await submitProposal(page);
  await voteExecute(page, id);

  // Seed minted 2 → now 3.
  await page.goto("/positions");
  await connectWallet(page);
  await page.getByRole("button", {name: /Load positions|Refresh/}).first().click();
  await expect(page.getByText(/Uniswap V3 \(3\)/)).toBeVisible({timeout: 45_000});
});

test("V3 collect Simulate reports live fees on a seeded position", async ({page}) => {
  await page.goto("/positions");
  await connectWallet(page);
  await page.getByRole("button", {name: /Load positions|Refresh/}).first().click();
  await expect(page.getByText(/Uniswap V3 \(2\)/)).toBeVisible({timeout: 45_000});

  // Each V3 position row has a "Simulate" button (NPM.callStatic.collect).
  await page.getByRole("button", {name: /^Simulate$/}).first().click();
  // Result renders without an error (fees may be 0 — we only assert no failure).
  await expect(page.getByText(/Simulate failed|reverted/i)).toHaveCount(0, {timeout: 30_000});
});
