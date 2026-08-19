import type { ActState, CoreState } from "./types"
import { isDead, targetKey, claimName, releaseName } from "./types"
import { dialBig, dialBool } from "./dials"
import { acceptanceRepMilli, coinRewardBase, settleStakes, settleVotes } from "./math"
import { dropEdge, instanceAdjacency, ladderVia } from "./graph"

/**
 * Shared ruling effects — THE one implementation each consequence has, used by the act
 * ruling path, the contest ladder, coherence voids and REPLACE seating alike. In prod these
 * existed as three near-copies that drifted (the 2026-08-07/08-10 case law); here a second
 * implementation cannot exist because there is nowhere to put one.
 */

/** Losing-side forfeit fraction: A7 soft (the act merely stood/fell unraided) or hard. */
export const softHardF = (state: CoreState): bigint =>
  dialBool(state.dials, "A7_ACTIVE") ? dialBig(state.dials, "SOFT_FORFEIT_PERMILLE") : 1000n

/** The effects trace (DECOSTUME Phase 3, 2026-08-16): settlement DETAILS the projector must
 *  transcribe into rows — per-vote payouts, per-stake settlements — recorded as the reducer
 *  applies them. NOT part of state identity (never hashed, never validated); reset per event
 *  by applyEvent. The reducer decides; the projector transcribes; nothing recomputes.  */
export interface Fx {
  t: "vote" | "vote-void" | "stake" | "act-status" | "screen-status" | "holdback" | "rep"
  key?: string; fp?: string; payoutMilli?: bigint; stakeMilli?: bigint; side?: string; amountBase?: bigint; payoutBase?: bigint
  id?: string; kind?: string; status?: string; released?: boolean
}
let FX: Fx[] | null = null
export function beginFx() { FX = [] }
export function takeFx(): Fx[] { const out = FX ?? []; FX = null; return out }
const fx = (e: Fx) => { if (FX) FX.push(e) }
/** Status-change fx, callable from the ladder too. */
export const fxStatus = (t: "act-status" | "screen-status" | "holdback", id: string, kind: string, status: string) => fx({ t, id, kind, status })
/** Mark an actor's reputation as touched — the door syncs the row from folded state. */
export const fxRep = (fp: string) => fx({ t: "rep", fp })

/** Settle a vote market at its outcome and close it. Deterministic order; supply-exact. */
export function settleMarketVotes(state: CoreState, key: string, outcome: "ACCEPTED" | "REJECTED", fPermille: bigint) {
  const market = state.votes[key]
  if (!market || !Object.keys(market).length) return
  const settlement = settleVotes(market, outcome, fPermille, dialBig(state.dials, "CONCURRENCE_BONUS_MILLI"))
  for (const fp of Object.keys(settlement.deltasMilli).sort()) {
    const judge = state.actors[fp]
    judge.repMilli += settlement.deltasMilli[fp]
    judge.openStakeMilli -= market[fp].stakeMilli
    fx({ t: "vote", key, fp, payoutMilli: settlement.deltasMilli[fp], stakeMilli: market[fp].stakeMilli })
    fxRep(fp)
  }
  state.supply.repMintedMilli += settlement.mintedMilli
  state.supply.repBurnedMilli += settlement.burnedMilli
  delete state.votes[key]
}

/** Void a vote market — every stake freed, no deltas, no penalty (Law 31 resets, Law 30 voids). */
export function refundMarketVotes(state: CoreState, key: string) {
  const market = state.votes[key]
  if (!market) return
  for (const fp of Object.keys(market)) {
    state.actors[fp].openStakeMilli -= market[fp].stakeMilli
    fx({ t: "vote-void", key, fp })
  }
  delete state.votes[key]
}

/** Parimutuel-settle the open coin stakes on a target. Floor dust stays in the escrow pool. */
export function settleOpenStakes(state: CoreState, key: string, outcome: "ACCEPTED" | "REJECTED", notes: string[]) {
  const all = state.stakes[key]
  if (!all) return
  const open = all.filter(s => s.status === "OPEN")
  if (!open.length) return
  const { payouts, paidBase } = settleStakes(open, outcome)
  open.forEach((s, i) => {
    s.status = "SETTLED"
    s.payoutBase = payouts[i]
    if (payouts[i] > 0n) state.actors[s.fp].balanceBase += payouts[i]
    fx({ t: "stake", key, fp: s.fp, side: s.side, amountBase: s.amountBase, payoutBase: payouts[i] })
  })
  state.supply.escrowPoolBase -= paidBase
  notes.push(`settled ${open.length} stakes`)
}

