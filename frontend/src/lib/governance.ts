// TokenVoting (Aragon OSx 1.4) integration — create / vote / execute / list.
//
// Aragon's TokenVoting plugin isn't part of @cyberdyne/dao-contracts (it's an
// external OSx plugin), so we carry a minimal hand-written ABI for the pinned
// OSx 1.4 surface. The create/vote/execute/event entry points are stable; the
// richer `getProposal` tuple varies across builds, so reads that depend on it
// are best-effort (guarded) — the UI degrades to event-derived data on decode
// failure.

import {ethers} from "ethers";
import type {ChainConfig} from "./types";
import type {ProposalAction} from "./actions";
import {
  ipfsEnabled,
  buildProposalMetadata,
  pinProposalMetadata,
  resolveMetadataTitle,
} from "./ipfs";

// VoteOption enum (MajorityVotingBase): None=0, Abstain=1, Yes=2, No=3.
export const VoteOption = {None: 0, Abstain: 1, Yes: 2, No: 3} as const;
export type VoteOptionValue = (typeof VoteOption)[keyof typeof VoteOption];

const TOKEN_VOTING_ABI = [
  "function createProposal(bytes _metadata, (address to,uint256 value,bytes data)[] _actions, uint64 _startDate, uint64 _endDate, bytes _data) returns (uint256 proposalId)",
  "function vote(uint256 _proposalId, uint8 _voteOption, bool _tryEarlyExecution)",
  "function execute(uint256 _proposalId)",
  "function canExecute(uint256 _proposalId) view returns (bool)",
  "function canVote(uint256 _proposalId, address _voter, uint8 _voteOption) view returns (bool)",
  "function getVoteOption(uint256 _proposalId, address _voter) view returns (uint8)",
  "function hasSucceeded(uint256 _proposalId) view returns (bool)",
  "function getProposal(uint256 _proposalId) view returns (bool open, bool executed, (uint8 votingMode,uint32 supportThreshold,uint64 startDate,uint64 endDate,uint64 snapshotBlock,uint256 minVotingPower) parameters, (uint256 abstain,uint256 yes,uint256 no) tally, (address to,uint256 value,bytes data)[] actions, uint256 allowFailureMap, (address target,uint8 operation) targetConfig)",
  "event ProposalCreated(uint256 indexed proposalId, address indexed creator, uint64 startDate, uint64 endDate, bytes metadata, (address to,uint256 value,bytes data)[] actions, uint256 allowFailureMap)",
  "event ProposalExecuted(uint256 indexed proposalId)",
];

// ~7 days of mainnet blocks — bounds the ProposalCreated lookback. For deeper
// history use the subgraph (PUBLIC_SUBGRAPH_URL); direct RPC log scans are
// intentionally shallow.
const LOOKBACK_BLOCKS = 50_000;
// Most RPCs (and anvil forks forwarding to infura/alchemy) cap eth_getLogs at
// ~10k blocks per call. Query in chunks under that limit so a wide lookback
// can't blow the range cap (which manifested as the proposals list hanging on
// "Loading…" against a fork). Chunks are walked newest-first.
const LOG_CHUNK = 9_000;

/**
 * `queryFilter` that splits [from, to] into ≤LOG_CHUNK ranges so it never
 * exceeds the RPC's getLogs range cap. Chunks run newest-first; a failing
 * chunk is skipped (best-effort) rather than aborting the whole list.
 */
async function queryFilterChunked(
  contract: ethers.Contract,
  filter: ethers.EventFilter,
  from: number,
  to: number
): Promise<ethers.Event[]> {
  const out: ethers.Event[] = [];
  for (let end = to; end >= from; end -= LOG_CHUNK) {
    const start = Math.max(from, end - LOG_CHUNK + 1);
    try {
      const evs = await contract.queryFilter(filter, start, end);
      out.push(...evs);
    } catch {
      /* skip an unreadable range (e.g. transient RPC error) */
    }
  }
  return out;
}

export function governanceConfigured(cfg: ChainConfig): boolean {
  return !!cfg.dao?.governance;
}

export function tokenVotingContract(
  cfg: ChainConfig,
  providerOrSigner: ethers.providers.Provider | ethers.Signer
): ethers.Contract {
  const addr = cfg.dao?.governance;
  if (!addr) throw new Error("No TokenVoting (governance) plugin configured for this DAO");
  return new ethers.Contract(addr, TOKEN_VOTING_ABI, providerOrSigner);
}

