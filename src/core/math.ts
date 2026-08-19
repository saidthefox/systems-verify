import type { CoreState, OpenVote, Stake, VoteDir } from "./types"
import { dialBig, dialNum } from "./dials"

/**
 * Consensus math — integer only (D1 spec 1). No float ever touches a ruling: supermajority is
 * cross-multiplied, the Law 18 bar counts doublings with an integer loop (Math.log2 is
 * implementation-approximated and therefore banned here), parimutuel shares floor in milli-rep
 * exactly as coin shares floor in base units.
 */

// ── Law 18 rev 2 — the quorum bar ───────────────────────────────────────────

/** floor + one required judge per DOUBLING of the judging population, capped. Integer loop. */
export function quorumMinJudges(active: number, floor: number, ceiling: number): number {
  if (active <= floor) return floor
  let k = 0
  // largest k with floor·2^(k) ≤ active — the doubling count
  while (floor * 2 ** (k + 1) <= active) k++
  return Math.min(ceiling, Math.max(floor, floor + k))
}

/** Distinct judges whose most recent vote falls inside the trailing window, as of `nowTs`. */
export function activeJudges(state: CoreState, nowTs: string): number {
  const windowMs = dialNum(state.dials, "JUDGE_WINDOW_MS")
  const cutoff = Date.parse(nowTs) - windowMs
  let n = 0
  for (const fp of Object.keys(state.actors)) {
    const t = state.actors[fp].lastVoteTs
    if (t !== null && Date.parse(t) >= cutoff) n++
  }
  return n
}

/** Median reputation (milli) of the active judging population — the coherence bar's
 *  competence percentile. Even count → integer floor of the midpair average. */
export function medianActiveRepMilli(state: CoreState, nowTs: string): bigint {
  const windowMs = dialNum(state.dials, "JUDGE_WINDOW_MS")
  const cutoff = Date.parse(nowTs) - windowMs
  const reps: bigint[] = []
  for (const fp of Object.keys(state.actors)) {
    const a = state.actors[fp]
    if (a.lastVoteTs !== null && Date.parse(a.lastVoteTs) >= cutoff) reps.push(a.repMilli)
  }
  if (!reps.length) return 0n
  reps.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0))
  const mid = Math.floor(reps.length / 2)
  return reps.length % 2 ? reps[mid] : (reps[mid - 1] + reps[mid]) / 2n
}

export interface Crossing {
  status: "ACCEPTED" | "REJECTED"
  advanceMilli: bigint
  strikeMilli: bigint
}

/** Evaluate the act-screen crossing (quorum.v1). Null = no clear consensus yet. */
export function quorumCrossing(state: CoreState, votes: Record<string, OpenVote>, nowTs: string): Crossing | null {
  const floor = dialNum(state.dials, "QUORUM_FLOOR")
  const ceiling = dialNum(state.dials, "QUORUM_CEILING")
  const minJudges = quorumMinJudges(activeJudges(state, nowTs), floor, ceiling)
  const voters = Object.keys(votes)
  // Law 31b-i: a zero-stake vote is direction, not weight — it counts toward no bar
  if (voters.filter(fp => votes[fp].stakeMilli > 0n).length < minJudges) return null

  let A = 0n
  let S = 0n
  for (const fp of voters) {
    const v = votes[fp]
    if (v.dir === "ADVANCE") A += v.stakeMilli
    else S += v.stakeMilli
  }
  const total = A + S
  // each judge stakes ≥ 1 rep, so weight tracks the count — same bar, in milli
  if (total < BigInt(minJudges) * 1000n) return null
  // 2/3 supermajority, cross-multiplied: A/total ≥ 2/3  ⇔  3A ≥ 2·total
  const status = 3n * A >= 2n * total ? "ACCEPTED" : 3n * S >= 2n * total ? "REJECTED" : null
  return status ? { status, advanceMilli: A, strikeMilli: S } : null
}

// ── Laws 19/19a/27 + A7 — the reputation parimutuel ─────────────────────────

export interface VoteSettlement {
  deltasMilli: Record<string, bigint> // voterFp → applied reputation delta
  mintedMilli: bigint // concurrence bonuses
  burnedMilli: bigint // forfeit pool the floor left unclaimed (or wholly unclaimed when W=0)
}

