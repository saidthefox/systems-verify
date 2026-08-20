import type { ActState, Challenge, CoreState, EventEnvelope, Raid, ScreenV2 } from "./types"
import { EDGE_TYPES, RAID_LIVE, isDead, targetKey, claimName, nameHolders } from "./types"
import { sha256 } from "./canonical"
import { LIMITS, firstTooLong } from "./limits"
import { dialBig, dialBool, dialNum } from "./dials"
import { activeJudges, quorumCrossing, quorumMinJudges } from "./math"
import { drawJury, drawSeed, eligibleJurors, jurySize, nextSeed } from "./sortition"
import {
  freeName, fxActSync, fxRep, fxStatus, refundMarketVotes, refundOpenStakes, ruleProvisionalAct, settleMarketVotes,
  settleOpenStakes, softHardF, strikeConfirmed, supersedeReplaced,
} from "./effects"

/**
 * The contest ladder — Laws 14/24/30/31, Amendment 5E — as ONE parameterized rule.
 *
 * Prod carries three near-copies of the screen-crossing logic (maybeAutoAdvance,
 * maybeRuleContest, resolveRaidScreen); here both contest screens share the act screens'
 * quorumCrossing and differ only in their Law 31 overlay (human concurrence seals, human
 * dissent resets) and their consequences. Routing is the target's state, never the player's
 * choice: un-attested confirmed act → challenge screen (stake burned at filing, Law 14);
 * attested → the raid ladder (SCREEN → COALITION at conviction parity → COURT; only the
 * court strikes, Law 24). Raid screens settle HARD — the raid is the hard layer (A7 7A);
 * challenge screens settle by the A7 dial, exactly as executeContestRuling does.
 *
 * Phase 1 remaining, refused loudly at the door: mode REPLACE (successor seating).
 */

const CONTESTABLE = new Set(["ENTRY", "DEFINITION", "EDGE"])
// same whitelist as the live door's VALID_DEFECTS — one enum, two mouths
const DEFECTS = new Set(["EQUIVOCATION", "MISCLASSIFICATION", "DEFINITION_FAILS_TO_CARVE", "PARAMETER_GAP", "SUPERSEDED_BY", "OUT_OF_SCOPE"])

const str = (p: Record<string, unknown>, k: string): string | null =>
  typeof p[k] === "string" && (p[k] as string).length > 0 ? (p[k] as string) : null
const amt = (p: Record<string, unknown>, k: string): bigint | null =>
  typeof p[k] === "string" && /^[0-9]+$/.test(p[k] as string) ? BigInt(p[k] as string) : null

export function liveChallengeFor(state: CoreState, targetId: string): Challenge | null {
  for (const id of Object.keys(state.challenges).sort()) {
    const c = state.challenges[id]
    if (c.targetId === targetId && c.status === "PENDING") return c
  }
  return null
}

export function liveRaidFor(state: CoreState, targetId: string): Raid | null {
  for (const id of Object.keys(state.raids).sort()) {
    const r = state.raids[id]
    if (r.targetId === targetId && RAID_LIVE.includes(r.status)) return r
  }
  return null
}

const hasLiveAttestation = (state: CoreState, key: string): boolean =>
  (state.stakes[key] ?? []).some(s => s.status === "OPEN" && s.side === "ATTEST")

// ── the one door (Law 31) ───────────────────────────────────────────────────

