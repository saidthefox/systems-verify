import type { ActKind, ActState, CoreState, EventEnvelope, Outcome } from "./types"
import { EDGE_TYPES, RAID_LIVE, claimName, isDead, nameHolders, releaseName, targetKey } from "./types"
import { hashOf, norm, nameShapeError } from "./canonical"
import { LIMITS, firstTooLong } from "./limits"
import { GENESIS_DIALS, dialBig, dialBool, dialNum } from "./dials"
import { activeJudges, medianActiveRepMilli, quorumCrossing, quorumMinJudges } from "./math"
import { beginFx, cascadeEntry, fxStatus, refundMarketVotes, refundOpenStakes, ruleProvisionalAct, takeFx } from "./effects"
import { instanceAdjacency, ladderVia } from "./graph"
import {
  applyCommit, applyContest, applyReveal, evaluateChallengeScreen, evaluateRaidScreen,
  executeChallengeRuling, executeRaidRuling, expireStaleCoalitions, replaceFeasible,
  sweepScreensV2, validateCommit, validateContest, validateReveal, validateScreenVote,
} from "./ladder"

/**
 * The reducer — apply(state, event) → outcome. THE one place the rules live (DECOSTUME).
 *
 * Determinism contract: no I/O, no env, no wall clock, no randomness, no float in any
 * consensus decision. Iteration orders are sorted where they touch balances. Rulings are
 * DERIVED in the fold of the triggering VOTE_CAST (EVENTS.md D1) with effects applied in the
 * ruled order: ruling → author reward → vote settlement → coin settlement → cascade.
 *
 * Implemented: identity, filing (with the A7, Law 12 and Law 11e doors), judging, quorum.v1,
 * court rulings, attestation + holdback release, cascade, the full contest ladder including
 * mode REPLACE succession, coherence flags with the false-flag cost, Law 39 declared
 * collisions (D4), nudges, the gallery, the forge — and the governance layer: seq-scheduled
 * AMENDMENT_RATIFIED (rules change at their activation seq, never in place), LAW_ANCHORED,
 * KEY_EVENT rotation, and COMPENSATION (the A8 mirror: reflects a recorded burn, once).
 * Every EVENTS.md kind now folds. The remaining unknowns are versions, not kinds: a ratified
 * rule version this reducer does not implement halts the fold loudly rather than guessing.
 */

const LIVE = "PROVISIONAL"
// norm comes from canonical.ts — Law 12 as revised by 12-ii; one normalizer, everywhere.

// ── payload readers (payloads carry amounts as decimal strings) ─────────────

const str = (p: Record<string, unknown>, k: string): string | null =>
  typeof p[k] === "string" && (p[k] as string).length > 0 ? (p[k] as string) : null

const amt = (p: Record<string, unknown>, k: string): bigint | null => {
  const v = p[k]
  if (typeof v !== "string" || !/^[0-9]+$/.test(v)) return null
  return BigInt(v)
}

// ── genesis ─────────────────────────────────────────────────────────────────

export function initState(genesis: EventEnvelope, snapshot?: CoreState): CoreState {
  if (genesis.kind !== "GENESIS") throw new Error("log must begin with GENESIS")
  const p = genesis.payload

  // The snapshot seam (DECOSTUME Phase 3): a GENESIS that commits to a stateHash starts from
  // that state, not from empty — and the commitment is CHECKED, never trusted. Pre-genesis
  // history is the old system's evidence; the snapshot is where the log picks up the story.
  if (typeof p.stateHash === "string") {
    if (!snapshot) throw new Error("GENESIS commits to a state snapshot — provide genesis-state.json")
    if (hashOf(snapshot) !== p.stateHash) throw new Error("snapshot does not match the GENESIS stateHash — refusing a forged beginning")
    if (snapshot.seq !== genesis.seq) throw new Error("snapshot seq must equal the GENESIS seq")
    // Upcast AFTER the hash check (the recorded stateHash committed to the shape as cut):
    // pre-A+A snapshots carry single-holder string values; the plural law wraps them (2026-08-16).
    for (const k of Object.keys(snapshot.names)) {
      const v = snapshot.names[k] as unknown
      if (typeof v === "string") snapshot.names[k] = [v]
    }
    snapshot.ts = genesis.ts // the envelope's clock is authoritative from seq 0 forward
    // Dials the code learned AFTER this snapshot was cut take their GENESIS defaults —
    // exactly the fresh-genesis spread below; the snapshot's recorded dials always win,
    // and DIAL_SET events win further. Without this, a snapshot freezes the dial ROSTER
    // (not just the values) and every later-added dial hard-stops the fold (found live
    // on staging 2026-08-12: screen.v2's dials were unknown to the Aug-11 sidecar).
    snapshot.dials = { ...GENESIS_DIALS, ...snapshot.dials }
    snapshot.attestations ??= {} // a sidecar cut before Amendment 1 was amended carries none
    snapshot.revokedCredentials ??= {} // …and one cut before ALIAS_REVOKED (2026-08-19) carries none
    return snapshot
  }

  const keys = p.keys as { court: string; governance: string; sequencer: string }
  if (!keys?.court || !keys?.governance || !keys?.sequencer) throw new Error("GENESIS.keys incomplete")
  const state: CoreState = {
    // note the COPY on `keys` below: state must never alias the genesis payload's object —
    // a KEY_EVENT that mutated a shared reference would rewrite the recorded GENESIS in
    // memory and leak into the caller (found by the rotation tests, 2026-08-11)
    seq: genesis.seq,
    ts: genesis.ts,
    dials: { ...GENESIS_DIALS, ...((p.dials as Record<string, number | string | boolean>) ?? {}) },
    keys: { court: keys.court, governance: keys.governance, sequencer: keys.sequencer },
    actors: {},
    attestations: {},
    houses: {},
    credentialToHouse: {},
    revokedCredentials: {},
    acts: {},
    challenges: {},
    raids: {},
    amendments: {},
    pendingActivations: [],
    laws: {},
    burns: {},
    flags: {},
    nudges: {},
    gallery: {},
    ingots: {},
    names: {},
    votes: {},
    stakes: {},
    supply: { coinMintedBase: 0n, coinBurnedBase: 0n, escrowPoolBase: 0n, repMintedMilli: 0n, repBurnedMilli: 0n },
  }
  // the system keys' roster: registering court/governance/sequencer as entities is what lets
  // a stranger verify THEIR signatures too (verify.ts) — a log whose rulers are unverifiable
  // is not a record, it is a rumor
  const roster = p.systemKeys as { fingerprint: string; publicKey: string; label?: string }[] | undefined
  for (const k of roster ?? []) {
    state.actors[k.fingerprint] = {
      fp: k.fingerprint, entityType: "system", entityId: k.fingerprint, label: k.label ?? "system",
      publicKey: k.publicKey, repMilli: 0n, balanceBase: 0n, openStakeMilli: 0n, lastVoteTs: null, filing: null,
    }
  }
  return state
}

// ── validation (a rejected candidate never becomes an event) ────────────────

/** Apply every amendment whose activation seq has arrived — called before validation, so
 *  the rules a candidate is judged under are the rules in force AT its seq (D1 spec 3). */
export function activatePending(state: CoreState, uptoSeq: number, notes?: string[]) {
  while (state.pendingActivations.length && state.pendingActivations[0].seq <= uptoSeq) {
    const a = state.pendingActivations.shift()!
    for (const k of Object.keys(a.dials).sort()) state.dials[k] = a.dials[k]
    notes?.push(`amendment ${a.id} activated at seq ${a.seq}`)
  }
}

