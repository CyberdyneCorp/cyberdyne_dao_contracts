import {sveltekit} from "@sveltejs/kit/vite";
import {defineConfig} from "vite";

export default defineConfig({
  plugins: [sveltekit()],
  server: {
    port: 5173,
    strictPort: false,
  },
  // ethers v5 + WalletConnect both ship CJS that needs interop.
  optimizeDeps: {
    include: ["ethers", "@walletconnect/ethereum-provider"],
  },
});
