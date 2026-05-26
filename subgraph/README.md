# Cyberdyne DAO subgraph

Graph Protocol subgraph indexing the three Cyberdyne plugins. One subgraph per deployed DAO; the manifest at `subgraph.yaml` is a template with `{{...}}` placeholders that operators fill in at deploy time.

## What it indexes

| Source | Entities |
|---|---|
| `PayrollPlugin` | `Dao`, `PayrollPlugin`, `PayrollRecipient`, `RecipientAmountChange`, `PayrollPayout`, `PayrollPayoutItem` |
| `UniswapV4Plugin` | `Swap`, `RouterMigration`, `TokenAllowlistEntry` |
| `AaveLendingPlugin` | `LendingAction` (SUPPLY/WITHDRAW/BORROW/REPAY), `AdapterMigration`, `AssetAllowlistEntry` |

Full schema in [`schema.graphql`](./schema.graphql). Event-to-entity mapping in [`../docs/EVENTS.md`](../docs/EVENTS.md).

## Deploy

### Prereqs

```bash
cd subgraph/
npm install
```

### 1. Fill in the manifest

After running `just deploy-cyberdyne-dao --broadcast`, you'll have a `deployments/<chain>-<timestamp>.json` manifest in the repo root. Use those addresses + the deploy tx's block number to substitute the placeholders in `subgraph.yaml`:

| Placeholder | Source |
|---|---|
| `{{NETWORK}}` | One of `mainnet`, `base`, `sepolia`, `base-sepolia`, etc. (Graph network name — not `mainnetFork`) |
| `{{PAYROLL_ADDRESS}}` | `installedPlugins[N].plugin` from the DAOFactory `Executed` log, or read from the deployment manifest's `dao` after `IDAO`-style lookups |
| `{{PAYROLL_START_BLOCK}}` | The block number of the install tx (deploy tx for the DAO) |
| `{{UNISWAP_ADDRESS}}` / `{{UNISWAP_START_BLOCK}}` | Same — Uniswap V4 plugin entry from the install |
| `{{AAVE_ADDRESS}}` / `{{AAVE_START_BLOCK}}` | Same — AAVE plugin entry |

For a one-line `sed`:

```bash
sed -i.bak \
    -e 's/{{NETWORK}}/mainnet/g' \
    -e 's/{{PAYROLL_ADDRESS}}/0x.../g' \
    -e 's/{{PAYROLL_START_BLOCK}}/21500000/g' \
    -e 's/{{UNISWAP_ADDRESS}}/0x.../g' \
    -e 's/{{UNISWAP_START_BLOCK}}/21500000/g' \
    -e 's/{{AAVE_ADDRESS}}/0x.../g' \
    -e 's/{{AAVE_START_BLOCK}}/21500000/g' \
    subgraph.yaml
```

### 2. Build

```bash
npm run prepare:abis     # copies ABIs from ../frontend-abi/ into ./abis/
npm run codegen          # generates types for AssemblyScript handlers
npm run build            # produces ./build/
```

### 3. Deploy

Pick one of the supported targets:

**Goldsky** (recommended):
```bash
goldsky login
npm run deploy:goldsky
```

**Hosted Graph** (legacy; check current status at thegraph.com):
```bash
export SUBGRAPH_SLUG=cyberdyne/dao
npm run deploy:hosted
```

**Subgraph Studio** (self-hosted indexer or the decentralized network):
```bash
graph auth --studio <DEPLOY_KEY>
export SUBGRAPH_NAME=cyberdyne-dao
npm run deploy:studio
```

## Sample queries

Latest 10 swaps:

```graphql
{
  swaps(first: 10, orderBy: timestamp, orderDirection: desc) {
    txHash
    tokenIn
    amountIn
    tokenOut
    amountOutActual
    timestamp
  }
}
```

Per-recipient payout history:

```graphql
{
  payrollRecipient(id: "0xDAO.0xPAYEE") {
    payee
    amount
    active
    payoutItems(orderBy: payout__period, orderDirection: desc) {
      amount
      failed
      payout { period timestamp }
    }
  }
}
```

DAO lending positions snapshot (events only — actual aToken balances must be read from AAVE directly per `docs/EVENTS.md`):

```graphql
{
  dao(id: "0xDAO") {
    aavePlugin { adapter }
    lendingActions(first: 50, orderBy: timestamp, orderDirection: desc) {
      kind asset amount amountActual interestRateMode timestamp
    }
  }
}
```

## Notes

- **One subgraph per DAO**: deploy a fresh subgraph per `DAOFactory.createDao` run. The manifest is per-deployment; per-DAO subgraphs are easier to query than a multi-DAO indexer.
- **PayrollPayoutItem** is reconstructed in the mapping by zipping `PayrollExecuted.failureMap` bits against `allActiveRecipients()` at the same block. Reproducible because Graph indexers run in a deterministic context.
- **Subgraph drift on plugin upgrades**: if you upgrade a plugin (`UPGRADE_PLUGIN_PERMISSION` vote), the ABI may change. Re-run `prepare:abis` and re-deploy the subgraph.
- **TokenVoting events** are NOT yet indexed — TokenVoting integration in `DeployCyberdyneDao.s.sol` is deferred (see P5 commit notes). When it lands, add a fourth datasource for the TokenVoting PluginRepo's instance.