export function validate(state: CoreState, e: Pick<EventEnvelope, "kind" | "v" | "actor" | "payload" | "ts">): string | null {
  const p = e.payload

  switch (e.kind) {
    case "AMENDMENT_RATIFIED": {
      if (e.actor !== state.keys.governance) return "AMENDMENT_RATIFIED is governance's voice alone"
      const id = str(p, "id")
      const docHash = str(p, "docHash")
      const at = p.activationSeq
      if (!id || !docHash || typeof at !== "number" || !Number.isInteger(at)) return "id, docHash, integer activationSeq required"
      if (state.amendments[id]) return `amendment ${id} already ratified`
      if (at <= state.seq + 1) return "activationSeq must lie in the future — rules never change under a pending candidate's feet"
      if (p.dials !== undefined && (typeof p.dials !== "object" || Array.isArray(p.dials) || p.dials === null)) return "dials must be an object"
      return null
    }
    case "LAW_ANCHORED": {
      if (e.actor !== state.keys.court && e.actor !== state.keys.governance) return "LAW_ANCHORED requires the court or governance key"
      return str(p, "lawId") && str(p, "docHash") ? null : "lawId and docHash required"
    }
    case "ATTESTATION": {
      // Amendment 1, as amended 2026-08-18. A fact from OUTSIDE the taxonomy, anchored by the
      // system that owns it. The kingdom does NOT judge whether it is true — it binds record →
      // signer → time so that lying about it LATER is detectable, which is the entire promise.
      const who = state.actors[e.actor]
      if (!who) return "unknown attester — register a key before anchoring"
      const actId = str(p, "actId")
      const actHash = str(p, "actHash")
      if (!actId || !actHash) return "actId and actHash required"
      if (!/^[0-9a-f]{64}$/.test(actHash)) return "actHash must be a sha256 hex digest of the record"
      // Globally unique per fact — what made anchoring idempotent on the chain (one block per
      // act) does the same here, so a retry is safe and a re-anchor is a refusal, not a second
      // truth.
      if (state.attestations[actId]) return `already anchored: ${actId}`
      // The record, when carried, is the attester's EXACT bytes — a string, never a re-parsed
      // object, because two serializers disagree about whitespace and the hash names bytes.
      const rec = p.record
      if (rec !== undefined) {
        if (typeof rec !== "string") return "record must be the exact string that was hashed"
        if (rec.length > LIMITS.ATTESTATION_RECORD) {
          return `record is ${rec.length} bytes; the limit is ${LIMITS.ATTESTATION_RECORD}. Anchor its hash and serve the document, or say it shorter — a clipped record hashes to nothing.`
        }
      }
      return null
    }
    case "KEY_EVENT": {
      if (e.actor !== state.keys.governance) return "KEY_EVENT is governance's voice alone"
      const role = str(p, "role")
      const fp = str(p, "fingerprint")
      if (role !== "court" && role !== "governance" && role !== "sequencer") return "role must be court, governance or sequencer"
      if (!fp) return "fingerprint required"
      return null
    }
    case "COMPENSATION": {
      if (e.actor !== state.keys.court) return "COMPENSATION requires the court key (Amendment 8's heir)"
      const burnSeq = str(p, "burnSeq")
      if (!burnSeq || !str(p, "reason")) return "burnSeq and reason required"
      const rec = state.burns[burnSeq]
      if (!rec) return "COMPENSATION must mirror an existing burn (none recorded at that seq)"
      if (rec.compensated) return "that burn is already compensated — a mirror reflects once"
      return null
    }
    case "TICK":
      return e.actor === state.keys.sequencer ? null : "TICK is the sequencer's alone"
    case "DIAL_SET": {
      if (e.actor !== state.keys.governance && e.actor !== state.keys.court) return "DIAL_SET requires the governance or court key"
      if (!str(p, "key") || p.value === undefined) return "DIAL_SET needs key and value"
      return null
    }
    case "ALIAS_REVOKED": {
      // A house closes one of its own credentials. The HOUSE key signs: this is a household
      // deciding which keys still open its door, not an office reaching in.
      const cred = str(p, "credentialHash")
      if (!cred) return "credentialHash required"
      const houseActor = state.actors[e.actor]
      if (!houseActor || houseActor.entityType !== "house") return "a credential is revoked by its own house key"
      const claimed = state.credentialToHouse[cred]
      if (!claimed) return "no such credential — nothing to revoke"
      if (claimed !== houseActor.entityId) return "that credential backs another house"
      if (state.revokedCredentials[cred]) return "already revoked"
      // The LAST credential may not be revoked: a house with no way in is a house nobody can
      // ever re-enter, and there is no path back because the sybil map refuses a re-claim.
      const live = (state.houses[claimed]?.credentialHashes ?? []).filter(c => !state.revokedCredentials[c])
      if (live.length <= 1) return "this is the house's last credential — revoking it would lock the house permanently"
      return null
    }
    case "ENTITY_REGISTERED": {
      if (state.actors[e.actor]) return "entity already registered"
      const t = str(p, "entityType")
      if (t !== "user" && t !== "system") return "ENTITY_REGISTERED covers users/system; houses and agents arrive via their own events"
      if (!str(p, "entityId") || !str(p, "label") || !str(p, "publicKey")) return "entityId, label, publicKey required"
      // Law 38b-i — a seat names its house, as AGENT_MINTED has always done. Optional because a
      // system key belongs to no household and an unhoused user is not a seat; but a house that
      // was never founded is a claim about nothing, so it is checked when present.
      const seatHouse = str(p, "houseId")
      if (seatHouse) {
        if (t !== "user") return "only a seat names a house — a system key belongs to no household"
        if (!state.houses[seatHouse]) return "no such house"
        // Law 38b-i — a house seats ONE human. HOUSE_HUMAN_SLOTS was a dial no rule read
        // (found 2026-08-17): the cap lived only in the mint door's transaction, so the fold
        // would have taken a second seat on trust. Offices are typed `system` and never
        // counted, which is 38b-iii holding without a special case. Replay-safe: neither
        // kingdom's log carries a single identity event.
        let seats = 0
        for (const fp of Object.keys(state.actors)) {
          const a = state.actors[fp]
          if (a.entityType === "user" && a.houseId === seatHouse) seats++
        }
        if (seats >= dialNum(state.dials, "HOUSE_HUMAN_SLOTS")) return "this house is already seated — one human account per house (Law 38b-i)"
      }
      return null
    }
    case "HOUSE_FOUNDED": {
      if (state.actors[e.actor]) return "house key already registered"
      const cred = str(p, "credentialHash")
      const kind = str(p, "credentialKind")
      if (!str(p, "houseId") || !str(p, "label") || !cred || !str(p, "publicKey")) return "houseId, label, credentialHash, publicKey required"
      if (kind !== "uniqueness" && kind !== "wallet") return "only a uniqueness or wallet credential founds a house (Law 34)"
      if (state.credentialToHouse[cred]) return "this credential already backs a house — one house per human (Law 38)"
      return null
    }
    case "HOUSE_ALIAS_ADDED": {
      const houseId = str(p, "houseId")
      const cred = str(p, "credentialHash")
      if (!houseId || !cred) return "houseId and credentialHash required"
      const house = state.houses[houseId]
      if (!house) return "no such house"
      if (e.actor !== house.keyFp) return "an alias is added by the house's own key"
      // Law 38 cares that a credential backs ONE house, not that it may never be re-attached to
      // the house it already belongs to. Re-linking to the SAME house creates no second house and
      // so violates nothing — and without it a revocation is permanent, because the claim outlives
      // the revocation by design. That made ALIAS_REVOKED an amputation rather than a switch:
      // revoke a wallet by mistake and it could never come back, not even here.
      // A widening, so it refuses nothing a stricter past accepted.
      const backs = state.credentialToHouse[cred]
      if (backs && backs !== houseId) return "this credential already backs another house"
      if (backs === houseId && !state.revokedCredentials[cred]) return "this credential already opens this house"
      return null
    }
    case "AGENT_MINTED": {
      if (!dialBool(state.dials, "MINT_AGENTS_OPEN")) return "agent minting is not open (dial)"
      if (state.actors[e.actor]) return "agent key already registered"
      const houseId = str(p, "houseId")
      if (!str(p, "agentId") || !houseId || !str(p, "label") || !str(p, "publicKey")) return "agentId, houseId, label, publicKey required"
      const house = state.houses[houseId]
      if (!house) return "no such house"
      if (house.agentFps.length >= dialNum(state.dials, "HOUSE_AGENT_SLOTS")) return "the hand is full — one agent per house (Law 38)"
      return null
    }
    case "ACT_FILED":
      return validateFiling(state, e as EventEnvelope)
    case "FILING_REFUSED": {
      // Law 28 at the door (keeper's ruling 2026-08-15): a charged refusal — a duplicate, a
      // ladder leap — is HISTORY, and the fold must learn the slot was spent. The event
      // creates no act; it only burns the slot the kingdom burned.
      const author = state.actors[e.actor]
      if (!author || (author.entityType !== "agent" && author.entityType !== "user")) return "unknown author"
      if (!str(p, "actKind") || !str(p, "reason")) return "actKind and reason required"
      return null
    }
    case "VOTE_CAST":
      return validateVote(state, e as EventEnvelope)
    case "CONTEST_FILED":
      return validateContest(state, e as EventEnvelope)
    case "VOTE_COMMIT":
      return validateCommit(state, e as EventEnvelope)
    case "VOTE_REVEAL":
      return validateReveal(state, e as EventEnvelope)
    case "STAKE_PLACED": {
      const actor = state.actors[e.actor]
      if (!actor || (actor.entityType !== "agent" && actor.entityType !== "user")) return "unknown staker"
      const tt = str(p, "targetType")
      const tid = str(p, "targetId")
      const a = amt(p, "amountBase")
      if (!tt || !tid || a === null) return "targetType, targetId, amountBase required"
      if (str(p, "side") !== "ATTEST") return "RAID stakes ride CONTEST_FILED — /api/stake attests only"
      if (tt !== "ENTRY" && tt !== "DEFINITION" && tt !== "EDGE") return "attest targets entries, definitions, and edges — a name is reach, a facet is a lens (D10, 2026-08-15)"
      if (a < dialBig(state.dials, "MIN_STAKE_BASE")) return "below the floor stake"
      if (actor.balanceBase < a) return "insufficient coin balance"
      const act = state.acts[tid]
      if (!act || act.kind !== tt) return "target not found"
      if (act.status !== "ACCEPTED") return "attest and raid target CONFIRMED acts (Amendment 5)"
      return null
    }
    case "FLAG_FILED": {
      const flagger = state.actors[e.actor]
      if (!flagger || (flagger.entityType !== "agent" && flagger.entityType !== "user")) return "unknown flagger"
      const tid = str(p, "targetId")
      if (!tid || !str(p, "targetType") || !str(p, "reasoning")) return "targetType, targetId, reasoning required — a flag without a reason teaches no one"
      const act = state.acts[tid]
      if (!act || act.kind !== str(p, "targetType")) return "target not found"
      const ftt = str(p, "targetType")
      if (ftt !== "ENTRY" && ftt !== "DEFINITION" && ftt !== "EDGE") return "flags mark entries, definitions, and edges (D10; FACET deleted by the A+A ruling 2026-08-16)"
      if (act.status !== LIVE) return "coherence flags mark still-provisional acts — a ruled act is contested, not flagged"
      if (act.authorFp === e.actor) return "you cannot flag your own act (Law 15)"
      return null
    }
    case "NUDGE_PLACED": {
      // Keeper's ruling 2026-08-15: the event says only "a verified HUMAN pointed at X". The
      // actor is a pseudonymous identity hash under the `human:` namespace — the live door
      // verified the personhood (World proof / session / keeper's key) before emitting, and
      // the fold trusts that qualifier rather than demanding a registered actor. House- and
      // user-typed actors (seats nudging while signed in) remain valid nudgers too.
      const isHumanNs = e.actor.startsWith("human:")
      const human = state.actors[e.actor]
      if (!isHumanNs && (!human || (human.entityType !== "house" && human.entityType !== "user"))) return "the nudge is a HUMAN power (Law 33) — agents follow attention, they do not manufacture it"
      const tid = str(p, "targetId")
      const ntt = str(p, "targetType")
      if (ntt !== "ENTRY" && ntt !== "EDGE" && ntt !== "DEFINITION") return "a nudge points at an entry, an edge, or a definition (D10)"
      const act = tid ? state.acts[tid] : null
      if (!act || act.kind !== ntt) return "target not found"
      let held = 0
      for (const id of Object.keys(state.nudges)) {
        const n = state.nudges[id]
        if (n.identityFp !== e.actor || n.status !== "ACTIVE") continue
        if (n.targetId === tid) return "you are already pointing at this (one nudge per target, D6)"
        held++
      }
      if (held >= dialNum(state.dials, "HAND_SIZE")) return `your hand is empty — ${held} nudges out; one returns when its target moves or goes stale (Law 33)`
      return null
    }
    case "GALLERY_VERDICT": {
      // Who may SEAL a verdict. The bar this has always drawn is "not an agent" — the staked
      // market is where a machine's opinion costs it something. A seated human's own house seals
      // for them; an UNSEATED visitor (a World ID proof with no house — most of the gallery's
      // audience) is sealed for by governance, because the honest signer of "someone whose
      // identity hashes to X said this" is the kingdom, not a household that never met them.
      // Widening, never narrowing: no event that was lawful before becomes unlawful here.
      const human = state.actors[e.actor]
      const isOffice = e.actor === state.keys.governance
      if (!isOffice && (!human || (human.entityType !== "house" && human.entityType !== "user"))) {
        return "the gallery is where humans watch — an agent's verdict belongs in the staked market"
      }
      const tid = str(p, "targetId")
      const verdict = str(p, "verdict")
      const act = tid ? state.acts[tid] : null
      if (!act) return "target not found"
      if (act.status !== LIVE) return "the act is ruled — the gallery closes with the market"
      if (verdict !== "ADVANCE" && verdict !== "STRIKE") return "verdict must be ADVANCE or STRIKE"
      // The human is PSEUDONYMOUS here on purpose: the house signs, and the person is carried
      // only as a hash (EVENTS.md D3). A raw World ID nullifier in an append-only log that is
      // headed for publication is unretractable, so the log never learns one. Required rather
      // than optional because a verdict with no identity cannot be deduplicated or changed by
      // the person who cast it — the whole point of "one verdict per human, changeable".
      if (!str(p, "identityHash")) return "identityHash required — the gallery records a hash, never a person"
      return null
    }
    case "SMELT": {
      if (!dialBool(state.dials, "FORGE_OPEN")) return "the forge is not open (dial) — Law 35 stays dark until a production sitting"
      const houseActor = state.actors[e.actor]
      if (!houseActor || houseActor.entityType !== "house") return "the forge smelts only for housed humans — the house key signs the cast"
      const entityFp = str(p, "entityFp")
      const whole = amt(p, "coinsWhole")
      if (!entityFp || whole === null) return "entityFp and coinsWhole required"
      if (whole < dialBig(state.dials, "SMELT_MIN_WHOLE")) return "smelt needs a whole number of coins ≥ 2 — one in ten, minimum one, is dross (Law 35c)"
      const house = state.houses[houseActor.entityId]
      if (!house || !house.agentFps.includes(entityFp)) return "entity not found in your house"
      if (state.actors[entityFp].balanceBase < whole * 100_000_000n) return "insufficient coin balance to cast"
      return null
    }
    case "COURT_RULING": {
      if (e.actor !== state.keys.court) return "COURT_RULING requires the court key (D9)"
      const tid = str(p, "targetId")
      const ruling = str(p, "ruling")
      const tt = str(p, "targetType")
      if (!tid || !ruling) return "targetId and ruling required"
      if (tt === "CHALLENGE") {
        const c = state.challenges[tid]
        if (!c) return "no such contest"
        if (c.status !== "PENDING") return `already resolved: ${c.status}`
        if (ruling !== "ACCEPTED" && ruling !== "REJECTED") return "challenge ruling must be ACCEPTED (upheld) or REJECTED (dismissed)"
        if (ruling === "ACCEPTED" && c.mode === "REPLACE") {
          const blocked = replaceFeasible(state, c)
          if (blocked) return `successor cannot materialize: ${blocked}`
        }
        return null
      }
      if (tt === "RAID") {
        const r = state.raids[tid]
        if (!r) return "no such raid"
        if (!RAID_LIVE.includes(r.status)) return `raid already finished: ${r.status}`
        return ruling === "STRUCK" || ruling === "UPHELD" ? null : "raid verdict must be STRUCK or UPHELD (Law 24)"
      }
      const act = state.acts[tid]
      if (!act) return "target not found"
      // The named type must be the act's own kind, as NUDGE_PLACED and FLAG_FILED already
      // require. Verified replay-safe 2026-08-17: no COURT_RULING in either kingdom's log
      // names a type its target does not have, so tightening here refuses nothing history did.
      if (tt && act.kind !== tt) return "target not found"
      if (act.kind === "LABEL") return "the court does not rule names directly — labels are the quorum's to judge (P2 mirror, 2026-08-15)"
      if (act.status !== LIVE) return `already ruled: ${act.status}`
      return ruling === "ACCEPTED" || ruling === "REJECTED" ? null : "ruling must be ACCEPTED or REJECTED"
    }
    case "GENESIS":
      return "GENESIS appears once, at seq 0"
    default:
      return `unknown event kind: ${e.kind}`
  }
}