export type ProposalTally = {yes: string; no: string; abstain: string};
export type ProposalView = {
  id: string;
  creator: string;
  startDate: number;
  endDate: number;
  summary: string; // decoded from metadata bytes (best-effort)
  actions: {to: string; value: string; data: string}[];
  executed: boolean;
  open: boolean | null; // null when getProposal couldn't be decoded
  canExecute: boolean;
  tally: ProposalTally | null;
  myVote: VoteOptionValue | null;
};

/**
 * Create a proposal carrying `actions`. startDate/endDate = 0 lets TokenVoting
 * use "now" + its configured minDuration. The proposer does not auto-vote
 * (VoteOption.None); vote separately from the list. allowFailureMap = 0 so
 * every action must succeed.
 *
 * Metadata: when IPFS pinning is configured (PUBLIC_PINATA_JWT), a structured
 * metadata document is pinned and the on-chain `metadata` bytes are the
 * `ipfs://<cid>` pointer (production-shaped). Otherwise the `summary` string
 * is stored inline as UTF-8 bytes (the toy-frontend default). If pinning is
 * configured but fails, we fall back to inline rather than block the proposal.
 */
export async function proposeActions(
  cfg: ChainConfig,
  signer: ethers.Signer,
  actions: ProposalAction[],
  metadata: string
): Promise<{hash: string; proposalId: string | null; metadataUri: string}> {
  const tv = tokenVotingContract(cfg, signer);
  const onchainActions = actions.map((a) => ({to: a.to, value: a.value, data: a.data}));

  // Resolve the metadata bytes: ipfs://CID when pinning works, else inline.
  let metadataString = metadata;
  if (ipfsEnabled()) {
    try {
      // Pass the full actions (with .summary) so encodedActions[].humanReadable
      // is populated per the canonical schema (docs/PROPOSAL_METADATA.md).
      const doc = buildProposalMetadata(metadata, metadata, actions);
      metadataString = await pinProposalMetadata(doc);
    } catch (err) {
      // Non-fatal: surface to console, fall back to inline UTF-8.
      console.warn("IPFS pin failed, storing metadata inline:", (err as Error).message);
      metadataString = metadata;
    }
  }

  const data = ethers.utils.defaultAbiCoder.encode(
    ["uint256", "uint8", "bool"],
    [0, VoteOption.None, false]
  );
  const tx: ethers.ContractTransaction = await tv.createProposal(
    ethers.utils.toUtf8Bytes(metadataString),
    onchainActions,
    0,
    0,
    data
  );
  const receipt = await tx.wait();
  let proposalId: string | null = null;
  for (const log of receipt.logs) {
    try {
      const parsed = tv.interface.parseLog(log);
      if (parsed.name === "ProposalCreated") {
        proposalId = parsed.args.proposalId.toString();
        break;
      }
    } catch {
      /* not our event */
    }
  }
  return {hash: tx.hash, proposalId, metadataUri: metadataString};
}

export async function castVote(
  cfg: ChainConfig,
  signer: ethers.Signer,
  proposalId: string,
  option: VoteOptionValue,
  tryEarlyExecution = false
): Promise<string> {
  const tv = tokenVotingContract(cfg, signer);
  const tx: ethers.ContractTransaction = await tv.vote(proposalId, option, tryEarlyExecution);
  await tx.wait();
  return tx.hash;
}

export async function executeProposal(
  cfg: ChainConfig,
  signer: ethers.Signer,
  proposalId: string
): Promise<string> {
  const tv = tokenVotingContract(cfg, signer);
  const tx: ethers.ContractTransaction = await tv.execute(proposalId);
  await tx.wait();
  return tx.hash;
}

/**
 * Simulate executing a proposal's action batch BEFORE the vote ends, so any
 * post-vote revert (bad slippage, expired deadline, insufficient balance,
 * MintRecipientMustBeDao, etc.) surfaces to voters in time.
 *
 * Approach: `eth_call` `dao.execute(callId, actions, 0)` with `from =
 * TokenVoting plugin address`. TokenVoting has `EXECUTE_PERMISSION` on the
 * DAO (granted at install), so the permission gate passes; the actions then
 * run normally against current chain state. Returns `{ok: true}` if the
 * batch would succeed, or `{ok: false, reason: <decoded revert string>}`.
 *
 * Notes:
 *  - This is a SIMULATION against current state. The actual execute happens
 *    after the vote end; state can drift in between.
 *  - allowFailureMap = 0 matches what `proposeActions` uses; a per-action
 *    failure reverts the whole batch.
 *  - Uses a placeholder callId — DAO.execute doesn't validate it, just emits
 *    it in the Executed event (which the simulation discards).
 */
