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

  const form = page.locator('[data-form="v3-mint"]');
  // TokenSelect dropdowns; pick by address value.
  await form.locator("label").filter({hasText: "token0"}).locator("select").selectOption(USDC);
  await form.locator("label").filter({hasText: "token1"}).locator("select").selectOption(WETH);
  await form.locator("label").filter({hasText: "fee tier"}).locator("select").selectOption("3000");
  await form.locator("label").filter({hasText: /^amount0/}).locator("input").fill("1000");
  await form.locator("label").filter({hasText: /^amount1/}).locator("input").fill("0.3");
  // Full range mints consume amounts proportional to the pool's current price,
  // which can diverge from desired by far more than the default 0.5% slippage —
  // widen the tolerance so the NPM doesn't revert on amount0Min/amount1Min.
  await form.locator("label").filter({hasText: "slippage %"}).locator("input").fill("100");
  // Decimals auto-resolve via cfg (USDC=6, WETH=18). full-range default ON.
  await form.getByRole("button", {name: "Build"}).click();
  const id = await submitProposal(page);
  await voteExecute(page, id);

  // Seed minted 2 → now 3.
  await page.goto("/positions");
  await connectWallet(page);
  await page.getByRole("button", {name: /Load positions|Refresh/}).first().click();
  await expect(page.getByText(/Uniswap V3 \(3\)/)).toBeVisible({timeout: 45_000});
});

test("V4 LP mint via vote → execute (real v4 PositionManager, count increments)", async ({page}) => {
  await page.goto("/positions");
  await connectWallet(page);

  // Pool key: live mainnet v4 USDC/WETH pool (fee 3000 → tickSpacing 60 auto).
  const poolForm = page.locator('[data-form="v4-pool"]');
  await poolForm.locator("label").filter({hasText: "token A"}).locator("select").selectOption(USDC);
  await poolForm.locator("label").filter({hasText: "token B"}).locator("select").selectOption(WETH);
  await poolForm.locator("label").filter({hasText: "fee tier"}).locator("select").selectOption("3000");

  // Narrow range straddling the live tick (~199951). Disable auto-derive so we
  // paste a known L + maxes (deterministic; the auto-derive path would also
  // work but needs Quote pool + math the test would replicate).
  const mintForm = page.locator('[data-form="v4-mint"]');
  await mintForm.locator("label").filter({hasText: "tickLower"}).locator("input").fill("199800");
  await mintForm.locator("label").filter({hasText: "tickUpper"}).locator("input").fill("200100");
  await mintForm.locator("label.chk").locator('input[type="checkbox"]').uncheck();

  // The raw L + maxes section (a sibling <details>) is now visible.
  const rawSection = page.locator("details", {hasText: "Raw L + maxes"});
  await rawSection.locator("label").filter({hasText: /^liquidity \(L\)/}).locator("input").fill("1000000000000");
  await rawSection.locator("label").filter({hasText: /^amount0Max/}).locator("input").fill("10000");
  await rawSection.locator("label").filter({hasText: /^amount1Max/}).locator("input").fill("5");
  await mintForm.getByRole("button", {name: "Build"}).click();

  const id = await submitProposal(page);
  await voteExecute(page, id);

  // The seed makes V4 swaps (no LP positions), so the DAO's V4 position count
  // goes 0 → 1.
  await page.goto("/positions");
  await connectWallet(page);
  await page.getByRole("button", {name: /Load positions|Refresh/}).first().click();
  await expect(page.getByText(/Uniswap V4 \(1\)/)).toBeVisible({timeout: 45_000});
});

test("V3 increase liquidity via vote → execute (on a seeded position)", async ({page}) => {
  await page.goto("/positions");
  await connectWallet(page);
  await page.getByRole("button", {name: /Load positions|Refresh/}).first().click();
  await expect(page.getByText(/Uniswap V3 \(2\)/)).toBeVisible({timeout: 45_000});

  // Prefill the manage form (tokenId + token0 + token1 + liquidity) from the
  // first seeded V3 row via its per-row "Manage ↓" button.
  await page.getByRole("button", {name: /^Manage ↓$/}).first().click();

  // Increase section has the "0.05" placeholder on amount1 — unique to that
  // form on this page.
  const incForm = page.locator("div.form").filter({has: page.getByPlaceholder("0.05")});
  await incForm.getByPlaceholder("100").fill("10"); // 10 USDC
  await incForm.getByPlaceholder("0.05").fill("0.005"); // 0.005 WETH
  await incForm.getByRole("button", {name: /^Build$/}).click();

  const id = await submitProposal(page);
  await voteExecute(page, id);
});

test("V3 collect via vote → execute (on a seeded position)", async ({page}) => {
  await page.goto("/positions");
  await connectWallet(page);
  await page.getByRole("button", {name: /Load positions|Refresh/}).first().click();
  await expect(page.getByText(/Uniswap V3 \(2\)/)).toBeVisible({timeout: 45_000});

  // Prefill from the first row; the Collect section just needs tokenId.
  await page.getByRole("button", {name: /^Manage ↓$/}).first().click();
  await page.getByRole("button", {name: /^Build collect-max$/}).click();

  const id = await submitProposal(page);
  await voteExecute(page, id);
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