function validateFiling(state: CoreState, e: EventEnvelope): string | null {
  const p = e.payload
  const author = state.actors[e.actor]
  if (!author || (author.entityType !== "agent" && author.entityType !== "user")) return "unknown author"
  const kind = str(p, "actKind") as ActKind | null
  const actId = str(p, "actId")
  if (!kind || !actId || !str(p, "contentHash")) return "actKind, actId, contentHash required"
  if (state.acts[actId]) return "actId already filed"

  // A7 filing gate — both doors (slots + in-flight cap), READ-ONLY here: validation never
  // mutates; the slot is consumed in apply. Gated on carrying a budget rather than on being an
  // agent: a seat files under the same cadence (keeper's ruling 2026-08-13). An actor with no
  // filing record — a system key, or a human imported from a snapshot cut before budgets were
  // carried — is not gated, which keeps the reducer from inventing a refusal the kingdom never made.
  if (author.filing && dialBool(state.dials, "A7_ACTIVE")) {
    const regen = dialNum(state.dials, "FILING_REGEN_MS")
    const cap = dialNum(state.dials, "FILING_CAP")
    const regened = Math.floor((Date.parse(e.ts) - Date.parse(author.filing.atTs)) / regen)
    const slots = Math.min(cap, author.filing.slots + regened)
    if (slots < 1) return "no filing slots — they regenerate on a fixed cadence (A7 7C)"
    let inflight = 0
    for (const id of Object.keys(state.acts)) {
      const a = state.acts[id]
      if (a.authorFp !== e.actor || a.status !== LIVE) continue
      // Mirror live's countInflightActs (reputation.ts) EXACTLY. The cap counts entries,
      // edges, and definitions only — a name is reach, never a held claim — and a pending
      // DEFINITION stops counting once its entry is ACCEPTED (keeper's ruling 2026-07-15).
      if (a.kind !== "ENTRY" && a.kind !== "EDGE" && a.kind !== "DEFINITION") continue
      if (a.kind === "DEFINITION" && a.entryId && state.acts[a.entryId]?.status === "ACCEPTED") continue
      inflight++
    }
    if (inflight >= dialNum(state.dials, "INFLIGHT_CAP")) return "in-flight cap reached — judge instead (A7 7C.2)"
  }

  if (kind === "ENTRY") {
    const name = str(p, "name")
    if (!name || !str(p, "scope")) return "ENTRY needs name and scope"
    const shape = nameShapeError(name)
    if (shape) return shape
    const big = firstTooLong([["scopeJustification", p.scope, LIMITS.SCOPE]])
    if (big) return big
    // Law 3b — the referent question. Absent means THING (the default, and every pre-3b event).
    const referent = str(p, "referent")
    if (referent !== null && referent !== "THING" && referent !== "CONCEPT" && referent !== "WORD") {
      return "referent must be THING, CONCEPT, or WORD (Law 3b)"
    }
    if (nameHolders(state.names, norm(name)).length) {
      // Law 39 / 13-i — a held word may be claimed, but only OPENLY: the sense declares the
      // collision at the door, and the NAME_COLLISION_WITH edge derives alongside (D4).
      if (!str(p, "sense")) return `name already held (Law 12/39): ${name} — pass a sense to claim it openly (the description that tells the two apart)`
    }
    return null
  }
  if (kind === "DEFINITION") {
    const entryId = str(p, "entryId")
    if (!entryId || !str(p, "body")) return "DEFINITION needs entryId and body"
    const big = firstTooLong([["body", p.body, LIMITS.DEFINITION_BODY]])
    if (big) return big
    const entry = state.acts[entryId]
    if (!entry || entry.kind !== "ENTRY" || isDead(entry.status)) return "definition's entry does not stand"
    // The door hashed a version; it must be the one the fold assigns, or the hash describes an
    // act nobody filed. Absent on every event cut before 2026-08-17, which is why it is checked
    // only when carried — history folds exactly as it always did.
    if (p.version !== undefined) {
      const mine = nextDefinitionVersion(state, entryId)
      if (p.version !== mine) return `version ${String(p.version)} is stale — this entry's next definition is version ${mine}; re-file`
    }
    return null
  }
  if (kind === "EDGE") {
    const from = str(p, "fromEntryId")
    const to = str(p, "toEntryId")
    const edgeType = str(p, "edgeType")
    if (!from || !to || !edgeType || !str(p, "note")) return "EDGE needs fromEntryId, toEntryId, edgeType, note"
    const big = firstTooLong([["note", p.note, LIMITS.EDGE_NOTE]])
    if (big) return big
    if (!EDGE_TYPES.has(edgeType)) return `edgeType must be one of: ${[...EDGE_TYPES].join(", ")}`
    if (from === to) return "an edge cannot be a self-loop"
    for (const id of [from, to]) {
      const a = state.acts[id]
      if (!a || a.kind !== "ENTRY" || isDead(a.status)) return "edge endpoints must be live entries"
    }
    for (const id of Object.keys(state.acts)) {
      const a = state.acts[id]
      if (a.kind === "EDGE" && !isDead(a.status) && a.fromEntryId === from && a.toEntryId === to && a.edgeType === edgeType) {
        return "this edge already exists"
      }
    }
    // Law 11e-1, the DOOR: an INSTANCE_OF leap already derivable through the accepted ladder
    // is refused with the rung named.
    if (edgeType === "INSTANCE_OF") {
      const via = ladderVia(instanceAdjacency(state), from, to)
      if (via) return `leap already derivable through the ladder — the rung is ${via} (Law 11e)`
    }
    return null
  }
  if (kind === "LABEL") {
    const entryId = str(p, "entryId")
    const text = str(p, "text")
    if (!entryId || !text) return "LABEL needs entryId and text"
    const shape = nameShapeError(text)
    if (shape) return shape
    const entry = state.acts[entryId]
    if (!entry || entry.kind !== "ENTRY" || isDead(entry.status)) return "label's entry does not stand"
    // The same concept may not hold (or be pursuing) the word twice — mirror live's any-status-
    // except-REJECTED same-entry rule, which state.names alone cannot see for pending aliases
    // (the D9 window, closed 2026-08-15).
    const tnorm = norm(text)
    for (const id of Object.keys(state.acts)) {
      const a = state.acts[id]
      // any status except REJECTED blocks — live's exact set (audit D13, 2026-08-16): a
      // SUPERSEDED label still marks the claim as spent there, so it must here too.
      if (a.kind === "LABEL" && a.entryId === entryId && a.nameNorm === tnorm && a.status !== "REJECTED") {
        return "this concept already holds (or is pursuing) that word"
      }
    }
    const holderEntryOf = (h: string) => { const a = state.acts[h]; return a.kind === "ENTRY" ? a.id : a.entryId! }
    const holders = nameHolders(state.names, norm(text))
    // its own canonical word is not re-claimable — live sees this via the canonical LABEL row;
    // the core sees it via the entry's own hold (the acts-scan above covers only LABEL acts)
    if (holders.some(h => holderEntryOf(h) === entryId)) return "this concept already holds that word"
    const others = holders.filter(h => holderEntryOf(h) !== entryId)
    if (others.length) {
      // Law 39 / D4 — a held word may be claimed, but only OPENLY: the sense declares the
      // collision, and the NAME_COLLISION_WITH edge derives alongside for the judges.
      if (!str(p, "sense")) return `word already held (Law 39): ${text} — pass a sense to claim it openly (the description that tells the two apart)`
    }
    return null
  }
  if (kind === "FACET") return "FACET filing is retired — a facet is a word's sense-binding (Law 39a), never filed; classify with a typed edge (Laws 7–11c)"
  return `unknown actKind: ${kind}`
}