export function validateContest(state: CoreState, e: Pick<EventEnvelope, "actor" | "payload">): string | null {
  const p = e.payload
  // The court and its offices contest without stake or burn (keeper's ruling 2026-08-15): their
  // office is to put questions to the population, not to wager against it. Live exempts the
  // ADMIN filer (isAdmin, /api/contest) — offices reach the fold as `system` actors, and the
  // court key is exempt as dormant law for the day it files directly. Both arrive on the
  // challenge screen only: a raid is a coin position, and an organ of the law holds no position.
  const actor = state.actors[e.actor]
  const exempt = e.actor === state.keys.court || actor?.entityType === "system"
  if (!exempt) {
    if (!actor || (actor.entityType !== "agent" && actor.entityType !== "user")) return "unknown contester"
    if (actor.entityType === "agent" && !dialBool(state.dials, "CONTEST_AGENTS_OPEN")) {
      return "the contest court is not yet open to agents (Law 31 dial)"
    }
  }
  const tt = str(p, "targetType")
  const tid = str(p, "targetId")
  if (!tt || !tid || !CONTESTABLE.has(tt)) return "targetType must be ENTRY, DEFINITION or EDGE"
  if (!str(p, "reasoning")) return "reasoning is required — a contest without a defect teaches no one"
  const bigC = firstTooLong([["reasoning", str(p, "reasoning")!, LIMITS.REASONING]])
  if (bigC) return bigC
  // the defect names WHICH law the target offends — same whitelist as the live door.
  // REQUIRED from Amendment 14's activation seq, optional before it. The gate is a DIAL the
  // amendment sets through activatePending, not an edit to this function, because a replay must
  // judge each event under the rule in force at ITS seq — an unconditional check here would turn
  // every pre-activation contest into a fold crash. dialBool reads false for a dial nobody has
  // set, so the era before the amendment needs no genesis entry; and a genesis dial would have
  // appeared in every historical state and moved the very hash the pins commit to.
  const defect = str(p, "defect")
  if (defect !== null && !DEFECTS.has(defect)) return `defect must be one of: ${[...DEFECTS].join(", ")}`
  if (defect === null && dialBool(state.dials, "CONTEST_DEFECT_REQUIRED")) {
    return `a contest must name its defect (Amendment 14) — one of: ${[...DEFECTS].join(", ")}`
  }
  const mode = str(p, "mode") ?? "STRIKE"
  if (mode !== "STRIKE" && mode !== "REPLACE") return "mode must be STRIKE (remove) or REPLACE (seat a successor, Law 30)"
  if (mode === "REPLACE") {
    const specErr = replaceSpecError(str(p, "targetType") ?? "", p.replacementSpec)
    if (specErr) return specErr
  }
  const act = state.acts[tid]
  if (!act || act.kind !== tt) return "target not found"
  if (act.status !== "ACCEPTED") return "only the CONFIRMED record is contested — judge a provisional act instead (Law 18)"
  // shadow parity: the emitter may carry prod's own contest id so screen votes join across
  // systems (the ACT_FILED/actId move, applied to contests)
  const cid = str(p, "contestId")
  if (cid && (state.challenges[cid] || state.raids[cid])) return "contestId already used"
  if (liveChallengeFor(state, tid)) return "this act already has a live contest on the challenge screen — judge that instead (one live contest per target)"
  if (hasLiveAttestation(state, targetKey(tt, tid))) {
    // An OFFICE may raid — with real coins, like anyone (live has always allowed it; the
    // 2026-08-15 "an organ holds no position" refusal was this reducer legislating, not
    // mirroring — retracted by the audit batch, 2026-08-16). Only the court KEY cannot: it has
    // no actor row and no balance to stake.
    if (e.actor === state.keys.court) return "the court key holds no balance — a raid stakes real coins; the office raids under its own account"
    const coins = amt(p, "coinsBase")
    if (coins === null || coins < dialBig(state.dials, "RAID_MIN_COINS_BASE")) {
      return "attested target — contesting it stakes coins against the attester pool; pass coinsBase ≥ 1 coin"
    }
    if (actor!.balanceBase < coins) return "insufficient coin balance"
  } else if (!exempt && actor!.balanceBase < dialBig(state.dials, "CHALLENGE_STAKE_BASE")) {
    return "contesting an un-attested act burns the challenge stake (Law 14) — insufficient coins"
  }
  return null
}

export function applyContest(state: CoreState, e: EventEnvelope, notes: string[]) {
  const p = e.payload
  const tt = str(p, "targetType")!
  const tid = str(p, "targetId")!
  const key = targetKey(tt, tid)
  // a stale coalition on this target expires before routing — the join-sweep, deterministic
  expireStaleCoalitions(state, e.ts, notes, tid)

  if (hasLiveAttestation(state, key)) {
    const coins = BigInt(p.coinsBase as string)
    state.actors[e.actor].balanceBase -= coins
    state.supply.escrowPoolBase += coins
    ;(state.stakes[key] ??= []).push({ fp: e.actor, side: "RAID", amountBase: coins, status: "OPEN", payoutBase: 0n, placedSeq: e.seq })
    let raid = liveRaidFor(state, tid)
    if (!raid) {
      const id = str(p, "contestId") ?? `raid:${tt}:${tid}:${e.seq}` // prod's id when the emitter carries it (D6 otherwise)
      raid = { id, targetType: tt, targetId: tid, status: "SCREEN", openedByFp: e.actor, frozenAttestBase: null, advancedTs: null }
      if (screenV2Active(state)) raid.v2 = { phase: "JURY", phaseTs: e.ts }
      state.raids[raid.id] = raid
      notes.push(`raid opened ${raid.id}`)
    } else {
      notes.push(`raid joined ${raid.id}`)
    }
    if (raid.status === "COALITION") checkParity(state, raid, e.ts, notes)
  } else {
    // the court and its offices file without the burn (keeper 2026-08-15; live's isAdmin exemption)
    const exempt = e.actor === state.keys.court || state.actors[e.actor]?.entityType === "system"
    if (!exempt) {
      const burn = dialBig(state.dials, "CHALLENGE_STAKE_BASE")
      state.actors[e.actor].balanceBase -= burn
      state.supply.coinBurnedBase += burn // burned at filing, Law 14 — not escrowed
      state.burns[String(e.seq)] = { fp: e.actor, amountBase: burn, compensated: false } // mirrorable (A8)
    }
    const mode = (str(p, "mode") ?? "STRIKE") as "STRIKE" | "REPLACE"
    const c: Challenge = {
      id: str(p, "contestId") ?? `challenge:${tt}:${tid}:${e.seq}`, targetType: tt, targetId: tid, mode,
      ...(mode === "REPLACE" ? { replacementSpec: p.replacementSpec as Record<string, unknown> } : {}),
      authorFp: e.actor, status: "PENDING", filedSeq: e.seq,
    }
    if (screenV2Active(state)) c.v2 = { phase: "JURY", phaseTs: e.ts } // the draw waits for the clock
    state.challenges[c.id] = c
    notes.push(`challenge opened ${c.id}`)
  }
}

// ── screen votes (targetType CHALLENGE | RAID) ──────────────────────────────

