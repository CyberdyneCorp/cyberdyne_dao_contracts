import {test, expect} from "@playwright/test";
import {injectAnvilProvider, connectWallet} from "./fixtures/inject-provider";
import {evmSnapshot, evmRevert} from "./fixtures/governance";

// Snapshot/revert so this write test doesn't leave a proposal on the shared
// fork (which would pollute the proposals list other specs read).
let snap: string;
test.beforeEach(async () => {
  snap = await evmSnapshot();
});
test.afterEach(async () => {
  await evmRevert(snap);
});

// Full governance write loop driven entirely through the UI:
//   Payroll "Propose: add recipient" → Build → Submit as proposal
//   → Proposals → vote Yes → Execute (EarlyExecution makes it immediate)
//   → assert the new recipient now shows on the Payroll page.
//
// This exercises the real preview…Actions → createProposal → vote → execute
// path against the forked chain, signed by the injected anvil account (which
// holds 100% of the governance token).

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

test("propose → vote → execute: add a payroll recipient", async ({page}) => {
  // A fresh, never-before-seen payee each run: payroll.addRecipient reverts on
  // a duplicate, so reusing a fixed address breaks re-runs against a non-reset
  // fork. Any well-formed address works — it's just a recipient record.
  const NEW_PAYEE = "0x" + Date.now().toString(16).padStart(40, "0");

  await injectAnvilProvider(page);

  // 1. Build + submit the proposal from the Payroll page.
  await page.goto("/payroll");
  await connectWallet(page);

  await page.getByRole("heading", {name: /Propose: add recipient/i}).waitFor();
  // The add-recipient form is the first .form containing a "Payee" label
  // (the set-amount form below also has one).
  const formRoot = page.locator("div.form").filter({has: page.getByText("Payee")}).first();
  await formRoot.getByPlaceholder("0x...").first().fill(NEW_PAYEE);
  await formRoot.getByPlaceholder(/0x0 for ETH/).fill(USDC);
  await formRoot.getByPlaceholder("1000").fill("4242");
  await formRoot.getByRole("button", {name: "Build"}).click();

  // ProposeAction widget appears with the single-action submit button.
  const submit = page.getByRole("button", {name: /Submit as proposal/i});
  await submit.click();
  // Capture the new proposal's id from the success message ("Proposal N
  // created …") so we can target exactly this proposal on the next page —
  // matching by summary text alone is ambiguous if the chain already carries
  // other "Payroll: add …" proposals (re-runs against a non-reset fork).
  const created = page.getByText(/Proposal\s+\d+\s+created/i);
  await expect(created).toBeVisible({timeout: 30_000});
  const proposalId = (await created.textContent())!.match(/Proposal\s+(\d+)/i)![1];

  // 2. Vote + execute on the Proposals page.
  await page.goto("/proposals");
  await connectWallet(page);
  await page.getByRole("button", {name: /^Refresh$/}).click();

  // Target our exact proposal by its id cell (the first column is an exact
  // integer; summary/tally cells never match the bare id), so the locator is
  // unique even when other Payroll proposals exist on-chain.
  const row = page
    .getByRole("row")
    .filter({has: page.getByRole("cell", {name: proposalId, exact: true})});
  await expect(row).toBeVisible({timeout: 30_000});

  await row.getByRole("button", {name: /^Yes$/}).click();
  // After the Yes vote, EarlyExecution + 100% power makes it executable —
  // the Execute button appears (the page auto-refreshes after the vote tx).
  const exec = row.getByRole("button", {name: /^Execute$/});
  await expect(exec).toBeVisible({timeout: 30_000});
  await exec.click();
  // Wait for the execute tx to confirm + the list to refresh before navigating
  // away — otherwise page.goto() cancels the in-flight tx and execution is lost.
  // The row's status cell flips to "executed" once doExecute() completes.
  await expect(row.getByText(/^executed$/i)).toBeVisible({timeout: 30_000});

  // 3. Confirm the effect landed: the new payee is now an active recipient.
  await page.goto("/payroll");
  await connectWallet(page);
  await expect(page.getByText(new RegExp(NEW_PAYEE, "i"))).toBeVisible({timeout: 30_000});
  await page.screenshot({path: "test-results/screens/08-governance-executed.png", fullPage: true});
});