function validateVote(state: CoreState, e: EventEnvelope): string | null {
  const p = e.payload
  const judge = state.actors[e.actor]
  if (!judge || (judge.entityType !== "agent" && judge.entityType !== "user")) return "unknown judge"
  const tt = str(p, "targetType")
  const tid = str(p, "targetId")
  const dir = str(p, "vote")
  const stake = amt(p, "stakeMilli")
  if (!tt || !tid || (dir !== "ADVANCE" && dir !== "STRIKE") || stake === null) return "targetType, targetId, vote, stakeMilli required"
  const bigVote = firstTooLong([["reasoning", str(p, "reasoning") ?? "", LIMITS.REASONING]])
  if (bigVote) return bigVote
  // Law 38b-i (anchored block 21945; entered the core 2026-08-15 — the D1 finding): a contest
  // screen is sealed by a SEAT — a human housed under a proof of personhood. An unhoused user
  // may judge acts but holds no voice on a screen; live has refused them at the door since 38b,
  // and the fold must not grant what the kingdom denies.
  if (judge.entityType === "user" && (tt === "CHALLENGE" || tt === "RAID") && !judge.houseId) {
    return "a contest screen is sealed by a seated human (Law 38b-i) — your house has not seated you"
  }
  // Law 31b-i: on a contest screen, a human's floor is its own dial (0 in force — direction,
  // not weight; the market's verdict computes from the agents' stakes alone)
  const humanScreenVote = judge.entityType === "user" && (tt === "CHALLENGE" || tt === "RAID")
  const floorMilli = humanScreenVote
    ? dialBig(state.dials, "SCREEN_HUMAN_STAKE_MIN_MILLI")
    : dialBig(state.dials, "MIN_JUDGE_STAKE_MILLI")
  if (stake < floorMilli) return "stake below the judging floor"
  // ...and once that floor is lit to zero the vote is not merely permitted to be weightless, it
  // IS weightless — exactly zero, never more (keeper's ruling 2026-08-12). A staked human vote
  // would take supermajority weight and mint the concurrence bonus, and human dissent refunds the
  // screen, so staking could not lose. Seq-scheduled like every rule change: before the DIAL_SET
  // lit it the dormant floor stands and this clause does not bind the history folded under it.
  if (humanScreenVote && floorMilli === 0n && stake !== 0n) {
    return "a human's screen vote is direction, not weight — it stakes exactly zero (Law 31b-i)"
  }

  if (tt === "CHALLENGE" || tt === "RAID") {
    const screenErr = validateScreenVote(state, e.actor, tt, tid)
    if (screenErr) return screenErr
  } else {
    const act = state.acts[tid]
    if (!act || act.kind !== tt) return "target not found"
    if (act.status !== LIVE) return "already ruled — nothing left to judge"
    if (act.authorFp === e.actor) return "you cannot judge your own act (Law 15)"
  }
  const existing = state.votes[targetKey(tt, tid)]?.[e.actor]
  const netCommitted = judge.openStakeMilli - (existing ? existing.stakeMilli : 0n)
  // a zero-stake vote commits nothing, so even negative standing casts it (Law 31b-i)
  if (stake > 0n && netCommitted + stake > judge.repMilli) return "insufficient uncommitted reputation"
  return null
}

