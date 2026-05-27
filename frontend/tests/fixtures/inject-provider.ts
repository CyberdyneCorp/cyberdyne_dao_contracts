import type {Page} from "@playwright/test";

// Anvil default account #0 — holds the 1M CYBR governance token after deploy
// (GOV_TOKEN_HOLDER defaults to the deployer = this account).
export const ANVIL_ACCOUNT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
export const ANVIL_CHAIN_ID = 31337;

/**
 * Inject a minimal EIP-1193 provider as `window.ethereum` BEFORE the app's
 * scripts run, so the toy frontend's "injected wallet" path connects with no
 * MetaMask extension and no approval popups.
 *
 * It proxies every JSON-RPC call to the local anvil node. anvil's default
 * accounts are UNLOCKED, so `eth_sendTransaction` (vote / propose / execute)
 * is signed server-side — no key handling in the browser. The only special
 * cases are the MetaMask-flavoured account/chain methods anvil doesn't expose.
 */
export async function injectAnvilProvider(
  page: Page,
  rpcUrl = "http://127.0.0.1:8545"
): Promise<void> {
  await page.addInitScript(
    ({rpc, account, chainId}) => {
      const CHAIN_HEX = "0x" + chainId.toString(16);
      let id = 0;
      async function rpcCall(method: string, params: unknown[]): Promise<unknown> {
        const res = await fetch(rpc, {
          method: "POST",
          headers: {"content-type": "application/json"},
          body: JSON.stringify({jsonrpc: "2.0", id: ++id, method, params: params || []}),
        });
        const json = await res.json();
        if (json.error) {
          const e = new Error(json.error.message || "RPC error") as Error & {code?: number; data?: unknown};
          e.code = json.error.code;
          e.data = json.error.data;
          throw e;
        }
        return json.result;
      }

      const listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
      const provider = {
        isMetaMask: true,
        // ethers v5 detects EIP-1193 via `request`.
        async request({method, params}: {method: string; params?: unknown[]}): Promise<unknown> {
          switch (method) {
            case "eth_requestAccounts":
            case "eth_accounts":
              return [account];
            case "eth_chainId":
              return CHAIN_HEX;
            case "net_version":
              return String(chainId);
            case "wallet_switchEthereumChain":
            case "wallet_addEthereumChain":
              return null; // single-chain test node — no-op
            default:
              return rpcCall(method, params || []);
          }
        },
        on(event: string, handler: (...a: unknown[]) => void) {
          (listeners[event] ||= []).push(handler);
          return provider;
        },
        removeListener(event: string, handler: (...a: unknown[]) => void) {
          listeners[event] = (listeners[event] || []).filter((h) => h !== handler);
          return provider;
        },
        // Legacy shims some libs still probe for.
        enable() {
          return Promise.resolve([account]);
        },
      };
      (window as unknown as {ethereum: unknown}).ethereum = provider;
    },
    {rpc: rpcUrl, account: ANVIL_ACCOUNT, chainId: ANVIL_CHAIN_ID}
  );
}

/** Click the wallet bar's "Connect injected" control and wait until connected. */
export async function connectWallet(page: Page): Promise<void> {
  // Connected state renders the short address (0xf39F…2266) in the wallet bar.
  const addr = page.getByText(/0xf39f/i).first();
  if (await addr.isVisible().catch(() => false)) return; // already connected
  // .click() auto-waits for the button to hydrate + be actionable (avoids the
  // load-timing race where a plain isVisible() check skips the click).
  await page.getByRole("button", {name: "Connect injected"}).click();
  await addr.waitFor({timeout: 15_000});
}