export function validateScreenVote(state: CoreState, actorFp: string, tt: string, tid: string): string | null {
  const judge = state.actors[actorFp]
  if (judge.entityType === "agent" && !dialBool(state.dials, "CONTEST_AGENTS_OPEN")) {
    return "contest screens are not yet open to agents (Law 31 dial)"
  }
  if (tt === "CHALLENGE") {
    const c = state.challenges[tid]
    if (!c) return "no such contest"
    if (c.status !== "PENDING") return `this contest is already resolved (${c.status})`
    if (c.parked) return "this screen is parked for the court (Law 31b-ii) — no further votes land"
    if (c.v2) return "this is a SEALED screen (screen.v2) — jurors VOTE_COMMIT, then VOTE_REVEAL"
    if (c.authorFp === actorFp) return "you cannot judge your own contest (Law 15)"
    return null
  }
  const r = state.raids[tid]
  if (!r) return "no such raid"
  if (r.status !== "SCREEN") return "this raid is past the screening stage"
  if (r.parked) return "this screen is parked for the court (Law 31b-ii) — no further votes land"
  if (r.v2) return "this is a SEALED screen (screen.v2) — jurors VOTE_COMMIT, then VOTE_REVEAL"
  if (r.openedByFp === actorFp) return "you cannot judge your own raid (Law 15)"
  return null
}

// Law 38b-i: the seal (and the dissent) belong to a SEATED human — a user housed under a proof
// of personhood. validateVote refuses unseated screen votes at the door; this mirrors the same
// seat on the read side, so an unhoused vote already in a market never seals or resets a screen.
const humanOn = (state: CoreState, market: Record<string, { dir: string }>, dir: string): boolean =>
  Object.keys(market).some(fp => state.actors[fp].entityType === "user" && !!state.actors[fp].houseId && market[fp].dir === dir)

/** The Law 31 overlay shared by both screens: quorum weighs; a person seals; a person's
 *  doubt re-opens — once. Returns the verdict to execute, or null (parked / reset / no consensus). */
function screenCrossing(state: CoreState, key: string, e: EventEnvelope, notes: string[], screen: Challenge | Raid): "ACCEPTED" | "REJECTED" | null {
  // Laws 31c/31d are ratified dormant and UNIMPLEMENTED — a lit dial halts the fold (D1)
  if (dialNum(state.dials, "SEAL_WINDOW_MS") !== 0 || dialNum(state.dials, "DISSENT_SLOTS") !== 0) {
    throw new Error("Law 31c/31d dials are set but their machinery is not implemented — refusing to fold under unimplemented law")
  }
  const v2 = screen.v2
  const market = state.votes[key] ?? {}
  const crossing = quorumCrossing(state, market, e.ts)
  if (!crossing) return null
  const winDir = crossing.status === "ACCEPTED" ? "ADVANCE" : "STRIKE"
  const loseDir = winDir === "ADVANCE" ? "STRIKE" : "ADVANCE"
  if (humanOn(state, market, loseDir)) {
    const limit = dialNum(state.dials, "HUMAN_RESET_LIMIT")
    if (limit > 0 && (screen.humanResets ?? 0) >= limit) {
      // Law 31b-ii: two doubts go to the court. Nothing is voided — the standing market and
      // the dissent ARE the case file; only a COURT_RULING concludes a parked screen.
      screen.parked = true
      if (v2) {
        v2.phase = "PARKED"
        v2.phaseTs = e.ts
      }
      notes.push("human dissent again — the screen parks for the court (Law 31b-ii); the market stands as the case file")
      return null
    }
    screen.humanResets = (screen.humanResets ?? 0) + 1
    refundMarketVotes(state, key) // human dissent voids the screen — refund all, restart at zero
    if (v2) {
      // sealed screens restart FURTHER back: fresh jury at the next TICK, fresh seed —
      // a person's doubt re-opens the question to different judges, not the same twelve
      v2.phase = "JURY"
      v2.phaseTs = e.ts
      delete v2.juryFps
      delete v2.jurySeed
      delete v2.commits
      v2.altRounds = 0
    }
    notes.push("human dissent reset the screen (Law 31)")
    return null
  }
  if (!humanOn(state, market, winDir)) {
    notes.push("awaiting human concurrence (Law 31)")
    return null
  }
  return crossing.status
}

export function evaluateChallengeScreen(state: CoreState, c: Challenge, e: EventEnvelope, notes: string[]) {
  const verdict = screenCrossing(state, targetKey("CHALLENGE", c.id), e, notes, c)
  if (verdict) executeChallengeRuling(state, c, verdict, c.v2 ? "screen.v2" : "quorum.v1", e.seq, notes)
}

export function evaluateRaidScreen(state: CoreState, raid: Raid, e: EventEnvelope, notes: string[]) {
  const verdict = screenCrossing(state, targetKey("RAID", raid.id), e, notes, raid)
  if (!verdict) return
  if (verdict === "REJECTED") executeRaidDismissal(state, raid, notes)
  else executeRaidAdvance(state, raid, e.ts, notes)
}

// ── consequences ────────────────────────────────────────────────────────────

/** ACCEPTED = upheld (the target falls — and mode REPLACE seats its successor in the same
 *  ruling), REJECTED = dismissed (the stake stays burned). Returns false only when an upheld
 *  REPLACE cannot materialize — the contest then stays PENDING for the court, exactly prod's
 *  failed-swap-leaves-it-pending semantics, and the vote market stays open. */