/** Refund open coin stakes (one side or both) — a void is no judgment on the market. */
export function refundOpenStakes(state: CoreState, key: string, side: "ATTEST" | "RAID" | "BOTH") {
  const all = state.stakes[key]
  if (!all) return
  for (const s of all) {
    if (s.status !== "OPEN") continue
    if (side !== "BOTH" && s.side !== side) continue
    s.status = "SETTLED"
    s.payoutBase = s.amountBase
    state.actors[s.fp].balanceBase += s.amountBase
    state.supply.escrowPoolBase -= s.amountBase
    fx({ t: "stake", key, fp: s.fp, side: s.side, amountBase: s.amountBase, payoutBase: s.amountBase })
  }
}

export function freeName(state: CoreState, act: ActState) {
  if (act.nameNorm) releaseName(state.names, act.nameNorm, act.id) // plural since A+A (2026-08-16)
}

/** Undo EXACTLY the reputation an acceptance awarded (recorded at award time — no recompute drift). */
function clawbackAward(state: CoreState, act: ActState) {
  const clawed = act.awardedRepMilli ?? 0n
  if (clawed > 0n) {
    state.actors[act.authorFp].repMilli -= clawed
    state.supply.repBurnedMilli += clawed
    fxRep(act.authorFp)
  }
  return clawed
}

/** Law 30's cascade — a removed entry takes its dependents: pending ones void (votes and
 *  stakes refunded), accepted ones are orphan-struck with NO clawback (their authors weren't
 *  wrong; their foundation vanished). */
export function cascadeEntry(state: CoreState, entryId: string, notes: string[]) {
  for (const id of Object.keys(state.acts).sort()) {
    const dep = state.acts[id]
    if (isDead(dep.status) || dep.id === entryId) continue
    const touches =
      ((dep.kind === "DEFINITION" || dep.kind === "LABEL") && dep.entryId === entryId) ||
      (dep.kind === "EDGE" && (dep.fromEntryId === entryId || dep.toEntryId === entryId))
    if (!touches) continue
    const depKey = targetKey(dep.kind, dep.id)
    if (dep.status === "PROVISIONAL") refundMarketVotes(state, depKey)
    else dep.orphaned = true
    refundOpenStakes(state, depKey, "BOTH")
    dep.status = "REJECTED"
    fxStatus("act-status", dep.id, dep.kind, "REJECTED")
    freeName(state, dep)
    notes.push(`cascade ${dep.kind} ${dep.id}`)
  }
}

/** Strike a CONFIRMED act (upheld STRIKE challenge, court-ruled raid): flip off ACCEPTED with
 *  exact clawback, free its name, cascade if it is an entry. Coin-market settlement is the
 *  CALLER's move — who wins the pool depends on which door struck it. */
export function strikeConfirmed(state: CoreState, act: ActState, atSeq: number, rule: string, notes: string[]) {
  act.status = "REJECTED"
  act.ruling = { status: "REJECTED", atSeq, rule }
  fxStatus("act-status", act.id, act.kind, "REJECTED")
  const clawed = clawbackAward(state, act)
  freeName(state, act)
  if (act.kind === "ENTRY") cascadeEntry(state, act.id, notes)
  notes.push(`struck ${act.kind} ${act.id} (clawback ${clawed} milli)`)
}

/** Law 30 REPLACE: the target is SUPERSEDED, not struck-to-nothing — exact clawback (its
 *  author's act was ruled wrong), but NO cascade and NO name-freeing: the successor inherits
 *  the web and the words. Teardown of dependents is the ladder's job. */
export function supersedeReplaced(state: CoreState, act: ActState, succId: string, atSeq: number, rule: string, notes: string[]) {
  fxStatus("act-status", act.id, act.kind, "SUPERSEDED")
  act.status = "SUPERSEDED"
  act.ruling = { status: "REJECTED", atSeq, rule } // how it resolved; the status says how it fell
  act.supersededBy = succId
  const clawed = clawbackAward(state, act)
  notes.push(`superseded ${act.kind} ${act.id} → ${succId} (clawback ${clawed} milli)`)
}

/** The terminal ruling of a PROVISIONAL act and ALL its consequences, in the ruled order
 *  (D1 spec 4): reward → vote settlement → coin settlement → cascade → the eating. Also the
 *  seating path for REPLACE successors — one acceptance pipeline, no second copy. */
