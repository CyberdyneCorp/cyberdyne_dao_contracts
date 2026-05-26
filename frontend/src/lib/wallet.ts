// Wallet connectivity: WalletConnect v2 (primary) + injected (MetaMask) fallback.
// Exposes a single Svelte store with the connected account + signer.

import {writable, derived, get} from "svelte/store";
import {ethers} from "ethers";
import {env} from "$env/dynamic/public";

export type WalletState =
  | {status: "disconnected"}
  | {status: "connecting"}
  | {
      status: "connected";
      address: string;
      chainId: number;
      provider: ethers.providers.Web3Provider;
      kind: "injected" | "walletconnect";
    }
  | {status: "error"; message: string};

export const wallet = writable<WalletState>({status: "disconnected"});

// Derived signer — null when not connected.
export const signer = derived(wallet, ($w) =>
  $w.status === "connected" ? $w.provider.getSigner() : null
);

async function _connectInjected(): Promise<void> {
  if (!window.ethereum) throw new Error("No injected wallet — install MetaMask or use WalletConnect.");
  wallet.set({status: "connecting"});
  try {
    const provider = new ethers.providers.Web3Provider(window.ethereum, "any");
    const accounts = (await provider.send("eth_requestAccounts", [])) as string[];
    const {chainId} = await provider.getNetwork();
    wallet.set({
      status: "connected",
      address: accounts[0],
      chainId,
      provider,
      kind: "injected",
    });
    // Re-fetch state on chain/account change.
    window.ethereum.on?.("chainChanged", () => location.reload());
    window.ethereum.on?.("accountsChanged", (accs) => {
      const next = (accs as string[])[0];
      const current = get(wallet);
      if (current.status !== "connected") return;
      if (!next) {
        wallet.set({status: "disconnected"});
      } else {
        wallet.set({...current, address: next});
      }
    });
  } catch (err) {
    wallet.set({status: "error", message: (err as Error).message});
  }
}

async function _connectWalletConnect(): Promise<void> {
  const projectId = env.PUBLIC_WC_PROJECT_ID;
  if (!projectId) {
    wallet.set({status: "error", message: "PUBLIC_WC_PROJECT_ID is not set."});
    return;
  }
  wallet.set({status: "connecting"});
  try {
    // Dynamic import keeps WC v2 (heavy) out of the initial bundle.
    const {EthereumProvider} = await import("@walletconnect/ethereum-provider");
    const wcProvider = await EthereumProvider.init({
      projectId,
      chains: [1, 8453, 11155111, 84532],
      optionalChains: [137, 42161, 10],
      showQrModal: true,
    });
    await wcProvider.enable();
    const provider = new ethers.providers.Web3Provider(wcProvider as never, "any");
    const accounts = await provider.listAccounts();
    const {chainId} = await provider.getNetwork();
    wallet.set({
      status: "connected",
      address: accounts[0],
      chainId,
      provider,
      kind: "walletconnect",
    });
    wcProvider.on("chainChanged", () => location.reload());
    wcProvider.on("accountsChanged", (accs: string[]) => {
      const current = get(wallet);
      if (current.status !== "connected") return;
      if (!accs[0]) wallet.set({status: "disconnected"});
      else wallet.set({...current, address: accs[0]});
    });
    wcProvider.on("disconnect", () => wallet.set({status: "disconnected"}));
  } catch (err) {
    wallet.set({status: "error", message: (err as Error).message});
  }
}

export const connectInjected = _connectInjected;
export const connectWalletConnect = _connectWalletConnect;

export function disconnect(): void {
  wallet.set({status: "disconnected"});
}

export async function switchChain(chainId: number): Promise<void> {
  const w = get(wallet);
  if (w.status !== "connected") throw new Error("Connect a wallet first");
  const hex = "0x" + chainId.toString(16);
  await w.provider.send("wallet_switchEthereumChain", [{chainId: hex}]);
}