export function executeChallengeRuling(state: CoreState, c: Challenge, verdict: "ACCEPTED" | "REJECTED", rule: string, atSeq: number, notes: string[]): boolean {
  if (verdict === "ACCEPTED" && c.mode === "REPLACE") {
    const blocked = replaceFeasible(state, c)
    if (blocked) {
      notes.push(`successor cannot materialize — ${blocked}; contest parked for the court`)
      return false
    }
  }
  c.status = verdict
  fxStatus("screen-status", c.id, "CHALLENGE", verdict)
  if (verdict === "ACCEPTED") {
    // The court key holds no actor row and takes no award for a contest it filed itself
    // (dormant law — office contests carry the office's own fp and are paid like live pays
    // them). Any other unknown author still crashes the fold loudly.
    const author = c.authorFp === state.keys.court ? null : state.actors[c.authorFp]
    if (author) {
      const repAward = dialBig(state.dials, "CHALLENGE_UPHELD_REP_MILLI")
      author.repMilli += repAward
      state.supply.repMintedMilli += repAward
      fxRep(c.authorFp)
      const coinAward = dialBig(state.dials, "CHALLENGE_UPHELD_COIN_BASE")
      author.balanceBase += coinAward
      state.supply.coinMintedBase += coinAward
    }
    if (c.mode === "REPLACE") {
      // Law 30: seat FIRST (prod seats before the strike), then supersede, then hand the
      // web and the words to the successor.
      const target = state.acts[c.targetId]
      const succId = seatSuccessor(state, c, rule, atSeq, notes)
      c.successorId = succId
      supersedeReplaced(state, target, succId, atSeq, `${rule}.replace`, notes)
      if (c.targetType === "ENTRY") teardownReplacedEntry(state, c, target, succId, notes)
    } else {
      strikeConfirmed(state, state.acts[c.targetId], atSeq, `${rule}.challenge`, notes)
    }
    // The act fell, so a market that attested it AFTER the challenge was filed closes as
    // forfeit — nothing pays out (no RAID side), the coins stay escrowed. In prod this was
    // the 2026-08-10 stranded-market fix; here it is one line that cannot be forgotten.
    settleOpenStakes(state, targetKey(c.targetType, c.targetId), "REJECTED", notes)
  }
  settleMarketVotes(state, targetKey("CHALLENGE", c.id), verdict, softHardF(state))
  notes.push(`challenge ${c.id} ${verdict === "ACCEPTED" ? "UPHELD" : "DISMISSED"}`)
  return true
}

// ── Law 30 mode REPLACE — the succession ────────────────────────────────────

/** Shape-validate a replacementSpec at filing, so a malformed swap can't be proposed. */
export function replaceSpecError(targetType: string, spec: unknown): string | null {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    return "mode REPLACE requires a replacementSpec object describing the successor"
  }
  const s = spec as Record<string, unknown>
  const has = (k: string) => typeof s[k] === "string" && (s[k] as string).trim().length > 0
  if (targetType === "ENTRY") {
    if (has("existingEntryId")) return null
    if (!has("canonicalName") || !has("scopeJustification") || !has("definitionBody")) {
      return "ENTRY replacementSpec needs existingEntryId, or a full draft: canonicalName, scopeJustification, definitionBody — a replacement must carve (Law 5)"
    }
    return null
  }
  if (targetType === "DEFINITION") return has("body") ? null : "DEFINITION replacementSpec needs body"
  if (targetType === "EDGE") {
    if (!has("fromEntryId") || !has("toEntryId")) return "EDGE replacementSpec needs fromEntryId and toEntryId"
    if (!EDGE_TYPES.has(String(s.edgeType))) return `EDGE replacementSpec edgeType must be one of: ${[...EDGE_TYPES].join(", ")}`
    if (s.fromEntryId === s.toEntryId) return "EDGE replacementSpec cannot be a self-loop"
    return null
  }
  return `unsupported REPLACE targetType ${targetType}`
}

import { norm } from "./canonical" // Law 12 as revised by 12-ii — one normalizer, everywhere

/** Can the successor materialize RIGHT NOW? Checked at ruling time (the world moved since
 *  filing) — by the quorum path before executing, and by COURT_RULING validation. */
export function replaceFeasible(state: CoreState, c: Challenge): string | null {
  const spec = (c.replacementSpec ?? {}) as Record<string, unknown>
  if (c.targetType === "ENTRY") {
    const existing = typeof spec.existingEntryId === "string" ? spec.existingEntryId : null
    if (existing) {
      const succ = state.acts[existing]
      if (!succ || succ.kind !== "ENTRY" || succ.status !== "ACCEPTED") return "existingEntryId must be a confirmed entry"
      if (succ.id === c.targetId) return "replacement cannot be the target itself"
      return null
    }
    const n = norm(spec.canonicalName as string)
    const blocked = nameHolders(state.names, n).some(h => {
      const a = state.acts[h]
      return (a.kind === "ENTRY" ? a.id : a.entryId) !== c.targetId
    })
    if (blocked) return `replacement name already held (Law 12): ${spec.canonicalName}`
    return null
  }
  if (c.targetType === "DEFINITION") {
    const old = state.acts[c.targetId]
    const entry = old?.entryId ? state.acts[old.entryId] : null
    if (!entry || isDead(entry.status)) return "the definition's entry no longer stands — nothing to re-define"
    return null
  }
  // EDGE
  const from = state.acts[spec.fromEntryId as string]
  const to = state.acts[spec.toEntryId as string]
  if (!from || from.kind !== "ENTRY" || isDead(from.status) || !to || to.kind !== "ENTRY" || isDead(to.status)) {
    return "replacement edge endpoints must be live entries"
  }
  for (const id of Object.keys(state.acts)) {
    const a = state.acts[id]
    if (a.kind === "EDGE" && !isDead(a.status) && a.id !== c.targetId &&
        a.fromEntryId === spec.fromEntryId && a.toEntryId === spec.toEntryId && a.edgeType === spec.edgeType) {
      return "the corrected edge already exists — file a plain STRIKE instead"
    }
  }
  return null
}