// ── apply ───────────────────────────────────────────────────────────────────

export function applyEvent(state: CoreState, e: EventEnvelope): Outcome {
  const notes: string[] = []
  beginFx() // the effects trace opens with the event and rides out on the Outcome
  activatePending(state, e.seq, notes) // rules in force AT this seq, before anything is judged
  const err = e.kind === "GENESIS" ? null : validate(state, e)
  if (err) throw new Error(`invalid event in log at seq ${e.seq}: ${err}`)
  const p = e.payload

  switch (e.kind) {
    case "AMENDMENT_RATIFIED": {
      const id = str(p, "id")!
      state.amendments[id] = { docHash: str(p, "docHash")!, activationSeq: p.activationSeq as number, ratifiedSeq: e.seq }
      state.pendingActivations.push({ seq: p.activationSeq as number, id, dials: (p.dials as Record<string, number | string | boolean>) ?? {} })
      state.pendingActivations.sort((a, b) => a.seq - b.seq)
      notes.push(`amendment ${id} ratified — activates at seq ${p.activationSeq}`)
      break
    }
    case "LAW_ANCHORED": {
      const lawId = str(p, "lawId")!
      ;(state.laws[lawId] ??= []).push({ docHash: str(p, "docHash")!, atSeq: e.seq })
      notes.push(`law ${lawId} anchored`)
      break
    }
    case "ATTESTATION": {
      const actId = str(p, "actId")!
      state.attestations[actId] = {
        fp: e.actor, actHash: str(p, "actHash")!, atSeq: e.seq, inline: p.record !== undefined,
      }
      notes.push(`attested ${actId} (${p.record !== undefined ? "record carried" : "hash only"})`)
      break
    }
    case "KEY_EVENT": {
      const role = str(p, "role") as "court" | "governance" | "sequencer"
      state.keys[role] = str(p, "fingerprint")!
      notes.push(`${role} key rotated`)
      break
    }
    case "COMPENSATION": {
      const rec = state.burns[str(p, "burnSeq")!]
      state.actors[rec.fp].balanceBase += rec.amountBase
      state.supply.coinMintedBase += rec.amountBase // a REFUND mints exactly what its burn destroyed
      rec.compensated = true
      notes.push(`compensated ${rec.amountBase} base to ${rec.fp} (mirror of seq ${str(p, "burnSeq")})`)
      break
    }
    case "TICK":
      expireStaleCoalitions(state, e.ts, notes) // TTLs fold on the clock event, deterministically
      sweepNudges(state, e.ts, notes)
      sweepScreensV2(state, e, notes) // sealed screens: draws, window closes, parking (no-op under v1)
      break
    case "ALIAS_REVOKED": {
      const cred = str(p, "credentialHash")!
      // credentialToHouse is deliberately NOT touched: the claim stands forever so the same
      // human can never found a second house on it. Only the ability to sign in ends here.
      state.revokedCredentials[cred] = { houseId: state.credentialToHouse[cred], atSeq: e.seq }
      notes.push(`credential revoked — access closed, the Law 38 claim stands`)
      break
    }
    case "DIAL_SET":
      state.dials[str(p, "key")!] = p.value as number | string | boolean
      notes.push(`dial ${str(p, "key")}`)
      break
    case "ENTITY_REGISTERED": {
      addActor(state, e.actor, str(p, "entityType") as "user" | "system", str(p, "entityId")!, str(p, "label")!, str(p, "publicKey")!, e.ts)
      const seatHouse = str(p, "houseId")
      if (seatHouse) state.actors[e.actor].houseId = seatHouse // Law 38b-i: the seat's house
      break
    }
    case "HOUSE_FOUNDED": {
      const houseId = str(p, "houseId")!
      addActor(state, e.actor, "house", houseId, str(p, "label")!, str(p, "publicKey")!, e.ts)
      state.houses[houseId] = { id: houseId, label: str(p, "label")!, keyFp: e.actor, agentFps: [], credentialHashes: [str(p, "credentialHash")!] }
      state.credentialToHouse[str(p, "credentialHash")!] = houseId
      break
    }
    case "HOUSE_ALIAS_ADDED": {
      const house = state.houses[str(p, "houseId")!]
      const cred = str(p, "credentialHash")!
      // A re-link is the same credential returning, not a new one arriving: list it once.
      if (!house.credentialHashes.includes(cred)) house.credentialHashes.push(cred)
      state.credentialToHouse[cred] = house.id
      if (state.revokedCredentials[cred]) {
        delete state.revokedCredentials[cred] // the door opens again; the claim never moved
        notes.push("credential restored — a revocation is a switch, not an amputation")
      }
      break
    }
    case "AGENT_MINTED": {
      const house = state.houses[str(p, "houseId")!]
      addActor(state, e.actor, "agent", str(p, "agentId")!, str(p, "label")!, str(p, "publicKey")!, e.ts)
      house.agentFps.push(e.actor)
      break
    }
    case "ACT_FILED":
      applyFiling(state, e, notes)
      break
    case "FILING_REFUSED":
      applyFilingRefused(state, e, notes)
      break
    case "VOTE_CAST":
      applyVote(state, e, notes)
      break
    case "CONTEST_FILED":
      applyContest(state, e, notes)
      break
    case "VOTE_COMMIT":
      applyCommit(state, e, notes)
      break
    case "VOTE_REVEAL":
      applyReveal(state, e, notes)
      break
    case "STAKE_PLACED":
      applyStake(state, e, notes)
      break
    case "FLAG_FILED":
      applyFlag(state, e, notes)
      break
    case "NUDGE_PLACED": {
      const tid = str(p, "targetId")!
      const act = state.acts[tid]
      const id = `nudge:${e.seq}`
      state.nudges[id] = {
        id, targetType: act.kind, targetId: tid, identityFp: e.actor,
        snapshot: actSnapshot(state, act), placedTs: e.ts, status: "ACTIVE",
      }
      notes.push(`nudge placed on ${act.kind} ${tid} (Law 33 — attention, never a verdict)`)
      break
    }
    case "GALLERY_VERDICT": {
      const tid = str(p, "targetId")!
      // keyed by the HUMAN (as a hash), not by the signing house — one house may seal for many
      // visitors, and keying by e.actor would let the second overwrite the first
      ;(state.gallery[tid] ??= {})[str(p, "identityHash")!] = str(p, "verdict") as "ADVANCE" | "STRIKE"
      notes.push("gallery verdict recorded — and inert, by design")
      break
    }
    case "SMELT": {
      const entityFp = str(p, "entityFp")!
      const whole = BigInt(p.coinsWhole as string)
      const dross = whole / 10n > 1n ? whole / 10n : 1n // one in ten, minimum one (Law 35c)
      const COIN = 100_000_000n
      state.actors[entityFp].balanceBase -= whole * COIN
      state.supply.coinBurnedBase += whole * COIN // the export is a burn; the ERC-721 lives elsewhere
      const houseId = state.actors[e.actor].entityId
      const id = `ingot:${e.seq}`
      state.ingots[id] = { id, houseId, entityFp, yieldWhole: Number(whole - dross), drossWhole: Number(dross), ts: e.ts }
      state.burns[String(e.seq)] = { fp: entityFp, amountBase: whole * COIN, compensated: false } // mirrorable (A8)
      notes.push(`ingot cast: ${whole - dross} yield, ${dross} dross burned to no one`)
      break
    }
    case "COURT_RULING": {
      const tt = str(p, "targetType")
      const tid = str(p, "targetId")!
      const ruling = str(p, "ruling")!
      if (tt === "CHALLENGE") executeChallengeRuling(state, state.challenges[tid], ruling as "ACCEPTED" | "REJECTED", "court", e.seq, notes)
      else if (tt === "RAID") executeRaidRuling(state, state.raids[tid], ruling as "STRUCK" | "UPHELD", e.seq, notes)
      else ruleProvisionalAct(state, state.acts[tid], ruling as "ACCEPTED" | "REJECTED", "court", e.seq, notes)
      break
    }
  }

  state.seq = e.seq
  state.ts = e.ts
  return { accepted: true, notes, fx: takeFx() }
}

