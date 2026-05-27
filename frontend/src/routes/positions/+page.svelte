<!--
  Uniswap V3 positions: propose the full LP lifecycle (mint / increase /
  decrease / collect / burn) via governance, plus a read to look up a position
  by tokenId. All ops are vote-gated; the position NFT is owned by the DAO.
-->
<script lang="ts">
  import {ethers} from "ethers";
  import {wallet} from "$lib/wallet";
  import {chainConfig} from "$lib/chains";
  import {uniswapV3Contract} from "$lib/contracts";
  import * as actions from "$lib/actions";
  import type {ProposalAction} from "$lib/actions";
  import ProposeAction from "$lib/components/ProposeAction.svelte";

  const U128_MAX = ethers.BigNumber.from(2).pow(128).sub(1);
  const FULL_LOWER = -887220;
  const FULL_UPPER = 887220;

  function farDeadline(): number {
    return Math.floor(Date.now() / 1000) + 7 * 24 * 3600; // +7d
  }
  function cfgNow() {
    const cfg = chainConfig($wallet.status === "connected" ? $wallet.chainId : 1);
    if (!cfg?.dao) throw new Error("No DAO configured");
    return cfg;
  }

  // --- Mint ---
  let mToken0 = "";
  let mToken1 = "";
  let mFee = "3000";
  let mDec0 = "6";
  let mDec1 = "18";
  let mAmt0 = "";
  let mAmt1 = "";
  let mFull = true;
  let mLower = String(FULL_LOWER);
  let mUpper = String(FULL_UPPER);
  // Governance-safe: previewMintActions returns 5 raw actions which run
  // atomically in one dao.execute (no nested-execute reentrancy under TV).
  let mintAction: ProposalAction[] | null = null;

  async function buildMint(): Promise<void> {
    mintAction = null;
    try {
      if ($wallet.status !== "connected") throw new Error("Connect a wallet");
      const cfg = cfgNow();
      mintAction = await actions.previewV3Mint(cfg, $wallet.provider, {
        token0: mToken0,
        token1: mToken1,
        fee: parseInt(mFee, 10),
        tickLower: mFull ? FULL_LOWER : parseInt(mLower, 10),
        tickUpper: mFull ? FULL_UPPER : parseInt(mUpper, 10),
        amount0Desired: ethers.utils.parseUnits(mAmt0 || "0", parseInt(mDec0, 10)),
        amount1Desired: ethers.utils.parseUnits(mAmt1 || "0", parseInt(mDec1, 10)),
        amount0Min: ethers.constants.Zero,
        amount1Min: ethers.constants.Zero,
        deadline: farDeadline(),
      });
    } catch (err) {
      alert(`Build failed: ${(err as Error).message}`);
    }
  }

  // --- Increase / Decrease / Collect / Burn (by tokenId) ---
  let opTokenId = "";
  let iAmt0 = "";
  let iAmt1 = "";
  let iDec0 = "6";
  let iDec1 = "18";
  let incAction: ProposalAction[] | null = null;
  async function buildIncrease(): Promise<void> {
    incAction = null;
    try {
      if ($wallet.status !== "connected") throw new Error("Connect a wallet");
      incAction = await actions.previewV3IncreaseLiquidity(
        cfgNow(),
        $wallet.provider,
        ethers.BigNumber.from(opTokenId || "0"),
        ethers.utils.parseUnits(iAmt0 || "0", parseInt(iDec0, 10)),
        ethers.utils.parseUnits(iAmt1 || "0", parseInt(iDec1, 10)),
        ethers.constants.Zero,
        ethers.constants.Zero,
        farDeadline()
      );
    } catch (err) {
      alert(`Build failed: ${(err as Error).message}`);
    }
  }

  let decLiquidity = "";
  let decAction: ProposalAction[] | null = null;
  async function buildDecrease(): Promise<void> {
    decAction = null;
    try {
      if ($wallet.status !== "connected") throw new Error("Connect a wallet");
      decAction = await actions.previewV3DecreaseLiquidity(
        cfgNow(),
        $wallet.provider,
        ethers.BigNumber.from(opTokenId || "0"),
        ethers.BigNumber.from(decLiquidity || "0"),
        ethers.constants.Zero,
        ethers.constants.Zero,
        farDeadline()
      );
    } catch (err) {
      alert(`Build failed: ${(err as Error).message}`);
    }
  }

  let collectAction: ProposalAction[] | null = null;
  async function buildCollect(): Promise<void> {
    collectAction = null;
    try {
      if ($wallet.status !== "connected") throw new Error("Connect a wallet");
      collectAction = await actions.previewV3Collect(
        cfgNow(),
        $wallet.provider,
        ethers.BigNumber.from(opTokenId || "0"),
        U128_MAX,
        U128_MAX
      );
    } catch (err) {
      alert(`Build failed: ${(err as Error).message}`);
    }
  }

  let burnAction: ProposalAction[] | null = null;
  async function buildBurn(): Promise<void> {
    burnAction = null;
    try {
      if ($wallet.status !== "connected") throw new Error("Connect a wallet");
      burnAction = await actions.previewV3Burn(
        cfgNow(),
        $wallet.provider,
        ethers.BigNumber.from(opTokenId || "0")
      );
    } catch (err) {
      alert(`Build failed: ${(err as Error).message}`);
    }
  }

  // --- Read a position by tokenId ---
  let lookupId = "";
  let lookup: {liquidity: string; token0: string; token1: string; fee: number; owed0: string; owed1: string} | null = null;
  let lookupErr: string | null = null;
  async function doLookup(): Promise<void> {
    lookup = null;
    lookupErr = null;
    try {
      if ($wallet.status !== "connected") throw new Error("Connect a wallet");
      const cfg = chainConfig($wallet.chainId);
      if (!cfg?.dao?.uniswapV3) throw new Error("No UniswapV3 plugin configured");
      const plugin = uniswapV3Contract(cfg, $wallet.provider);
      const npmAddr = await plugin.positionManager();
      const npm = new ethers.Contract(
        npmAddr,
        [
          "function positions(uint256) view returns (uint96,address,address token0,address token1,uint24 fee,int24,int24,uint128 liquidity,uint256,uint256,uint128 tokensOwed0,uint128 tokensOwed1)",
        ],
        $wallet.provider
      );
      const p = await npm.positions(ethers.BigNumber.from(lookupId || "0"));
      lookup = {
        token0: p.token0,
        token1: p.token1,
        fee: p.fee,
        liquidity: p.liquidity.toString(),
        owed0: p.tokensOwed0.toString(),
        owed1: p.tokensOwed1.toString(),
      };
    } catch (err) {
      lookupErr = (err as Error).message;
    }
  }

  // --- V4 LP (modifyLiquidities pass-through) ---
  // Encode the v4 action stream off-chain (Uniswap SDK) and paste the
  // resulting `unlockData` bytes here; the plugin handles Permit2 approvals
  // for input currencies and enforces minOut on outputs.
  let v4UnlockData = "0x";
  let v4Deadline = "";
  let v4InputCurrencies = ""; // comma-sep addrs
  let v4MaxIn = ""; // comma-sep raw uint256
  let v4OutputCurrencies = "";
  let v4MinOut = "";
  // Governance-safe: previewModifyLiquiditiesActions returns the
  // approve→Permit2.approve→PM.modifyLiquidities→approve(0) batch. Output-
  // side min amounts are encoded inside the v4 unlockData stream (TAKE_PAIR
  // params), not enforced by the plugin on the preview path.
  let v4Action: ProposalAction[] | null = null;
  async function buildV4Modify(): Promise<void> {
    v4Action = null;
    try {
      if ($wallet.status !== "connected") throw new Error("Connect a wallet");
      const cfg = cfgNow();
      const inAddrs = v4InputCurrencies
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const inAmts = v4MaxIn
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map((s) => ethers.BigNumber.from(s));
      const deadline = v4Deadline?.trim()
        ? ethers.BigNumber.from(v4Deadline.trim())
        : ethers.BigNumber.from(farDeadline());
      v4Action = await actions.previewV4ModifyLiquidities(
        cfg,
        $wallet.provider,
        v4UnlockData || "0x",
        deadline,
        inAddrs,
        inAmts
      );
    } catch (err) {
      alert(`Build failed: ${(err as Error).message}`);
    }
  }

  $: cfg = $wallet.status === "connected" ? chainConfig($wallet.chainId) : undefined;
