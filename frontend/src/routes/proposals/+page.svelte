<!--
  Proposals — TokenVoting is deferred to P11 (see DeployCyberdyneDao header
  comment in P5). When it lands, this page lists proposals + lets the user
  vote / execute. For now: action-builder helpers for the three plugin
  admin surfaces, producing JSON ready to paste into a proposal builder.
-->
<script lang="ts">
  import {ethers} from "ethers";
  import {wallet} from "$lib/wallet";
  import {chainConfig} from "$lib/chains";
  import {getAbi} from "@cyberdyne/dao-contracts";

  type ActionKind =
    | "uniswap-setRouter"
    | "uniswap-setAllowedToken"
    | "aave-setAdapter"
    | "aave-setAllowedAsset"
    | "payroll-removeRecipient"
    | "payroll-setPayDayOfMonth";

  let kind: ActionKind = "uniswap-setRouter";
  let argA = "";
  let argB = "";
  let result: string | null = null;

  function build(): void {
    result = null;
    try {
      if ($wallet.status !== "connected") throw new Error("Connect a wallet");
      const cfg = chainConfig($wallet.chainId);
      if (!cfg?.dao) throw new Error("No DAO configured");

      let to: string;
      let abiName: "UniswapV4Plugin" | "AaveLendingPlugin" | "PayrollPlugin";
      let fn: string;
      let args: unknown[];

      switch (kind) {
        case "uniswap-setRouter":
          to = cfg.dao.uniswap;
          abiName = "UniswapV4Plugin";
          fn = "setUniversalRouter";
          args = [argA];
          break;
        case "uniswap-setAllowedToken":
          to = cfg.dao.uniswap;
          abiName = "UniswapV4Plugin";
          fn = "setAllowedToken";
          args = [argA, argB.toLowerCase() === "true"];
          break;
        case "aave-setAdapter":
          to = cfg.dao.aave;
          abiName = "AaveLendingPlugin";
          fn = "setAdapter";
          args = [argA];
          break;
        case "aave-setAllowedAsset":
          to = cfg.dao.aave;
          abiName = "AaveLendingPlugin";
          fn = "setAllowedAsset";
          args = [argA, argB.toLowerCase() === "true"];
          break;
        case "payroll-removeRecipient":
          to = cfg.dao.payroll;
          abiName = "PayrollPlugin";
          fn = "removeRecipient";
          args = [argA];
          break;
        case "payroll-setPayDayOfMonth":
          to = cfg.dao.payroll;
          abiName = "PayrollPlugin";
          fn = "setPayDayOfMonth";
          args = [parseInt(argA)];
          break;
      }

      const iface = new ethers.utils.Interface(getAbi(abiName));
      const data = iface.encodeFunctionData(fn, args);
      const human = `${abiName}.${fn}(${args.map((a) => JSON.stringify(a)).join(", ")})`;
      result = JSON.stringify(
        {to, value: "0", data, humanReadable: human},
        null,
        2
      );
    } catch (err) {
      result = `// error: ${(err as Error).message}`;
    }
  }
</script>

<h1>Proposals</h1>

<p class="muted">
  Full proposal list + vote/execute UI lands when TokenVoting is wired in (P11,
  see <code>DeployCyberdyneDao.s.sol</code> header). Until then, this page is an
  action-builder for the three vote-gated admin surfaces — paste the JSON into your
  TokenVoting proposal builder.
</p>

<h2>Action builder</h2>
<div class="form">
  <label>
    Action
    <select bind:value={kind}>
      <option value="uniswap-setRouter">UniswapV4Plugin.setUniversalRouter(address)</option>
      <option value="uniswap-setAllowedToken">UniswapV4Plugin.setAllowedToken(address, bool)</option>
      <option value="aave-setAdapter">AaveLendingPlugin.setAdapter(address)</option>
      <option value="aave-setAllowedAsset">AaveLendingPlugin.setAllowedAsset(address, bool)</option>
      <option value="payroll-removeRecipient">PayrollPlugin.removeRecipient(address)</option>
      <option value="payroll-setPayDayOfMonth">PayrollPlugin.setPayDayOfMonth(uint8 1..28)</option>
    </select>
  </label>
  <label>Arg A <input bind:value={argA} placeholder="address or number" /></label>
  <label>Arg B <input bind:value={argB} placeholder="true / false (where applicable)" /></label>
  <button on:click={build}>Encode</button>
</div>
{#if result}
  <pre>{result}</pre>
{/if}

<style>
  .form {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin: 0.5rem 0 1rem;
  }
  .form label {
    display: flex;
    flex-direction: column;
    font-size: 0.85rem;
  }
  .form input,
  .form select {
    min-width: 280px;
  }
  pre {
    background: #f5f5f5;
    padding: 0.75rem;
    overflow-x: auto;
    font-size: 0.8rem;
  }
</style>