/** Create the successor ACCEPTED through the ONE acceptance pipeline (award, quarter-mint,
 *  holdback, the eating) — authored by the challenger, ids derived from the challenge (D6). */
function seatSuccessor(state: CoreState, c: Challenge, rule: string, atSeq: number, notes: string[]): string {
  const spec = (c.replacementSpec ?? {}) as Record<string, unknown>
  const seat = (act: ActState) => {
    state.acts[act.id] = act
    ruleProvisionalAct(state, act, "ACCEPTED", `${rule}.replace-seat`, atSeq, notes)
    return act.id
  }
  if (c.targetType === "ENTRY") {
    const existing = typeof spec.existingEntryId === "string" ? spec.existingEntryId : null
    if (existing) return existing // a confirmed entry takes the place — nothing to seat
    const entryId = `succ:${c.id}`
    const n = norm(spec.canonicalName as string)
    seat({ id: entryId, kind: "ENTRY", authorFp: c.authorFp, status: "PROVISIONAL", filedSeq: atSeq, contentHash: `replace:${c.id}`, nameNorm: n })
    claimName(state.names, n, entryId) // claim ALONGSIDE (plural, A+A) — the relic's hold outlives it, as live's labelHolders always did
    seat({ id: `succdef:${c.id}`, kind: "DEFINITION", authorFp: c.authorFp, status: "PROVISIONAL", filedSeq: atSeq, contentHash: `replacedef:${c.id}`, entryId })
    return entryId
  }
  if (c.targetType === "DEFINITION") {
    const old = state.acts[c.targetId]
    return seat({ id: `succ:${c.id}`, kind: "DEFINITION", authorFp: c.authorFp, status: "PROVISIONAL", filedSeq: atSeq, contentHash: `replace:${c.id}`, entryId: old.entryId })
  }
  return seat({
    id: `succ:${c.id}`, kind: "EDGE", authorFp: c.authorFp, status: "PROVISIONAL", filedSeq: atSeq, contentHash: `replace:${c.id}`,
    fromEntryId: spec.fromEntryId as string, toEntryId: spec.toEntryId as string, edgeType: spec.edgeType as string,
  })
}

/** The succession's teardown: the replaced entry's edges re-point to the successor (collisions
 *  and self-loops removed instead — voided pending, orphaned accepted, markets refunded), its
 *  pending dependents void, its accepted definitions orphan, and its accepted names transfer
 *  (Law 39: a merged concept keeps every word it ever carried). */
function teardownReplacedEntry(state: CoreState, c: Challenge, old: ActState, succId: string, notes: string[]) {
  for (const id of Object.keys(state.acts).sort()) {
    const dep = state.acts[id]
    if (isDead(dep.status) || dep.id === old.id || dep.id === succId) continue

    if (dep.kind === "EDGE" && (dep.fromEntryId === old.id || dep.toEntryId === old.id)) {
      const from = dep.fromEntryId === old.id ? succId : dep.fromEntryId!
      const to = dep.toEntryId === old.id ? succId : dep.toEntryId!
      const collision = from === to || Object.keys(state.acts).some(oid => {
        const o = state.acts[oid]
        return o.kind === "EDGE" && !isDead(o.status) && o.id !== dep.id &&
          o.fromEntryId === from && o.toEntryId === to && o.edgeType === dep.edgeType
      })
      if (collision) {
        if (dep.status === "PROVISIONAL") refundMarketVotes(state, targetKey("EDGE", dep.id))
        else dep.orphaned = true
        refundOpenStakes(state, targetKey("EDGE", dep.id), "BOTH")
        dep.status = "REJECTED"
        fxStatus("act-status", dep.id, dep.kind, "REJECTED")
        notes.push(`edge ${dep.id} removed (would collide after re-pointing)`)
      } else {
        dep.fromEntryId = from
        dep.toEntryId = to
        fxActSync(dep.id, dep.kind)
        notes.push(`edge ${dep.id} re-pointed to ${succId}`)
      }
      continue
    }

    if (dep.kind === "DEFINITION" && dep.entryId === old.id) {
      if (dep.status === "PROVISIONAL") refundMarketVotes(state, targetKey("DEFINITION", dep.id))
      else dep.orphaned = true // its author wasn't wrong — the construct got a better carving
      refundOpenStakes(state, targetKey("DEFINITION", dep.id), "BOTH")
      dep.status = "REJECTED"
      fxStatus("act-status", dep.id, dep.kind, "REJECTED")
      notes.push(`definition ${dep.id} ${dep.orphaned ? "orphaned" : "voided"}`)
      continue
    }

    if (dep.kind === "LABEL" && dep.entryId === old.id) {
      if (dep.status === "ACCEPTED") {
        dep.entryId = succId // the word transfers; the names map already points at this act
        fxActSync(dep.id, dep.kind)
        notes.push(`label ${dep.id} transferred to ${succId}`)
      } else {
        refundMarketVotes(state, targetKey("LABEL", dep.id))
        refundOpenStakes(state, targetKey("LABEL", dep.id), "BOTH")
        dep.status = "REJECTED"
        fxStatus("act-status", dep.id, dep.kind, "REJECTED")
        freeName(state, dep)
        notes.push(`label ${dep.id} voided`)
      }
    }
  }

  // the old CANONICAL name rides to the successor as an alias (Law 39), unless the successor
  // already answers to it (a draft that reused the name took it over at seating)
  if (old.nameNorm && nameHolders(state.names, old.nameNorm).includes(old.id)) {
    const aliasId = `succalias:${c.id}`
    state.acts[aliasId] = {
      id: aliasId, kind: "LABEL", authorFp: c.authorFp, status: "ACCEPTED", filedSeq: old.filedSeq,
      contentHash: `alias:${c.id}`, entryId: succId, nameNorm: old.nameNorm,
      ruling: { status: "ACCEPTED", atSeq: old.filedSeq, rule: "law39.transfer" }, // bookkeeping, never rewarded
    }
    fxActSync(aliasId, "LABEL")
    // plural (A+A): the relic's own claim hands over — the alias row IS the transferred hold,
    // in the relic's old position; other concepts' holds on the word are untouched.
    const l = state.names[old.nameNorm]!
    l[l.indexOf(old.id)] = aliasId
    notes.push(`name '${old.nameNorm}' transferred to ${succId} as alias`)
  }
}

