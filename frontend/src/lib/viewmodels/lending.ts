// Lending (AAVE) ViewModel (MVVM): plugin state + account summary + per-asset
// positions read live from the AAVE Pool, plus the propose-operation builder.

import {ethers} from "ethers";
import {writable, get} from "svelte/store";
import {wallet} from "$lib/wallet";
import {chainConfig} from "$lib/chains";
import {aaveContract, erc20} from "$lib/contracts";
import * as actions from "$lib/actions";
import type {ProposalAction} from "$lib/actions";
import type {ChainConfig} from "$lib/types";
import {toasts} from "$lib/stores/toasts";
import {errorMessage, resolveToken} from "$lib/format";

const POOL_ABI = [
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
  "function getReserveData(address asset) view returns (uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress)",
];
const TRACKED = ["USDC", "WETH"] as const;

export type Op = "supply" | "withdraw" | "borrow" | "repay";
export type Position = {symbol: string; supplied: ethers.BigNumber; debt: ethers.BigNumber; decimals: number};
export type AccountData = {
  totalCollateralBase: ethers.BigNumber;
  totalDebtBase: ethers.BigNumber;
  availableBorrowsBase: ethers.BigNumber;
  ltv: ethers.BigNumber;
  healthFactor: ethers.BigNumber;
};
export type LendingData = {
  cfg: ChainConfig;
  adapter: string;
  allowlistEnforced: boolean;
  opNonce: ethers.BigNumber;
  account: AccountData;
  positions: Position[];
};

export function createLendingVM() {
  const loading = writable(false);
  const loadError = writable<string | null>(null);
  const noDao = writable(false);
  const data = writable<LendingData | null>(null);

  const op = writable<Op>("supply");
  const lAsset = writable("");
  const lAmount = writable("");
  const lDecimals = writable("6");
  const lRateMode = writable("2");
  const lendingAction = writable<ProposalAction[] | null>(null);

  async function load(): Promise<void> {
    const w = get(wallet);
    noDao.set(false);
    if (w.status !== "connected") {
      data.set(null);
      return;
    }
    const cfg = chainConfig(w.chainId);
    if (!cfg?.dao) {
      noDao.set(true);
      data.set(null);
      return;
    }
    loading.set(true);
    loadError.set(null);
    try {
      if (!cfg.external.AAVE_V3_POOL) throw new Error(`AAVE v3 not available on ${cfg.name}`);
      const aave = aaveContract(cfg, w.provider);
      const pool = new ethers.Contract(cfg.external.AAVE_V3_POOL, POOL_ABI, w.provider);
      const [adapter, allowlistEnforced, opNonce, account] = await Promise.all([
        aave.adapter(),
        aave.allowlistEnforced(),
        aave.opNonce(),
        pool.getUserAccountData(cfg.dao.dao),
      ]);
      const positions = (
        await Promise.all(
          TRACKED.map(async (sym) => {
            const asset = cfg.external[sym];
            if (!asset) return null;
            const reserve = await pool.getReserveData(asset);
            const [supplied, debt, decimals] = await Promise.all([
              erc20(reserve.aTokenAddress, w.provider).balanceOf(cfg.dao!.dao),
              erc20(reserve.variableDebtTokenAddress, w.provider).balanceOf(cfg.dao!.dao),
              erc20(asset, w.provider).decimals(),
            ]);
            return {symbol: sym, supplied, debt, decimals};
          })
        )
      ).filter((p) => p !== null) as Position[];
      data.set({cfg, adapter, allowlistEnforced, opNonce, account, positions});
    } catch (err) {
      loadError.set(errorMessage(err));
      toasts.error(`Lending load failed: ${errorMessage(err)}`);
    } finally {
      loading.set(false);
    }
  }

  async function buildLending(): Promise<void> {
    lendingAction.set(null);
    try {
      const w = get(wallet);
      if (w.status !== "connected") throw new Error("Connect a wallet");
      const cfg = chainConfig(w.chainId);
      if (!cfg?.dao) throw new Error("No DAO configured");
      const asset = get(lAsset);
      // Derive decimals from the token book; the manual `lDecimals` store is
      // kept only as an escape hatch for custom assets the cfg doesn't know
      // (resolveToken returns 18 for unknowns, override via lDecimals).
      const fallbackDec = parseInt(get(lDecimals), 10);
      const tok = resolveToken(cfg, asset);
      const dec = tok.symbol === "USDC" || tok.symbol === "WETH" ? tok.decimals : fallbackDec || tok.decimals;
      const amount = ethers.utils.parseUnits(get(lAmount) || "0", dec);
      const mode = parseInt(get(lRateMode), 10);
      const o = get(op);
      const batch =
        o === "supply"
          ? await actions.previewAaveSupply(cfg, w.provider, asset, amount)
          : o === "withdraw"
            ? await actions.previewAaveWithdraw(cfg, w.provider, asset, amount)
            : o === "borrow"
              ? await actions.previewAaveBorrow(cfg, w.provider, asset, amount, mode)
              : await actions.previewAaveRepay(cfg, w.provider, asset, amount, mode);
      lendingAction.set(batch);
    } catch (err) {
      toasts.error(`Build failed: ${errorMessage(err)}`);
    }
  }

  return {
    loading,
    loadError,
    noDao,
    data,
    op,
    lAsset,
    lAmount,
    lDecimals,
    lRateMode,
    lendingAction,
    load,
    buildLending,
  };
}

// --- Health-factor display helpers (pure) ---

export type HealthTier = "none" | "ok" | "warn" | "danger";

export function fmtHealth(hf: ethers.BigNumber): string {
  if (hf.gt(ethers.constants.MaxUint256.div(2))) return "∞ (no debt)";
  return (Number(hf.toString()) / 1e18).toFixed(3);
}

export function healthTier(hf: ethers.BigNumber): HealthTier {
  if (hf.gt(ethers.constants.MaxUint256.div(2))) return "none";
  const ONE = ethers.BigNumber.from("1000000000000000000");
  if (hf.gte(ONE.mul(3).div(2))) return "ok";
  if (hf.gte(ONE)) return "warn";
  return "danger";
}

export function healthBlurb(tier: HealthTier): string {
  switch (tier) {
    case "none":
      return "DAO has no outstanding AAVE debt — health factor is undefined.";
    case "ok":
      return "Healthy. Health factor ≥ 1.5 means the position has headroom against price moves.";
    case "warn":
      return "Caution: health factor < 1.5. A modest adverse price move could push the DAO toward liquidation. Avoid new borrows; consider repaying or supplying more collateral.";
    case "danger":
      return "Liquidatable: health factor < 1.0. The position can be liquidated right now. Repay or top up collateral immediately.";
  }
}