function addActor(state: CoreState, fp: string, entityType: "house" | "agent" | "user" | "system", entityId: string, label: string, publicKey: string, ts: string) {
  state.actors[fp] = {
    fp, entityType, entityId, label, publicKey,
    repMilli: 0n, balanceBase: 0n, openStakeMilli: 0n, lastVoteTs: null,
    // A7 7C — every filer carries a budget, human or agent (keeper's ruling 2026-08-13: a seat
    // files under the same cadence as an agent). It starts FULL because that is where the kingdom
    // starts it: neither mint route sets the column, so both take the schema default of one cap.
    // The reducer used to open agents at zero and hand humans nothing at all, which made it
    // STRICTER than the law in force — and a reducer stricter than the law refuses acts the
    // kingdom accepted, orphaning them in the shadow along with every vote and stake that follows.
    filing: entityType === "agent" || entityType === "user"
      ? { slots: dialNum(state.dials, "FILING_CAP"), atTs: ts }
      : null,
  }
}

/** Consume one filing slot with the whole-cadence regen clock (A7 7C) — shared by accepted
 *  filings and charged refusals (Law 28 via FILING_REFUSED, 2026-08-15). Clamped at zero:
 *  the event records what the kingdom charged, and the kingdom never charges below empty. */
function consumeFilingSlot(state: CoreState, authorFp: string, ts: string) {
  const author = state.actors[authorFp]
  if (!author?.filing || !dialBool(state.dials, "A7_ACTIVE")) return
  const regen = dialNum(state.dials, "FILING_REGEN_MS")
  const cap = dialNum(state.dials, "FILING_CAP")
  const regened = Math.floor((Date.parse(ts) - Date.parse(author.filing.atTs)) / regen)
  const slots = Math.min(cap, author.filing.slots + regened)
  author.filing = {
    slots: Math.max(0, slots - 1),
    atTs: new Date(Date.parse(author.filing.atTs) + regened * regen).toISOString(),
  }
}