</script>

<h1>Uniswap V3 positions</h1>

{#if $wallet.status !== "connected"}
  <p class="muted">Connect a wallet to manage positions.</p>
{:else if !cfg?.dao}
  <p class="empty">No DAO configured for chain {$wallet.chainId}.</p>
{:else}
  {#if !cfg.dao.uniswapV3}
    <p class="muted">
      No UniswapV3 plugin configured (7th address in <code>PUBLIC_DAO_*</code>). You can still
      build proposal calldata below and paste it into an external builder.
    </p>
  {/if}

  <p class="muted">
    Every operation is vote-gated; the position NFT is owned by the DAO and collected tokens
    return to the treasury. Tokens must be ERC20 (use WETH for ETH), ordered token0 &lt; token1.
  </p>

  <h2>Propose: mint position</h2>
  <div class="form">
    <label>token0 <input bind:value={mToken0} placeholder="0x… (lower addr)" /></label>
    <label>token1 <input bind:value={mToken1} placeholder="0x… (higher addr)" /></label>
    <label>fee <input bind:value={mFee} style="min-width:80px" placeholder="3000" /></label>
    <label>amount0 <input bind:value={mAmt0} placeholder="1000" /></label>
    <label>dec0 <input bind:value={mDec0} style="min-width:60px" /></label>
    <label>amount1 <input bind:value={mAmt1} placeholder="0.5" /></label>
    <label>dec1 <input bind:value={mDec1} style="min-width:60px" /></label>
    <label class="chk"><input type="checkbox" bind:checked={mFull} /> full range</label>
    {#if !mFull}
      <label>tickLower <input bind:value={mLower} style="min-width:90px" /></label>
      <label>tickUpper <input bind:value={mUpper} style="min-width:90px" /></label>
    {/if}
    <button on:click={buildMint}>Build</button>
  </div>
  <ProposeAction action={mintAction} />

  <h2>Manage an existing position</h2>
  <div class="form">
    <label>tokenId <input bind:value={opTokenId} placeholder="123" style="min-width:120px" /></label>
  </div>

  <h3>Increase liquidity</h3>
  <div class="form">
    <label>amount0 <input bind:value={iAmt0} placeholder="100" /></label>
    <label>dec0 <input bind:value={iDec0} style="min-width:60px" /></label>
    <label>amount1 <input bind:value={iAmt1} placeholder="0.05" /></label>
    <label>dec1 <input bind:value={iDec1} style="min-width:60px" /></label>
    <button on:click={buildIncrease}>Build</button>
  </div>
  <ProposeAction action={incAction} />

  <h3>Decrease liquidity</h3>
  <div class="form">
    <label>liquidity (raw units) <input bind:value={decLiquidity} placeholder="from a lookup" /></label>
    <button on:click={buildDecrease}>Build</button>
  </div>
  <ProposeAction action={decAction} />

  <h3>Collect (to DAO)</h3>
  <div class="form">
    <button on:click={buildCollect}>Build collect-max</button>
  </div>
  <ProposeAction action={collectAction} />

  <h3>Burn (empty position)</h3>
  <div class="form">
    <button on:click={buildBurn}>Build</button>
  </div>
  <ProposeAction action={burnAction} />

  <h2>Look up a position</h2>
  <div class="form">
    <label>tokenId <input bind:value={lookupId} placeholder="123" style="min-width:120px" /></label>
    <button on:click={doLookup}>Read</button>
  </div>
  {#if lookupErr}<p class="error">{lookupErr}</p>{/if}
  {#if lookup}
    <table>
      <tbody>
        <tr><th>token0</th><td><code>{lookup.token0}</code></td></tr>
        <tr><th>token1</th><td><code>{lookup.token1}</code></td></tr>
        <tr><th>fee</th><td>{lookup.fee}</td></tr>
        <tr><th>liquidity</th><td>{lookup.liquidity}</td></tr>
        <tr><th>owed0 / owed1</th><td>{lookup.owed0} / {lookup.owed1}</td></tr>
      </tbody>
    </table>
  {/if}

  <h2>Uniswap V4 LP (advanced — encode the action stream off-chain)</h2>
  <p class="muted">
    Propose any v4 LP operation via the existing UniswapV4Plugin (same plugin that
    handles V4 swaps). Build <code>unlockData = abi.encode(actions, params)</code> with
    the Uniswap SDK and paste it below. The plugin sets DAO→Permit2 + Permit2→PositionManager
    allowances for each input currency, calls <code>PositionManager.modifyLiquidities</code>,
    then resets each allowance to zero. After the call it asserts the DAO's balance delta
    on each output currency ≥ <code>minOut</code>.
  </p>
  <div class="form">
    <label>unlockData (0x…) <input bind:value={v4UnlockData} placeholder="0x… (SDK output)" /></label>
    <label>deadline (unix; blank = +7d) <input bind:value={v4Deadline} placeholder="auto" /></label>
    <label>input currencies (comma) <input bind:value={v4InputCurrencies} placeholder="0xUSDC,0xWETH" /></label>
    <label>maxIn (comma, raw) <input bind:value={v4MaxIn} placeholder="1000000000,500000000000000000" /></label>
    <label>output currencies (comma) <input bind:value={v4OutputCurrencies} placeholder="(empty for mint)" /></label>
    <label>minOut (comma, raw) <input bind:value={v4MinOut} placeholder="(empty for mint)" /></label>
    <button on:click={buildV4Modify}>Build</button>
  </div>
  <ProposeAction action={v4Action} />
{/if}

<style>
  .form {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: flex-end;
    margin: 0.5rem 0 1rem;
  }
  .form label {
    display: flex;
    flex-direction: column;
    font-size: 0.85rem;
  }
  .form label.chk {
    flex-direction: row;
    align-items: center;
    gap: 0.3rem;
  }
  .form input {
    min-width: 150px;
  }
  h3 {
    font-size: 1rem;
    margin: 0.75rem 0 0.25rem;
    color: #555;
  }
  .error {
    color: #b00020;
  }
</style>