function executeRaidDismissal(state: CoreState, raid: Raid, notes: string[]) {
  raid.status = "DISMISSED"
  fxStatus("screen-status", raid.id, "RAID", "DISMISSED")
  // frivolous raid: raiders forfeit to the attesters; the screen settles HARD against STRIKE…
  // against ADVANCE voters — the raid was the hard layer and they backed it.
  settleOpenStakes(state, targetKey(raid.targetType, raid.targetId), "ACCEPTED", notes)
  settleMarketVotes(state, targetKey("RAID", raid.id), "REJECTED", 1000n)
  notes.push(`raid ${raid.id} DISMISSED`)
}

function executeRaidAdvance(state: CoreState, raid: Raid, nowTs: string, notes: string[]) {
  let frozen = 0n
  for (const s of state.stakes[targetKey(raid.targetType, raid.targetId)] ?? []) {
    if (s.status === "OPEN" && s.side === "ATTEST") frozen += s.amountBase
  }
  raid.frozenAttestBase = frozen
  raid.status = "COALITION"
  fxStatus("screen-status", raid.id, "RAID", "COALITION")
  raid.advancedTs = nowTs
  settleMarketVotes(state, targetKey("RAID", raid.id), "ACCEPTED", 1000n)
  notes.push(`raid ${raid.id} ADVANCED (parity target ${frozen})`)
  checkParity(state, raid, nowTs, notes)
}

/** COALITION → COURT when raid coins ≥ the frozen attester pool AND ≥ K distinct raiders. */
export function checkParity(state: CoreState, raid: Raid, nowTs: string, notes: string[]) {
  if (raid.status !== "COALITION") return
  let coins = 0n
  const raiders = new Set<string>()
  for (const s of state.stakes[targetKey(raid.targetType, raid.targetId)] ?? []) {
    if (s.status === "OPEN" && s.side === "RAID") {
      coins += s.amountBase
      raiders.add(s.fp)
    }
  }
  const K = quorumMinJudges(activeJudges(state, nowTs), dialNum(state.dials, "QUORUM_FLOOR"), dialNum(state.dials, "QUORUM_CEILING"))
  if (coins >= (raid.frozenAttestBase ?? 0n) && raiders.size >= K) {
    raid.status = "COURT"
    fxStatus("screen-status", raid.id, "RAID", "COURT")
    notes.push(`raid ${raid.id} reached COURT (conviction parity, ${raiders.size} raiders)`)
  }
}

/** The court's binding verdict — only the court strikes confirmed truth (Law 24). */
export function executeRaidRuling(state: CoreState, raid: Raid, verdict: "STRUCK" | "UPHELD", atSeq: number, notes: string[]) {
  raid.status = verdict
  fxStatus("screen-status", raid.id, "RAID", verdict)
  const tkey = targetKey(raid.targetType, raid.targetId)
  if (verdict === "STRUCK") {
    strikeConfirmed(state, state.acts[raid.targetId], atSeq, "court.raid", notes)
    settleOpenStakes(state, tkey, "REJECTED", notes) // the raiders win the attester pool
    settleMarketVotes(state, targetKey("RAID", raid.id), "ACCEPTED", 1000n) // early rulings settle leftover screen votes
  } else {
    settleOpenStakes(state, tkey, "ACCEPTED", notes) // the attesters win the raid pool
    settleMarketVotes(state, targetKey("RAID", raid.id), "REJECTED", 1000n)
  }
  notes.push(`raid ${raid.id} ${verdict}`)
}

/** Coalition TTL — fires on TICK and on the contest-door join-sweep, both deterministic.
 *  Co-raiders are refunded; the attester pool stands untouched. */