const DAO_EXECUTE_ABI = [
  "function execute(bytes32 _callId, (address to,uint256 value,bytes data)[] _actions, uint256 _allowFailureMap) returns (bytes[] execResults, uint256 failureMap)",
];

export async function simulateProposalExecution(
  cfg: ChainConfig,
  provider: ethers.providers.Provider,
  actions: {to: string; value: string; data: string}[]
): Promise<{ok: true} | {ok: false; reason: string}> {
  if (!cfg.dao) return {ok: false, reason: "No DAO configured"};
  if (!cfg.dao.governance) {
    return {ok: false, reason: "No TokenVoting plugin — can't simulate without an EXECUTE-permitted msg.sender"};
  }
  const dao = new ethers.Contract(cfg.dao.dao, DAO_EXECUTE_ABI, provider);
  const callId = ethers.utils.formatBytes32String("SIMULATE");
  try {
    await dao.callStatic.execute(
      callId,
      actions.map((a) => ({
        to: a.to,
        value: ethers.BigNumber.from(a.value),
        data: a.data,
      })),
      0,
      {from: cfg.dao.governance}
    );
    return {ok: true};
  } catch (err) {
    const e = err as {reason?: string; data?: string; error?: {message?: string}; message?: string};
    // ethers v5 surfaces revert reasons in several places depending on the
    // node. Try them in order of specificity.
    const reason =
      e.reason ||
      e.error?.message ||
      (e.data ? `revert data ${e.data.slice(0, 18)}…` : null) ||
      e.message ||
      "unknown revert";
    return {ok: false, reason};
  }
}

function decodeMetadata(raw: string): string {
  try {
    const s = ethers.utils.toUtf8String(raw);
    return s && s.length > 0 ? s : "(no metadata)";
  } catch {
    return raw; // not UTF-8 (e.g. an IPFS CID in binary) — show raw hex
  }
}

/**
 * List proposals from `ProposalCreated` events, enriched best-effort with
 * on-chain state (`getProposal` / `canExecute` / `getVoteOption`). Read-only.
 */
export async function fetchProposals(
  cfg: ChainConfig,
  provider: ethers.providers.Provider,
  viewer?: string
): Promise<ProposalView[]> {
  const tv = tokenVotingContract(cfg, provider);
  const tip = await provider.getBlockNumber();
  const from = Math.max(0, tip - LOOKBACK_BLOCKS);
  const created = await queryFilterChunked(tv, tv.filters.ProposalCreated(), from, tip);
  const executedEvents = await queryFilterChunked(tv, tv.filters.ProposalExecuted(), from, tip);
  const executedIds = new Set(executedEvents.map((e) => e.args?.proposalId.toString()));

  const out: ProposalView[] = await Promise.all(
    created.map(async (ev) => {
      const id: string = ev.args?.proposalId.toString();
      const base: ProposalView = {
        id,
        creator: ev.args?.creator,
        startDate: Number(ev.args?.startDate),
        endDate: Number(ev.args?.endDate),
        summary: decodeMetadata(ev.args?.metadata),
        actions: (ev.args?.actions ?? []).map((a: {to: string; value: ethers.BigNumber; data: string}) => ({
          to: a.to,
          value: a.value.toString(),
          data: a.data,
        })),
        executed: executedIds.has(id),
        open: null,
        canExecute: false,
        tally: null,
        myVote: null,
      };

      // Best-effort enrichment; degrade gracefully if any read reverts/can't decode.
      const [proposal, canExec, myVote] = await Promise.allSettled([
        tv.getProposal(id),
        tv.canExecute(id),
        viewer ? tv.getVoteOption(id, viewer) : Promise.resolve(null),
      ]);

      if (proposal.status === "fulfilled" && proposal.value) {
        const p = proposal.value;
        base.open = p.open;
        base.executed = base.executed || p.executed;
        base.tally = {
          yes: p.tally.yes.toString(),
          no: p.tally.no.toString(),
          abstain: p.tally.abstain.toString(),
        };
      }
      if (canExec.status === "fulfilled") base.canExecute = canExec.value;
      if (myVote.status === "fulfilled" && myVote.value !== null) {
        base.myVote = Number(myVote.value) as VoteOptionValue;
      }
      // If the metadata is an ipfs:// pointer, resolve it to a human title
      // (best-effort; falls back to the raw URI on any failure).
      if (base.summary.startsWith("ipfs://")) {
        base.summary = await resolveMetadataTitle(base.summary);
      }
      return base;
    })
  );

  // Newest first.
  return out.sort((a, b) => Number(BigInt(b.id) - BigInt(a.id)));
}