function applyFilingRefused(state: CoreState, e: EventEnvelope, notes: string[]) {
  consumeFilingSlot(state, e.actor, e.ts)
  notes.push(`filing refused, slot charged (Law 28): ${str(e.payload, "reason")}`)
}

/**
 * A definition's version, derived from the fold (Law: an act's hash commits to the act).
 *
 * The door must hash `{entryId, version, body}` BEFORE the event exists, so it asks this same
 * function of the writer's state and sends the answer along; `validateFiling` refuses any
 * answer it does not itself derive, so a filing that raced another definition on the same
 * entry is refused and retried rather than recorded under a hash that describes nothing.
 * (Before 2026-08-17 the door hashed `version: 0` while the row stored 1 — every definition
 * filed through the flip carried a hash its own contents could never reproduce.)
 *
 * Counts, rather than maxes, because the snapshot's definitions are contiguous per entry —
 * verified on both kingdoms at the cut: zero entries where max(version) != count(*).
 */
export function nextDefinitionVersion(state: CoreState, entryId: string): number {
  let n = 0
  for (const id of Object.keys(state.acts)) {
    const a = state.acts[id]
    if (a.kind === "DEFINITION" && a.entryId === entryId) n++
  }
  return n + 1
}

function applyFiling(state: CoreState, e: EventEnvelope, notes: string[]) {
  const p = e.payload
  const kind = p.actKind as ActKind
  const actId = p.actId as string
  const author = state.actors[e.actor]

  // consume the filing slot (A7). The clock advances by whole cadences and NEVER to now, so the
  // sub-cadence remainder is carried rather than discarded — the at-cap reset that once discarded
  // it made the reducer steadily stricter than live (three filings cost twelve votes and a stake).
  // Shared with FILING_REFUSED, which burns the same slot for charged refusals (Law 28).
  consumeFilingSlot(state, e.actor, e.ts)

  const act: ActState = { id: actId, kind, authorFp: e.actor, status: "PROVISIONAL", filedSeq: e.seq, contentHash: p.contentHash as string }
  if (kind === "ENTRY") {
    act.nameNorm = norm(p.name as string)
    const ref = str(p, "referent")
    if (ref === "CONCEPT" || ref === "WORD") act.referent = ref // Law 3b; absent/THING stays absent
    const holders = nameHolders(state.names, act.nameNorm)
    if (holders.length) {
      // Law 13-i / D4 — declared at the door: the NAME_COLLISION_WITH edge derives against the
      // FIRST claimant (live: labelHolders orderBy createdAt asc, holders[0]). Validation
      // already demanded the sense. Both kingdoms author this edge as collision:<actId>.
      const holder = state.acts[holders[0]]
      const holderEntry = holder.kind === "ENTRY" ? holder.id : holder.entryId!
      deriveCollisionEdge(state, notes, e.actor, e.seq, actId, actId, holderEntry)
    }
    // ...and the newborn CLAIMS alongside (many-holders, A+A 2026-08-16): entries reserve at
    // filing, freed on rejection; a declared collision makes the word a gem with one more facet.
    claimName(state.names, act.nameNorm, actId)
  } else if (kind === "DEFINITION") {
    act.entryId = p.entryId as string
    act.version = nextDefinitionVersion(state, act.entryId)
  } else if (kind === "EDGE") {
    act.fromEntryId = p.fromEntryId as string
    act.toEntryId = p.toEntryId as string
    act.edgeType = p.edgeType as string
  } else if (kind === "LABEL") {
    act.entryId = p.entryId as string
    act.nameNorm = norm(p.text as string)
    // Law 39: "an ACCEPTED name guards the door" — a pending ALIAS holds nothing. The claim
    // moves to acceptance (ruleProvisionalAct); only entries reserve at filing, because an
    // entry's canonical name is judged WITH the entry and live's gate counts it from birth.
    // (The old filing-time claim here was the row-F asymmetry, fixed 2026-08-15.)
    const other = nameHolders(state.names, act.nameNorm).find(h => {
      const a = state.acts[h]
      return (a.kind === "ENTRY" ? a.id : a.entryId!) !== act.entryId
    })
    if (other) {
      // D4 — the declared collision: the edge derives against the first claimant among the
      // OTHER concepts holding the word (once per pair). The alias itself claims at acceptance.
      const holder = state.acts[other]
      const holderEntry = holder.kind === "ENTRY" ? holder.id : holder.entryId!
      deriveCollisionEdge(state, notes, e.actor, e.seq, actId, act.entryId!, holderEntry)
    }
  }
  state.acts[actId] = act
  notes.push(`filed ${kind} ${actId}`)
}

/** Law 13-i / D4 — the declared collision's edge, derived once per pair, authored by the filer.
 *  Both kingdoms create this act under the SAME id (collision:<filingActId>) — live's
 *  declareCollision passes the identical id — so the shadow diff sees one act, not two. */
function deriveCollisionEdge(
  state: CoreState, notes: string[], actor: string, seq: number,
  filingActId: string, fromEntryId: string, toEntryId: string,
) {
  const exists = Object.keys(state.acts).some(id => {
    const a = state.acts[id]
    return a.kind === "EDGE" && a.edgeType === "NAME_COLLISION_WITH" && !isDead(a.status) &&
      ((a.fromEntryId === fromEntryId && a.toEntryId === toEntryId) || (a.fromEntryId === toEntryId && a.toEntryId === fromEntryId))
  })
  if (exists) return
  const edgeId = `collision:${filingActId}`
  state.acts[edgeId] = {
    id: edgeId, kind: "EDGE", authorFp: actor, status: "PROVISIONAL", filedSeq: seq,
    contentHash: `collision:${filingActId}`, fromEntryId, toEntryId, edgeType: "NAME_COLLISION_WITH",
  }
  notes.push(`collision edge derived ${edgeId} (Law 39): distinct concepts sharing a word — or one construct twice?`)
}

