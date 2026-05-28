import {expect, type Page} from "@playwright/test";
import {ethers} from "ethers";
import {connectWallet} from "./inject-provider";

const RPC = process.env.E2E_RPC || "http://127.0.0.1:8545";

export function rpcProvider(): ethers.providers.JsonRpcProvider {
  return new ethers.providers.JsonRpcProvider(RPC);
}

// --- anvil snapshot/revert so each write test runs against the clean seeded
// state and can't pollute the next one (the suite shares one fork). ---
export async function evmSnapshot(): Promise<string> {
  return (await rpcProvider().send("evm_snapshot", [])) as string;
}
export async function evmRevert(id: string): Promise<void> {
  await rpcProvider().send("evm_revert", [id]);
}

// --- governance flow helpers (drive the real propose -> vote -> execute UI) ---

/** Click "Submit as proposal" and return the new proposal's id (from the
 *  "Proposal N created" toast). Assumes the action is already Built. */
export async function submitProposal(page: Page): Promise<string> {
  // Single-action → "Submit as proposal"; multi-action preview batches →
  // "Submit as N-action proposal".
  await page.getByRole("button", {name: /Submit as .*proposal/i}).click();
  const created = page.getByText(/Proposal\s+\d+\s+created/i);
  await expect(created).toBeVisible({timeout: 30_000});
  return (await created.textContent())!.match(/Proposal\s+(\d+)/i)![1];
}

/** Vote on proposal `id` and execute it (EarlyExecution + 100% power makes a
 *  Yes immediately executable). Targets the exact row by its id cell. */
export async function voteExecute(
  page: Page,
  id: string,
  vote: "Yes" | "No" | "Abstain" = "Yes"
): Promise<void> {
  await page.goto("/proposals");
  await connectWallet(page);
  await page.getByRole("button", {name: /^Refresh$/}).click();
  const row = page
    .getByRole("row")
    .filter({has: page.getByRole("cell", {name: id, exact: true})});
  await expect(row).toBeVisible({timeout: 30_000});
  await row.getByRole("button", {name: new RegExp(`^${vote}$`)}).click();
  const exec = row.getByRole("button", {name: /^Execute$/});
  await expect(exec).toBeVisible({timeout: 30_000});
  await exec.click();
  await expect(row.getByText(/^executed$/i)).toBeVisible({timeout: 30_000});
}

/** Build an admin action from the proposals "Build an action" dropdown, submit
 *  it, and return the proposal id. `kind` is the <option value>.
 *
 *  The form renders typed fields per kind (no more generic "Arg A" / "Arg B"
 *  labels), so we drive by ordinal position: the first label is the Action
 *  picker; subsequent labels are the per-kind inputs. argA fills the first
 *  field, argB the second. Boolean fields render as a <select> — auto-detected
 *  here so `argB = "true" | "false"` keeps working for set***(bool) kinds. */
export async function buildAdminAction(
  page: Page,
  kind: string,
  argA: string,
  argB?: string
): Promise<string> {
  await page.goto("/proposals");
  await connectWallet(page);
  const actionSelect = page.locator("select").filter({has: page.locator('option[value="raw"]')});
  await actionSelect.selectOption(kind);

  const form = page.locator("div.form").filter({has: actionSelect});
  // Skip the "Action" picker label; subsequent labels are the field labels.
  const fieldLabels = form.locator("label").filter({hasNotText: /^\s*Action\b/});

  async function fillField(idx: number, value: string): Promise<void> {
    const lbl = fieldLabels.nth(idx);
    const select = lbl.locator("select");
    if ((await select.count()) > 0) {
      await select.selectOption(value);
    } else {
      await lbl.locator("input").first().fill(value);
    }
  }

  await fillField(0, argA);
  if (argB !== undefined) await fillField(1, argB);
  await page.getByRole("button", {name: /^Build$/}).click();
  return submitProposal(page);
}

/** Minimal read-only contract bound to an E2E_* address (set by global-setup). */
export function onchain(addrEnv: string, abi: string[]): ethers.Contract {
  const addr = process.env[addrEnv];
  if (!addr) throw new Error(`${addrEnv} not set by global-setup`);
  return new ethers.Contract(addr, abi, rpcProvider());
}