/**
 * Settle a vote market at its outcome. mode soft forfeits stake·f/1000 (A7 7B); hard forfeits
 * the whole stake. Winners split the forfeit pool pro-rata by stake (integer floor) plus the
 * minted concurrence bonus. Zero-sum apart from the mint; the dust is burned, and both flows
 * are returned so the supply invariant stays checkable to the milli.
 */
export function settleVotes(
  votes: Record<string, OpenVote>,
  outcome: "ACCEPTED" | "REJECTED",
  fPermille: bigint,
  bonusMilli: bigint,
): VoteSettlement {
  const winDir: VoteDir = outcome === "ACCEPTED" ? "ADVANCE" : "STRIKE"
  const voters = Object.keys(votes).sort() // deterministic application order
  let W = 0n
  let L = 0n
  for (const fp of voters) {
    const v = votes[fp]
    if (v.dir === winDir) W += v.stakeMilli
    else L += (v.stakeMilli * fPermille) / 1000n
  }
  const deltasMilli: Record<string, bigint> = {}
  let distributed = 0n
  let minted = 0n
  for (const fp of voters) {
    const v = votes[fp]
    if (v.dir === winDir) {
      const share = W > 0n ? (v.stakeMilli * L) / W : 0n
      const bonus = v.stakeMilli > 0n ? bonusMilli : 0n // Law 31b-i: direction-only votes sit outside the judges' economy
      deltasMilli[fp] = share + bonus
      distributed += share
      minted += bonus
    } else {
      deltasMilli[fp] = -((v.stakeMilli * fPermille) / 1000n)
    }
  }
  return { deltasMilli, mintedMilli: minted, burnedMilli: L - distributed }
}

// ── Amendment 4/5 — the coin parimutuel ─────────────────────────────────────

export interface StakeSettlement {
  payouts: Record<number, bigint> // stake index → payout in base units (0 for losers)
  paidBase: bigint // total leaving escrow
}

/** Winners reclaim stake + floor(stake·L/W); losers forfeit. Identical math to escrow.ts. */
export function settleStakes(open: Stake[], outcome: "ACCEPTED" | "REJECTED"): StakeSettlement {
  const winSide = outcome === "ACCEPTED" ? "ATTEST" : "RAID"
  let W = 0n
  let L = 0n
  for (const s of open) {
    if (s.side === winSide) W += s.amountBase
    else L += s.amountBase
  }
  const payouts: Record<number, bigint> = {}
  let paid = 0n
  open.forEach((s, i) => {
    const won = s.side === winSide
    const payout = won ? s.amountBase + (W > 0n ? (s.amountBase * L) / W : 0n) : 0n
    payouts[i] = payout
    paid += payout
  })
  return { payouts, paidBase: paid }
}

// ── Laws 11c/21/29 — acceptance rewards ─────────────────────────────────────

/** Acceptance reputation in milli: flat for entries/definitions/facets, the diminishing curve
 *  for edges (2·K/(K+n), floored in milli), nothing for labels (Law 39). */
export function acceptanceRepMilli(state: CoreState, actKind: string, sameTypeAcceptedEdges: number): bigint {
  if (actKind === "LABEL") return 0n
  const base = dialBig(state.dials, "ACCEPT_REWARD_MILLI")
  if (actKind !== "EDGE") return base
  const K = dialBig(state.dials, "EDGE_DECAY_K")
  return (base * K) / (K + BigInt(sameTypeAcceptedEdges))
}

/** Full coin reward R in base units; the mint credits floor(R/4) and holds the rest (A5). */
export function coinRewardBase(state: CoreState, actKind: string, sameTypeAcceptedEdges: number): bigint {
  if (actKind === "ENTRY") return dialBig(state.dials, "REWARD_ENTRY_BASE")
  if (actKind === "DEFINITION") return dialBig(state.dials, "REWARD_DEFINITION_BASE")
  if (actKind === "LABEL") return dialBig(state.dials, "REWARD_LABEL_BASE")
  if (actKind === "EDGE") {
    const K = dialBig(state.dials, "EDGE_DECAY_K")
    const r = dialBig(state.dials, "REWARD_EDGE_BASE") / (K + BigInt(sameTypeAcceptedEdges))
    return r < 1n ? 1n : r
  }
  return 0n
}