export function ruleProvisionalAct(state: CoreState, act: ActState, status: "ACCEPTED" | "REJECTED", rule: string, atSeq: number, notes: string[]) {
  act.status = status
  act.ruling = { status, atSeq, rule }
  fxStatus("act-status", act.id, act.kind, status)

  if (status === "ACCEPTED") {
    // Law 39 — an ACCEPTED name guards the door: the alias claims its word here, not at
    // filing (row-F, 2026-08-15). PLURAL since the keeper's A+A ruling (2026-08-16): every
    // accepted binding HOLDS — the word is a gem, and this is one more facet. The old
    // "narrowed to one" clause is retired; live was always the truer mirror of Law 39 here.
    if (act.kind === "LABEL" && act.nameNorm) {
      claimName(state.names, act.nameNorm, act.id)
    }
    // The court key authors acts only through its own organs (a REPLACE it filed directly —
    // dormant law today) and holds no actor row: an organ of the law takes no mint. Every
    // OTHER unknown author still crashes the fold loudly, as it must.
    const courtAuthored = act.authorFp === state.keys.court
    const n = act.kind === "EDGE" ? sameTypeAcceptedEdges(state, act) : 0
    const award = acceptanceRepMilli(state, act.kind, n)
    if (award > 0n && !courtAuthored) {
      state.actors[act.authorFp].repMilli += award
      state.supply.repMintedMilli += award
      act.awardedRepMilli = award
      fxRep(act.authorFp)
    }
    const R = coinRewardBase(state, act.kind, n)
    if (R > 0n && !courtAuthored) {
      const settled = R / 4n // Amendment 5: mint the quarter, hold the rest
      state.actors[act.authorFp].balanceBase += settled
      state.supply.coinMintedBase += settled
      act.holdback = { heldBase: R - settled, released: false }
    }
    if (act.kind === "EDGE" && !courtAuthored) payEdgeYield(state, act, notes)
    penalizeFalseFlags(state, act, notes) // the crowd accepted it — whoever flagged it cried wolf
  } else {
    freeName(state, act)
    delete state.flags[act.id] // a rejected act's flags were vindicated — no penalty, just done
  }

  settleMarketVotes(state, targetKey(act.kind, act.id), status, softHardF(state))
  settleOpenStakes(state, targetKey(act.kind, act.id), status, notes)
  if (status === "REJECTED" && act.kind === "ENTRY") cascadeEntry(state, act.id, notes)
  // Law 11e — a newly accepted rung may make existing direct leaps derivable: they are eaten
  if (status === "ACCEPTED" && act.kind === "EDGE" && act.edgeType === "INSTANCE_OF") subsumeLeaps(state, notes)

  notes.push(`${rule} ruled ${act.kind} ${act.id} ${status}`)
}

/** Amendment 5's edge yield: an edge that lands on ATTESTED structure pays the yield twice over —
 *  once to the writer for pointing at vouched-for ground, once to the attesters who vouched for it.
 *  Both are MINTS (the chain records the attester half as ROYALTY blocks), so supply grows by both.
 *
 *  An endpoint counts as attested if it carries any live attestation, and each endpoint is counted
 *  ONCE — a self-edge (from === to) names one endpoint, not two, which is why this dedupes rather
 *  than looping the pair. Mirrors liveAttestedEntries' `distinct` in lib/chain.ts.
 *
 *  The attester split is the exact rational floor — `pool * amount / total` in BigInt, never a
 *  float rounded afterwards — and a share that floors to nothing is not paid. Dust stays unminted.
 *  This must match lib/escrow.ts payEdgeRoyalties base unit for base unit: the two are one rule,
 *  and it was the reducer's silence about it that put 2.6 coins of drift into the first prod diff
 *  that ever spanned an edge acceptance.
 *
 *  THE ATTESTER IS THE UNIT, NOT THE STAKE ROW: a holder's rows are summed before the division, so
 *  the floor is taken once. The chain pays a recipient at most once per (entry, edge) anyway — the
 *  dedup that made the row-wise version lose 86% of a pool on prod — and flooring once is also the
 *  truer split, since a row is an accident of how the stake was placed, not a claim of its own. */
