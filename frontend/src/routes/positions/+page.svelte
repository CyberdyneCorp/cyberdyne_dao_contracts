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
  import {listV3PositionsOwnedBy, type V3PositionRead} from "$lib/v3Positions";
  import {
    listV4PositionsOwnedBy,
    readV4Position,
    type V4PositionRead,
  } from "$lib/v4Positions";

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

  // --- V4 LP: typed mint / increase / decrease / collect / burn ---
  // Frontend encodes the v4 action stream from typed inputs and routes it
  // through UniswapV4Plugin.previewModifyLiquiditiesActions for the
  // governance-safe multi-action proposal. Owner / TAKE_PAIR recipient is
  // always forced to the DAO.
  //
  // PoolKey shared across all V4 forms (typed once, used by each phase).
  let v4PoolToken0 = "";
  let v4PoolToken1 = "";
  let v4PoolFee = "3000";
  let v4PoolTickSpacing = "60";
  let v4PoolHooks = "0x0000000000000000000000000000000000000000";

  function v4PoolKey() {
    const sorted = v4PoolToken0.toLowerCase() < v4PoolToken1.toLowerCase()
      ? {c0: v4PoolToken0, c1: v4PoolToken1}
      : {c0: v4PoolToken1, c1: v4PoolToken0};
    return {
      currency0: sorted.c0,
      currency1: sorted.c1,
      fee: parseInt(v4PoolFee, 10),
      tickSpacing: parseInt(v4PoolTickSpacing, 10),
      hooks: v4PoolHooks || ethers.constants.AddressZero,
    };
  }

  // mint
  let vmTickLower = "-887220";
  let vmTickUpper = "887220";
  let vmLiquidity = "";
  let vmAmount0Max = "";
  let vmAmount1Max = "";
  let vmDec0 = "6";
  let vmDec1 = "18";
  let v4MintAction: ProposalAction[] | null = null;
  async function buildV4Mint(): Promise<void> {
    v4MintAction = null;
    try {
      if ($wallet.status !== "connected") throw new Error("Connect a wallet");
      v4MintAction = await actions.previewV4Mint(cfgNow(), $wallet.provider, {
        poolKey: v4PoolKey(),
        tickLower: parseInt(vmTickLower, 10),
        tickUpper: parseInt(vmTickUpper, 10),
        liquidity: ethers.BigNumber.from(vmLiquidity || "0"),
        amount0Max: ethers.utils.parseUnits(vmAmount0Max || "0", parseInt(vmDec0, 10)),
        amount1Max: ethers.utils.parseUnits(vmAmount1Max || "0", parseInt(vmDec1, 10)),
      });
    } catch (err) {
      alert(`Build failed: ${(err as Error).message}`);
    }
  }

  // increase
  let viTokenId = "";
  let viLiquidity = "";
  let viAmount0Max = "";
  let viAmount1Max = "";
  let v4IncAction: ProposalAction[] | null = null;
  async function buildV4Increase(): Promise<void> {
    v4IncAction = null;
    try {
      if ($wallet.status !== "connected") throw new Error("Connect a wallet");
      v4IncAction = await actions.previewV4Increase(cfgNow(), $wallet.provider, {
        poolKey: v4PoolKey(),
        tokenId: ethers.BigNumber.from(viTokenId || "0"),
        liquidity: ethers.BigNumber.from(viLiquidity || "0"),
        amount0Max: ethers.utils.parseUnits(viAmount0Max || "0", parseInt(vmDec0, 10)),
        amount1Max: ethers.utils.parseUnits(viAmount1Max || "0", parseInt(vmDec1, 10)),
      });
    } catch (err) {
      alert(`Build failed: ${(err as Error).message}`);
    }
  }

  // decrease / collect / burn (shared tokenId)
  let vdTokenId = "";
  let vdLiquidity = "";
  let v4DecAction: ProposalAction[] | null = null;
  async function buildV4Decrease(): Promise<void> {
    v4DecAction = null;
    try {
      if ($wallet.status !== "connected") throw new Error("Connect a wallet");
      v4DecAction = await actions.previewV4Decrease(cfgNow(), $wallet.provider, {
        poolKey: v4PoolKey(),
        tokenId: ethers.BigNumber.from(vdTokenId || "0"),
        liquidity: ethers.BigNumber.from(vdLiquidity || "0"),
        amount0Min: 0,
        amount1Min: 0,
      });
    } catch (err) {
      alert(`Build failed: ${(err as Error).message}`);
    }
  }

  let v4CollectAction: ProposalAction[] | null = null;
  async function buildV4Collect(): Promise<void> {
    v4CollectAction = null;
    try {
      if ($wallet.status !== "connected") throw new Error("Connect a wallet");
      v4CollectAction = await actions.previewV4Collect(cfgNow(), $wallet.provider, {
        poolKey: v4PoolKey(),
        tokenId: ethers.BigNumber.from(vdTokenId || "0"),
      });
    } catch (err) {
      alert(`Build failed: ${(err as Error).message}`);
    }
  }

  let v4BurnAction: ProposalAction[] | null = null;
  async function buildV4Burn(): Promise<void> {
    v4BurnAction = null;
    try {
      if ($wallet.status !== "connected") throw new Error("Connect a wallet");
      v4BurnAction = await actions.previewV4Burn(cfgNow(), $wallet.provider, {
        poolKey: v4PoolKey(),
        tokenId: ethers.BigNumber.from(vdTokenId || "0"),
      });
    } catch (err) {
      alert(`Build failed: ${(err as Error).message}`);
    }
  }

  // --- DAO-owned positions (V3 + V4) ---
  let v3Positions: V3PositionRead[] | null = null;
  let v4Positions: V4PositionRead[] | null = null;
  let listErr: string | null = null;
  let listing = false;

  async function loadPositions(): Promise<void> {
    listErr = null;
    listing = true;
    v3Positions = null;
    v4Positions = null;
    try {
      if ($wallet.status !== "connected") throw new Error("Connect a wallet");
      const cfg = chainConfig($wallet.chainId);
      if (!cfg?.dao) throw new Error("No DAO configured");

      // V3 — NPM is ERC721Enumerable, walk tokenOfOwnerByIndex.
      if (cfg.dao.uniswapV3) {
        const v3 = uniswapV3Contract(cfg, $wallet.provider);
        const npmAddr = (await v3.positionManager()) as string;
        v3Positions = await listV3PositionsOwnedBy(npmAddr, $wallet.provider, cfg.dao.dao);
      } else {
        v3Positions = [];
      }

      // V4 — PositionManager is NOT enumerable; scan Transfer(0x0, DAO).
      const v4 = new ethers.Contract(
        cfg.dao.uniswap,
        ["function v4PositionManager() view returns (address)"],
        $wallet.provider
      );
      let pmAddr: string = ethers.constants.AddressZero;
      try {
        pmAddr = (await v4.v4PositionManager()) as string;
      } catch {
        /* plugin pre-LP-extension build */
      }
      if (pmAddr !== ethers.constants.AddressZero) {
        v4Positions = await listV4PositionsOwnedBy(pmAddr, $wallet.provider, cfg.dao.dao);
      } else {
        v4Positions = [];
      }
    } catch (err) {
      listErr = (err as Error).message;
    } finally {
      listing = false;
    }
  }

  // --- V4 single-position lookup (by tokenId) ---
  let v4LookupId = "";
  let v4Lookup: V4PositionRead | null = null;
  let v4LookupErr: string | null = null;
  async function doV4Lookup(): Promise<void> {
    v4Lookup = null;
    v4LookupErr = null;
    try {
      if ($wallet.status !== "connected") throw new Error("Connect a wallet");
      const cfg = chainConfig($wallet.chainId);
      if (!cfg?.dao) throw new Error("No DAO configured");
      const v4 = new ethers.Contract(
        cfg.dao.uniswap,
        ["function v4PositionManager() view returns (address)"],
        $wallet.provider
      );
      const pmAddr: string = await v4.v4PositionManager();
      v4Lookup = await readV4Position(
        pmAddr,
        $wallet.provider,
        ethers.BigNumber.from(v4LookupId || "0")
      );
    } catch (err) {
      v4LookupErr = (err as Error).message;
    }
  }

  $: cfg = $wallet.status === "connected" ? chainConfig($wallet.chainId) : undefined;