export function expireStaleCoalitions(state: CoreState, nowTs: string, notes: string[], onlyTargetId?: string) {
  const ttl = dialNum(state.dials, "RAID_COALITION_TTL_MS")
  for (const id of Object.keys(state.raids).sort()) {
    const r = state.raids[id]
    if (r.status !== "COALITION" || !r.advancedTs) continue
    if (onlyTargetId && r.targetId !== onlyTargetId) continue
    if (Date.parse(nowTs) - Date.parse(r.advancedTs) < ttl) continue
    refundOpenStakes(state, targetKey(r.targetType, r.targetId), "RAID")
    r.status = "EXPIRED"
    fxStatus("screen-status", r.id, "RAID", "EXPIRED")
    notes.push(`raid ${id} EXPIRED — co-raiders refunded`)
  }
}

// ── screen.v2 — sortition + sealed votes (DORMANT until the dial turns by amendment) ─────

export function screenV2Active(state: CoreState): boolean {
  const v = dialNum(state.dials, "SCREEN_RULE_VERSION")
  if (v !== 1 && v !== 2) throw new Error(`screen rule v${v} is ratified but not implemented — refusing to fold under unknown law`)
  return v === 2
}

/** The live v2 screen behind a commit/reveal, or a refusal naming why. */
function v2Screen(state: CoreState, tt: string | null, tid: string | null):
  { screen: Challenge | Raid; v2: ScreenV2; key: string } | string {
  if (tt === "CHALLENGE") {
    const c = tid ? state.challenges[tid] : undefined
    if (!c) return "no such contest"
    if (c.status !== "PENDING") return `this contest is already resolved (${c.status})`
    if (!c.v2) return "this screen predates screen.v2 — it is judged by open VOTE_CAST"
    return { screen: c, v2: c.v2, key: targetKey("CHALLENGE", c.id) }
  }
  if (tt === "RAID") {
    const r = tid ? state.raids[tid] : undefined
    if (!r) return "no such raid"
    if (r.status !== "SCREEN") return "this raid is past the screening stage"
    if (!r.v2) return "this screen predates screen.v2 — it is judged by open VOTE_CAST"
    return { screen: r, v2: r.v2, key: targetKey("RAID", r.id) }
  }
  return "sealed votes exist only on contest screens (CHALLENGE | RAID)"
}

export const commitHashOf = (vote: string, stakeMilli: string, salt: string): string =>
  sha256(`${vote}|${stakeMilli}|${salt}`)

export function validateCommit(state: CoreState, e: Pick<EventEnvelope, "actor" | "payload">): string | null {
  const p = e.payload
  const found = v2Screen(state, str(p, "targetType"), str(p, "targetId"))
  if (typeof found === "string") return found
  const { v2 } = found
  if (v2.phase !== "COMMIT") return `the screen is in its ${v2.phase} phase — commits land only in COMMIT`
  if (!v2.juryFps?.includes(e.actor)) return "you are not on this screen's jury (the draw is on the record)"
  if (v2.commits?.[e.actor]) return "sealed means one shot — your commit stands until reveal"
  const h = str(p, "commitHash")
  if (!h || !/^[0-9a-f]{64}$/.test(h)) return "commitHash must be sha256 hex of `vote|stakeMilli|salt`"
  return null
}

export function applyCommit(state: CoreState, e: EventEnvelope, notes: string[]) {
  const p = e.payload
  const found = v2Screen(state, str(p, "targetType"), str(p, "targetId")) as { screen: Challenge | Raid; v2: ScreenV2; key: string }
  const { v2 } = found
  ;(v2.commits ??= {})[e.actor] = p.commitHash as string
  notes.push(`sealed commit ${Object.keys(v2.commits).length}/${v2.juryFps!.length}`)
  if (Object.keys(v2.commits).length === v2.juryFps!.length) {
    v2.phase = "REVEAL"
    v2.phaseTs = e.ts
    notes.push("all jurors committed — the reveal opens")
  }
}

export function validateReveal(state: CoreState, e: Pick<EventEnvelope, "actor" | "payload">): string | null {
  const p = e.payload
  const found = v2Screen(state, str(p, "targetType"), str(p, "targetId"))
  if (typeof found === "string") return found
  const { v2, key } = found
  if (v2.phase !== "REVEAL") return `the screen is in its ${v2.phase} phase — reveals land only in REVEAL`
  const commit = v2.commits?.[e.actor]
  if (!commit) return "no commit of yours to reveal"
  if (state.votes[key]?.[e.actor]) return "already revealed"
  const vote = str(p, "vote")
  const stake = str(p, "stakeMilli")
  const salt = str(p, "salt")
  if ((vote !== "ADVANCE" && vote !== "STRIKE") || !stake || !/^[0-9]+$/.test(stake) || !salt) return "vote, stakeMilli, salt required"
  if (commitHashOf(vote, stake, salt) !== commit) return "reveal does not match your sealed commit — the hash is the vow"
  const judge = state.actors[e.actor]
  // Law 31b-i: the human juror's floor is its own dial (0 in force — the voice needs no purse)
  const floorMilli = judge.entityType === "user"
    ? dialBig(state.dials, "SCREEN_HUMAN_STAKE_MIN_MILLI")
    : dialBig(state.dials, "MIN_JUDGE_STAKE_MILLI")
  if (BigInt(stake) < floorMilli) return "stake below the judging floor"
  if (BigInt(stake) > 0n && judge.openStakeMilli + BigInt(stake) > judge.repMilli) return "insufficient uncommitted reputation at reveal"
  return null
}