function payEdgeYield(state: CoreState, edge: ActState, notes: string[]) {
  const pool = dialBig(state.dials, "EDGE_YIELD_BASE")
  if (pool <= 0n) return

  const endpoints = [...new Set([edge.fromEntryId, edge.toEntryId].filter((id): id is string => !!id))]
  let attestedEndpoints = 0
  for (const entryId of endpoints) {
    const open = (state.stakes[targetKey("ENTRY", entryId)] ?? []).filter(s => s.status === "OPEN" && s.side === "ATTEST")
    const total = open.reduce((sum, s) => sum + s.amountBase, 0n)
    if (total <= 0n) continue
    attestedEndpoints++
    const staked = new Map<string, bigint>()
    for (const s of open) staked.set(s.fp, (staked.get(s.fp) ?? 0n) + s.amountBase)
    for (const [fp, amount] of staked) {
      const share = (pool * amount) / total
      if (share < 1n) continue
      state.actors[fp].balanceBase += share
      state.supply.coinMintedBase += share
    }
  }
  if (!attestedEndpoints) return

  const writerBonus = pool * BigInt(attestedEndpoints)
  state.actors[edge.authorFp].balanceBase += writerBonus
  state.supply.coinMintedBase += writerBonus
  notes.push(`edge yield: ${attestedEndpoints} attested endpoint(s) — writer and attesters both paid`)
}

export function sameTypeAcceptedEdges(state: CoreState, edge: ActState): number {
  let n = 0
  for (const id of Object.keys(state.acts)) {
    const a = state.acts[id]
    if (a.kind === "EDGE" && a.status === "ACCEPTED" && a.id !== edge.id && a.toEntryId === edge.toEntryId && a.edgeType === edge.edgeType) n++
  }
  return n
}

/** The false-flag cost: an act the crowd accepts was NOT incoherent — everyone still flagging
 *  it is debited (what keeps the flag from being a free weapon). */
function penalizeFalseFlags(state: CoreState, act: ActState, notes: string[]) {
  const flags = state.flags[act.id]
  if (!flags) return
  const cost = dialBig(state.dials, "FALSE_FLAG_COST_MILLI")
  for (const fp of Object.keys(flags).sort()) {
    state.actors[fp].repMilli -= cost
    fxRep(fp)
    state.supply.repBurnedMilli += cost
  }
  notes.push(`${Object.keys(flags).length} false flags penalized`)
  delete state.flags[act.id]
}

/** Law 11e-2, the eating: retire every live INSTANCE_OF leap derivable through the REST of
 *  the accepted ladder. No penalty, awards kept, markets refunded — better structure merely
 *  retired a true claim. */
export function subsumeLeaps(state: CoreState, notes: string[]) {
  // The ladder graph is built ONCE and then maintained. It used to be rebuilt inside the loop —
  // a full sorted scan of every act, per candidate edge — so one edge acceptance cost a sorted
  // pass over 18k acts for each of 2.4k INSTANCE_OF edges: ~23 SECONDS per ruling, which is what
  // made the nightly fold take longer than the day it was measuring.
  //
  // Two changes make it equivalent rather than merely similar. The candidate's self-exclusion
  // moves into ladderVia, which refuses to traverse that edge (identical to a graph built without
  // it). And the one thing the loop genuinely changes about the graph — a subsumed edge stops
  // being a rung for later candidates — is applied as it happens, in place, preserving order.
  // Same build order, same list order after a removal, so the fold yields byte-identical state.
  // A speedup that changed the answer would not be a speedup; it would be an unratified
  // amendment, which is why this landed behind a hash check against the real prod log.
  const adj = instanceAdjacency(state)
  for (const id of Object.keys(state.acts).sort()) {
    const e = state.acts[id]
    if (e.kind !== "EDGE" || e.edgeType !== "INSTANCE_OF" || isDead(e.status)) continue
    const via = ladderVia(adj, e.fromEntryId!, e.toEntryId!, e.id)
    if (!via) continue
    const key = targetKey("EDGE", e.id)
    if (e.status === "PROVISIONAL") refundMarketVotes(state, key)
    else e.orphaned = true // accepted leap: award kept, coins kept
    refundOpenStakes(state, key, "BOTH")
    e.status = "REJECTED"
    e.subsumedVia = via
    // ...and SAY SO on the effects trace. Every other status change here announces itself;
    // this one did not, so the fold struck the edge and the row kept saying PENDING — invisible
    // until an INSTANCE_OF acceptance finally made a leap derivable on prod (seq 670,
    // 2026-08-18) and the diff read 1. The replay test could never catch it: both sides of that
    // comparison reproduce the same missing write. Only fold-vs-rows sees a projection gap.
    // Safe for replay by construction — fx is never hashed and never validated, so adding one
    // changes what the projector HEARS, never what the fold DECIDES.
    fxStatus("act-status", e.id, e.kind, "REJECTED")
    dropEdge(adj, e.fromEntryId!, e.id) // struck: no longer a rung for the candidates after it
    notes.push(`subsumed EDGE ${e.id} via ${via} (Law 11e)`)
  }
}