</script>

<h1>Uniswap V3 + V4 positions</h1>

{#if $wallet.status !== "connected"}
  <p class="muted">Connect a wallet to manage positions.</p>
{:else if !cfg?.dao}
  <p class="empty">No DAO configured for chain {$wallet.chainId}.</p>
{:else}
  <h2>DAO-owned positions</h2>
  <p class="muted">
    Read-only view of every LP NFT currently held by the DAO across both
    Uniswap V3 (NPM) and V4 (PositionManager). Use the build forms below to
    propose lifecycle ops against any tokenId.
  </p>
  <div class="actions">
    <button on:click={loadPositions} disabled={listing}>
      {listing ? "Loading…" : v3Positions || v4Positions ? "Refresh" : "Load positions"}
    </button>
  </div>
  {#if listErr}<p class="error">{listErr}</p>{/if}
  {#if v3Positions !== null || v4Positions !== null}
    <h3 class="sub">Uniswap V3 ({v3Positions?.length ?? 0})</h3>
    {#if v3Positions && v3Positions.length > 0}
      <table>
        <thead>
          <tr><th>tokenId</th><th>pair</th><th>fee</th><th>tick range</th><th>liquidity</th><th>owed0 / owed1</th></tr>
        </thead>
        <tbody>
          {#each v3Positions as p}
            <tr>
              <td>{p.tokenId.toString()}</td>
              <td><code>{p.token0.slice(0, 8)}…</code> / <code>{p.token1.slice(0, 8)}…</code></td>
              <td>{p.fee}</td>
              <td>[{p.tickLower}, {p.tickUpper}]</td>
              <td>{p.liquidity.toString()}</td>
              <td>{p.tokensOwed0.toString()} / {p.tokensOwed1.toString()}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {:else if v3Positions}
      <p class="empty">No V3 positions.</p>
    {/if}

    <h3 class="sub">Uniswap V4 ({v4Positions?.length ?? 0})</h3>
    {#if v4Positions && v4Positions.length > 0}
      <table>
        <thead>
          <tr><th>tokenId</th><th>pair</th><th>fee / ts</th><th>tick range</th><th>liquidity</th><th>hooks</th></tr>
        </thead>
        <tbody>
          {#each v4Positions as p}
            <tr>
              <td>{p.tokenId.toString()}</td>
              <td><code>{p.poolKey.currency0.slice(0, 8)}…</code> / <code>{p.poolKey.currency1.slice(0, 8)}…</code></td>
              <td>{p.poolKey.fee} / {p.poolKey.tickSpacing}</td>
              <td>[{p.tickLower}, {p.tickUpper}]</td>
              <td>{p.liquidity.toString()}</td>
              <td>
                {#if p.poolKey.hooks === ethers.constants.AddressZero}
                  <span class="muted">none</span>
                {:else}<code>{p.poolKey.hooks.slice(0, 10)}…</code>{/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {:else if v4Positions}
      <p class="empty">No V4 positions.</p>
    {/if}
  {/if}

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

  <h2>Propose: mint position (V3)</h2>
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

  <h2>Look up a V3 position</h2>
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

  <h2>Look up a V4 position</h2>
  <div class="form">
    <label>tokenId <input bind:value={v4LookupId} placeholder="293418" style="min-width:120px" /></label>
    <button on:click={doV4Lookup}>Read</button>
  </div>
  {#if v4LookupErr}<p class="error">{v4LookupErr}</p>{/if}
  {#if v4Lookup}
    <table>
      <tbody>
        <tr><th>tokenId</th><td>{v4Lookup.tokenId.toString()}</td></tr>
        <tr><th>currency0</th><td><code>{v4Lookup.poolKey.currency0}</code></td></tr>
        <tr><th>currency1</th><td><code>{v4Lookup.poolKey.currency1}</code></td></tr>
        <tr><th>fee / tickSpacing</th><td>{v4Lookup.poolKey.fee} / {v4Lookup.poolKey.tickSpacing}</td></tr>
        <tr><th>hooks</th><td><code>{v4Lookup.poolKey.hooks}</code></td></tr>
        <tr><th>tick range</th><td>[{v4Lookup.tickLower}, {v4Lookup.tickUpper}]</td></tr>
        <tr><th>liquidity</th><td>{v4Lookup.liquidity.toString()}</td></tr>
        <tr><th>hasSubscriber</th><td>{v4Lookup.hasSubscriber ? "yes" : "no"}</td></tr>
      </tbody>
    </table>
  {/if}

  <h2>Uniswap V4 LP</h2>
  <p class="muted">
    Vote-gated full lifecycle on the v4-periphery PositionManager. The DAO is
    the owner (MINT_POSITION) and the recipient (TAKE_PAIR). The frontend
    encodes the v4 action stream from the typed fields below — no raw hex
    paste required.
  </p>

  <h3>Pool key</h3>
  <p class="muted">Tokens are auto-sorted so <code>currency0 &lt; currency1</code>. Use <code>0x0…0</code> for hooks if unhooked.</p>
  <div class="form">
    <label>token A <input bind:value={v4PoolToken0} placeholder="0x… (USDC)" /></label>
    <label>token B <input bind:value={v4PoolToken1} placeholder="0x… (WETH)" /></label>
    <label>fee <input bind:value={v4PoolFee} style="min-width:80px" /></label>
    <label>tickSpacing <input bind:value={v4PoolTickSpacing} style="min-width:80px" /></label>
    <label>hooks <input bind:value={v4PoolHooks} placeholder="0x0…0" /></label>
  </div>

  <h3>Propose: mint position</h3>
  <div class="form">
    <label>tickLower <input bind:value={vmTickLower} style="min-width:90px" /></label>
    <label>tickUpper <input bind:value={vmTickUpper} style="min-width:90px" /></label>
    <label>liquidity (L) <input bind:value={vmLiquidity} placeholder="10000000000000" /></label>
    <label>amount0Max <input bind:value={vmAmount0Max} placeholder="2000" /></label>
    <label>dec0 <input bind:value={vmDec0} style="min-width:60px" /></label>
    <label>amount1Max <input bind:value={vmAmount1Max} placeholder="1" /></label>
    <label>dec1 <input bind:value={vmDec1} style="min-width:60px" /></label>
    <button on:click={buildV4Mint}>Build</button>
  </div>
  <ProposeAction action={v4MintAction} />

  <h3>Propose: increase liquidity</h3>
  <div class="form">
    <label>tokenId <input bind:value={viTokenId} style="min-width:120px" /></label>
    <label>liquidity (Δ) <input bind:value={viLiquidity} placeholder="1000000000000" /></label>
    <label>amount0Max <input bind:value={viAmount0Max} placeholder="200" /></label>
    <label>amount1Max <input bind:value={viAmount1Max} placeholder="0.1" /></label>
    <button on:click={buildV4Increase}>Build</button>
  </div>
  <ProposeAction action={v4IncAction} />

  <h3>Propose: decrease / collect / burn (by tokenId)</h3>
  <div class="form">
    <label>tokenId <input bind:value={vdTokenId} style="min-width:120px" /></label>
    <label>liquidity to remove <input bind:value={vdLiquidity} placeholder="1000000000000" /></label>
    <button on:click={buildV4Decrease}>Build decrease</button>
    <button on:click={buildV4Collect}>Build collect-fees</button>
    <button on:click={buildV4Burn}>Build burn</button>
  </div>
  <ProposeAction action={v4DecAction} />
  <ProposeAction action={v4CollectAction} />
  <ProposeAction action={v4BurnAction} />
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