export function applyReveal(state: CoreState, e: EventEnvelope, notes: string[]) {
  const p = e.payload
  const tt = str(p, "targetType")!
  const tid = str(p, "targetId")!
  const key = targetKey(tt, tid)
  const judge = state.actors[e.actor]
  const stake = BigInt(p.stakeMilli as string)
  ;(state.votes[key] ??= {})[e.actor] = { dir: p.vote as "ADVANCE" | "STRIKE", stakeMilli: stake, ts: e.ts }
  judge.openStakeMilli += stake
  judge.lastVoteTs = e.ts
  notes.push(`revealed ${p.vote}`)
  // the crossing evaluates on each reveal — same D1 trigger discipline as open screens
  if (tt === "CHALLENGE") evaluateChallengeScreen(state, state.challenges[tid], e, notes)
  else evaluateRaidScreen(state, state.raids[tid], e, notes)
}

/** The clock's duties for sealed screens, folded on TICK: draw juries (fresh entropy no
 *  filer can grind), close commit windows (alternates if the panel went quiet), close
 *  reveal windows (evaluate what stands, or park for the court — Law 24's backstop). */
export function sweepScreensV2(state: CoreState, tick: EventEnvelope, notes: string[]) {
  const screens: { screen: Challenge | Raid; v2: ScreenV2; tt: string; id: string }[] = []
  for (const id of Object.keys(state.challenges).sort()) {
    const c = state.challenges[id]
    if (c.status === "PENDING" && c.v2) screens.push({ screen: c, v2: c.v2, tt: "CHALLENGE", id })
  }
  for (const id of Object.keys(state.raids).sort()) {
    const r = state.raids[id]
    if (r.status === "SCREEN" && r.v2) screens.push({ screen: r, v2: r.v2, tt: "RAID", id })
  }
  for (const { screen, v2, tt, id } of screens) {
    const elapsed = Date.parse(tick.ts) - Date.parse(v2.phaseTs)
    if (v2.phase === "JURY") {
      const exclude = tt === "CHALLENGE" ? [(screen as Challenge).authorFp] : [(screen as Raid).openedByFp]
      const pool = eligibleJurors(state, screen, exclude)
      if (!pool.humans.length && !pool.agents.length) {
        v2.phase = "PARKED"
        v2.phaseTs = tick.ts
        notes.push(`screen ${id}: no eligible jurors — parked for the court`)
        continue
      }
      const seed = drawSeed(tick.hash, id)
      v2.jurySeed = seed
      v2.juryFps = drawJury(seed, pool, jurySize(state), dialNum(state.dials, "JURY_MIN_HUMANS"))
      v2.commits = {}
      v2.altRounds = 0
      v2.phase = "COMMIT"
      v2.phaseTs = tick.ts
      notes.push(`jury drawn for ${id}: ${v2.juryFps.length} seats (seed from the clock, not the filer)`)
    } else if (v2.phase === "COMMIT" && elapsed >= dialNum(state.dials, "COMMIT_WINDOW_MS")) {
      const committed = Object.keys(v2.commits ?? {}).length
      const bar = quorumMinJudges(activeJudges(state, tick.ts), dialNum(state.dials, "QUORUM_FLOOR"), dialNum(state.dials, "QUORUM_CEILING"))
      if (committed < bar && (v2.altRounds ?? 0) < dialNum(state.dials, "JURY_ALTERNATE_ROUNDS")) {
        const exclude = [...(v2.juryFps ?? []), ...(tt === "CHALLENGE" ? [(screen as Challenge).authorFp] : [(screen as Raid).openedByFp])]
        const pool = eligibleJurors(state, screen, exclude)
        const round = (v2.altRounds ?? 0) + 1
        const alternates = drawJury(nextSeed(v2.jurySeed!, round), pool, bar - committed + dialNum(state.dials, "JURY_EXTRA"), dialNum(state.dials, "JURY_MIN_HUMANS"))
        v2.juryFps = [...(v2.juryFps ?? []), ...alternates].sort()
        v2.altRounds = round
        v2.phaseTs = tick.ts // the window restarts for the widened panel
        notes.push(`screen ${id}: panel quiet — ${alternates.length} alternates drawn (round ${round})`)
      } else {
        v2.phase = "REVEAL"
        v2.phaseTs = tick.ts
        notes.push(`screen ${id}: commit window closed (${committed} sealed) — the reveal opens`)
      }
    } else if (v2.phase === "REVEAL" && elapsed >= dialNum(state.dials, "REVEAL_WINDOW_MS")) {
      // final evaluation with what stands; a screen that cannot conclude goes to the court
      if (tt === "CHALLENGE") evaluateChallengeScreen(state, screen as Challenge, tick, notes)
      else evaluateRaidScreen(state, screen as Raid, tick, notes)
      const still = tt === "CHALLENGE" ? (screen as Challenge).status === "PENDING" : (screen as Raid).status === "SCREEN"
      if (still && v2.phase === "REVEAL") {
        v2.phase = "PARKED"
        v2.phaseTs = tick.ts
        notes.push(`screen ${id}: reveal window closed without a verdict — parked for the court (Law 24)`)
      }
    }
  }
}