function applyVote(state: CoreState, e: EventEnvelope, notes: string[]) {
  const p = e.payload
  const tt = p.targetType as string
  const tid = p.targetId as string
  const key = targetKey(tt, tid)
  const judge = state.actors[e.actor]
  const stake = BigInt(p.stakeMilli as string)

  const market = (state.votes[key] ??= {})
  const existing = market[e.actor]
  judge.openStakeMilli += stake - (existing ? existing.stakeMilli : 0n)
  market[e.actor] = { dir: p.vote as "ADVANCE" | "STRIKE", stakeMilli: stake, ts: e.ts }
  judge.lastVoteTs = e.ts // the judging population counts this vote from this moment (Law 18)

  // D1: rulings are DERIVED, in this fold, evaluated only on a target-vote event (spec 2),
  // integer math only (spec 1). Contest screens add the Law 31 overlay on the same crossing.
  if (tt === "CHALLENGE") evaluateChallengeScreen(state, state.challenges[tid], e, notes)
  else if (tt === "RAID") evaluateRaidScreen(state, state.raids[tid], e, notes)
  else {
    // D1 spec 3 — the rule version in force is a dial switched only by amendment; a version
    // this reducer does not implement is a hard stop, never a guess.
    const ver = dialNum(state.dials, "QUORUM_RULE_VERSION")
    if (ver !== 1) throw new Error(`quorum rule v${ver} is ratified but not implemented in this reducer — upgrade before folding`)
    const crossing = quorumCrossing(state, market, e.ts)
    if (crossing) {
      notes.push(`quorum ${crossing.status}`)
      ruleProvisionalAct(state, state.acts[tid], crossing.status, `quorum.v${ver}`, e.seq, notes)
    }
  }
}

function applyStake(state: CoreState, e: EventEnvelope, notes: string[]) {
  const p = e.payload
  const tid = p.targetId as string
  const key = targetKey(p.targetType as string, tid)
  const staker = state.actors[e.actor]
  const amount = BigInt(p.amountBase as string)

  staker.balanceBase -= amount
  state.supply.escrowPoolBase += amount
  ;(state.stakes[key] ??= []).push({ fp: e.actor, side: "ATTEST", amountBase: amount, status: "OPEN", payoutBase: 0n, placedSeq: e.seq })

  // Law 22 — a ≥1-coin attestation releases the author's held 75% (once, ever)
  const act = state.acts[tid]
  if (act.holdback && !act.holdback.released && amount >= dialBig(state.dials, "HOLDBACK_RELEASE_MIN_BASE")) {
    const author = state.actors[act.authorFp]
    author.balanceBase += act.holdback.heldBase
    state.supply.coinMintedBase += act.holdback.heldBase
    act.holdback.released = true
    fxStatus("holdback", act.id, act.kind, "released")
    notes.push(`holdback released ${act.holdback.heldBase}`)
  }
}

/** Coherence culling — breadth, not weight: one flagger one flag, the bar is competent
 *  agreement (flagger count + above-median count), and a met bar voids the act with every
 *  market refunded (a void is no judgment). */
function applyFlag(state: CoreState, e: EventEnvelope, notes: string[]) {
  const p = e.payload
  const tid = p.targetId as string
  const flagger = state.actors[e.actor]
  ;(state.flags[tid] ??= {})[e.actor] = { weightMilli: flagger.repMilli, ts: e.ts } // standing at flag time; a re-flag refreshes it
  const flags = state.flags[tid]

  const active = activeJudges(state, e.ts)
  const sharePct = dialNum(state.dials, "INCOHERENCE_FLAGGER_SHARE_PCT")
  const needed = Math.max(dialNum(state.dials, "INCOHERENCE_FLAGGER_FLOOR"), Math.floor((active * sharePct + 99) / 100))
  const median = medianActiveRepMilli(state, e.ts)
  const above = Object.keys(flags).filter(fp => flags[fp].weightMilli > median).length
  const flaggers = Object.keys(flags).length
  notes.push(`flagged (${flaggers}/${needed} flaggers, ${above}/${dialNum(state.dials, "INCOHERENCE_MIN_ABOVE_MEDIAN")} above median)`)

  if (flaggers >= needed && above >= dialNum(state.dials, "INCOHERENCE_MIN_ABOVE_MEDIAN")) {
    const act = state.acts[tid]
    act.status = "REJECTED"
    act.ruling = { status: "REJECTED", atSeq: e.seq, rule: "coherence.v1" }
    // …and SAY SO on the effects trace. cascadeEntry announces every DEPENDENT it strikes
    // (effects.ts), so a coherence void updated the definitions and edges hanging off an entry
    // while the entry itself kept saying PROVISIONAL in the projection. Caught 2026-08-19 by the
    // shadow diff — the only instrument that can see it, since a replay reproduces the same
    // missing write on both sides. Second time this exact silence has bitten (subsumption was
    // the first): a status change that does not announce itself is a status change the rows
    // never learn. Adding an fx is replay-safe by construction — the trace is never hashed,
    // never validated, and reset per event.
    fxStatus("act-status", act.id, act.kind, "REJECTED")
    refundMarketVotes(state, targetKey(act.kind, act.id)) // no penalty — the act was malformed, not mis-judged
    refundOpenStakes(state, targetKey(act.kind, act.id), "BOTH")
    if (act.nameNorm) releaseName(state.names, act.nameNorm, act.id) // plural (A+A)
    if (act.kind === "ENTRY") cascadeEntry(state, act.id, notes)
    delete state.flags[tid]
    notes.push(`voided ${act.kind} ${tid} as incoherent (coherence.v1)`)
  }
}

/** Law 33 — the return no path can bypass: a nudge comes home when its target's implied
 *  state changes, or after the TTL of stillness. Folded on TICK. */
export function actSnapshot(state: CoreState, act: ActState): string {
  let attested = false
  for (const s of state.stakes[targetKey(act.kind, act.id)] ?? []) {
    if (s.status === "OPEN" && s.side === "ATTEST") { attested = true; break }
  }
  let defs = 0
  let edges = 0
  if (act.kind === "ENTRY") {
    for (const id of Object.keys(state.acts)) {
      const a = state.acts[id]
      if (a.kind === "DEFINITION" && a.entryId === act.id && a.status === "ACCEPTED") defs++
      if (a.kind === "EDGE" && !isDead(a.status) && (a.fromEntryId === act.id || a.toEntryId === act.id)) edges++
    }
  }
  return `${act.status}|att:${attested}|defs:${defs}|edges:${edges}`
}

function sweepNudges(state: CoreState, nowTs: string, notes: string[]) {
  const ttl = dialNum(state.dials, "NUDGE_TTL_MS")
  for (const id of Object.keys(state.nudges).sort()) {
    const n = state.nudges[id]
    if (n.status !== "ACTIVE") continue
    if (Date.parse(nowTs) - Date.parse(n.placedTs) >= ttl) {
      n.status = "EXPIRED"
      notes.push(`nudge ${id} returned — ${Math.round(ttl / 3600000)}h of stillness`)
      continue
    }
    const act = state.acts[n.targetId]
    if (!act || actSnapshot(state, act) !== n.snapshot) {
      n.status = "RESOLVED"
      notes.push(`nudge ${id} returned — its target moved`)
    }
  }
}

// ── fold ────────────────────────────────────────────────────────────────────

export function fold(events: EventEnvelope[], snapshot?: CoreState): { state: CoreState; outcomes: Outcome[] } {
  if (!events.length) throw new Error("empty log")
  const state = initState(events[0], snapshot)
  const outcomes: Outcome[] = []
  for (let i = 1; i < events.length; i++) {
    const e = events[i]
    if (e.seq !== state.seq + 1) throw new Error(`gap in log: expected seq ${state.seq + 1}, got ${e.seq}`)
    if (Date.parse(e.ts) < Date.parse(state.ts)) throw new Error(`time reversed at seq ${e.seq}`)
    outcomes.push(applyEvent(state, e))
  }
  return { state, outcomes }
}
