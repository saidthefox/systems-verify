/**
 * systema-core — types. The event envelope and the folded state.
 *
 * PURE BY LAW: nothing in src/core may import prisma, next, fetch, env, Date.now or
 * Math.random. Time arrives inside events; randomness does not exist here. The reducer's
 * determinism is the product (EVENTS.md, Principle 2).
 *
 * All quantities are bigint: coins in base units (1 coin = 10^8), reputation in MILLI-REP
 * (1 rep = 1000 milli — EVENTS.md D5). Payload JSON carries amounts as decimal strings.
 */

export const COIN_SCALE = 100_000_000n
export const REP_SCALE = 1000n

// ── envelope ────────────────────────────────────────────────────────────────

export interface EventEnvelope {
  seq: number
  ts: string // ISO-8601, stamped by the sequencer — the ONLY clock the reducer sees
  kind: string
  v: number
  actor: string // chain-key fingerprint, or "system:sequencer"
  payload: Record<string, unknown>
  sig: string
  prev: string
  entityPrev: string | null
  hash: string
}

/** A command before the sequencer accepts it: everything the author controls. */
export interface Candidate {
  kind: string
  v: number
  actor: string
  payload: Record<string, unknown>
  sig: string
}

// ── state ───────────────────────────────────────────────────────────────────

export type ActKind = "ENTRY" | "DEFINITION" | "EDGE" | "LABEL" | "FACET"
export type ActStatus = "PROVISIONAL" | "ACCEPTED" | "REJECTED" | "SUPERSEDED"
export type VoteDir = "ADVANCE" | "STRIKE"
export type StakeSide = "ATTEST" | "RAID"

/** Terminal-and-gone: a dead act guards no gates and anchors no edges. */
export const isDead = (s: ActStatus): boolean => s === "REJECTED" || s === "SUPERSEDED"

// ── the plural name gate (Law 39, many-holders — keeper's A+A ruling 2026-08-16) ───────────
/** Every act currently holding this normalized word, first claimant first. */
export const nameHolders = (names: Record<string, string[]>, nameNorm: string): string[] =>
  names[nameNorm] ?? []
/** Claim a word: append this act to the holder list (idempotent; order = claim order). */
export function claimName(names: Record<string, string[]>, nameNorm: string, actId: string) {
  const l = (names[nameNorm] ??= [])
  if (!l.includes(actId)) l.push(actId)
}
/** Release one holder's claim (rejection frees; supersession never calls this — the relic's
 *  claim outlives it, exactly as live's labelHolders keeps counting a SUPERSEDED entry). */
export function releaseName(names: Record<string, string[]>, nameNorm: string, actId: string) {
  const l = names[nameNorm]
  if (!l) return
  const i = l.indexOf(actId)
  if (i >= 0) l.splice(i, 1)
  if (!l.length) delete names[nameNorm]
}

export const EDGE_TYPES = new Set([
  "CONTAINS", "INSTANCE_OF", "DERIVED_FROM", "DEPENDS_ON", "SERVES",
  "EXPLICIT_FORM_OF", "SUPERSEDES", "SAME_CONSTRUCT_AS", "NAME_COLLISION_WITH",
])

export interface Ruling {
  status: "ACCEPTED" | "REJECTED"
  atSeq: number
  rule: string // "quorum.v1" | "court" — provenance (D1 spec 5)
}

export interface ActState {
  id: string
  kind: ActKind
  authorFp: string
  status: ActStatus
  filedSeq: number
  contentHash: string
  // registry-typed fields
  nameNorm?: string // ENTRY / LABEL — the Law 12 normalized name
  referent?: "CONCEPT" | "WORD" // ENTRY, Law 3b — what the name points at; absent = THING (the default)
  entryId?: string // DEFINITION / LABEL
  version?: number // DEFINITION — the fold's own count (see nextDefinitionVersion); absent on pre-cut acts
  fromEntryId?: string // EDGE
  toEntryId?: string // EDGE
  edgeType?: string // EDGE
  ruling?: Ruling
  orphaned?: boolean // struck by cascade/collision/subsumption — author keeps the award (Law 30)
  canonical?: boolean // a CANONICAL label imported from prod — an implementation row, not an EVENTS act (the diff skips it)
  subsumedVia?: string // Law 11e — the rung that made this leap derivable
  supersededBy?: string // Law 30 REPLACE — the successor that took its place
  awardedRepMilli?: bigint // recorded at acceptance so a clawback negates EXACTLY this
  holdback?: { heldBase: bigint; released: boolean }
}

export interface OpenVote {
  dir: VoteDir
  stakeMilli: bigint
  ts: string
}

export interface Stake {
  fp: string
  side: StakeSide
  amountBase: bigint
  status: "OPEN" | "SETTLED"
  payoutBase: bigint
  placedSeq: number
}

export interface Actor {
  fp: string
  entityType: "house" | "agent" | "user" | "system"
  entityId: string
  label: string
  publicKey: string
  repMilli: bigint // unfloored, like repRaw
  balanceBase: bigint // coins — the reducer owns what the chain's entities table holds today
  openStakeMilli: bigint // committed reputation across open votes
  lastVoteTs: string | null // drives the Law 18 trailing-window bar
  filing: { slots: number; atTs: string } | null // A7 gate — agents only
  // Law 38b-i — the seat's house. Absent on actors imported before the identity cleanup
  // (2026-08-12), and absent by definition on offices, agents and system keys.
  houseId?: string
}

export interface Attestation {
  fp: string           // who anchored it
  actHash: string      // sha256 of the record document
  atSeq: number
  inline: boolean      // did the event carry the record itself, or only its hash?
}

export interface House {
  id: string
  label: string
  keyFp: string
  agentFps: string[]
  credentialHashes: string[]
}

// ── the contest ladder (Laws 14/24/30/31, Amendment 5E) ─────────────────────

/** screen.v2 lifecycle (sortition + sealed votes). Absent under v1 — the dial decides. */
export interface ScreenV2 {
  phase: "JURY" | "COMMIT" | "REVEAL" | "PARKED"
  phaseTs: string
  jurySeed?: string // the TICK-derived seed the draw (and every alternate round) extends
  juryFps?: string[]
  commits?: Record<string, string> // juror fp → commitHash (one shot, sealed)
  altRounds?: number
}

export interface Challenge {
  id: string // derived: challenge:<targetType>:<targetId>:<seq> (D6)
  targetType: string
  targetId: string
  mode: "STRIKE" | "REPLACE"
  replacementSpec?: Record<string, unknown> // REPLACE — the successor, judged as part of the swap
  successorId?: string // stamped when an upheld REPLACE seats it
  authorFp: string
  status: "PENDING" | "ACCEPTED" | "REJECTED"
  filedSeq: number
  humanResets?: number // Law 31 dissent resets executed on this screen
  parked?: boolean // Law 31b-ii — a second dissent sends the screen to the court; the market stands
  v2?: ScreenV2
}

export type RaidStatus = "SCREEN" | "COALITION" | "COURT" | "STRUCK" | "UPHELD" | "DISMISSED" | "EXPIRED"
export const RAID_LIVE: RaidStatus[] = ["SCREEN", "COALITION", "COURT"]

export interface Raid {
  id: string // derived: raid:<targetType>:<targetId>:<seq> (D6)
  targetType: string
  targetId: string
  status: RaidStatus
  openedByFp: string
  frozenAttestBase: bigint | null // the parity target, frozen at advancement
  advancedTs: string | null
  humanResets?: number // Law 31 dissent resets executed on this screen
  parked?: boolean // Law 31b-ii — a second dissent sends the screen to the court; the market stands
  v2?: ScreenV2
}

export interface Supply {
  coinMintedBase: bigint
  coinBurnedBase: bigint
  escrowPoolBase: bigint // staked coins awaiting settlement + accumulated floor dust
  repMintedMilli: bigint // acceptance awards + concurrence bonuses
  repBurnedMilli: bigint // unclaimed forfeits + parimutuel floor dust
}

export interface CoreState {
  seq: number
  ts: string
  dials: Record<string, number | string | boolean>
  keys: { court: string; governance: string; sequencer: string }
  actors: Record<string, Actor> // by fingerprint
  /** Amendment 1 (as amended, 2026-08-18): facts from OUTSIDE the taxonomy, anchored here by
   *  the system that owns them. Keyed by actId — globally unique per fact, which is what makes
   *  anchoring idempotent, exactly as the chain's one-block-per-act rule did. */
  attestations: Record<string, Attestation>
  houses: Record<string, House>
  /** EVERY credential that has ever claimed a house — Law 38's sybil binding. Append-only on
   *  purpose: if a claim could be forgotten, the same human could unlink and found a second
   *  house, and one-human-one-house would stop meaning anything. */
  credentialToHouse: Record<string, string>
  /** …and the ones that no longer OPEN their house (ALIAS_REVOKED, 2026-08-19). The two facts
   *  are different and were previously conflated: "has ever been claimed" is permanent, "may be
   *  used to sign in" is not. Keeping them apart is what lets a credential be revoked without
   *  weakening the sybil rule — and lets the diff be exact instead of carrying an uncounted line
   *  that hid a revocation and a projector bug behind the same number. */
  revokedCredentials: Record<string, { houseId: string; atSeq: number }>
  acts: Record<string, ActState>
  challenges: Record<string, Challenge>
  raids: Record<string, Raid>
  // ── governance (the amendment machinery, D1 spec 3) ──
  amendments: Record<string, { docHash: string; activationSeq: number; ratifiedSeq: number }>
  pendingActivations: { seq: number; id: string; dials: Record<string, number | string | boolean> }[] // sorted by seq
  laws: Record<string, { docHash: string; atSeq: number }[]> // per-law anchor history, append-only
  burns: Record<string, { fp: string; amountBase: bigint; compensated: boolean }> // by burn seq — COMPENSATION mirrors these, once
  flags: Record<string, Record<string, { weightMilli: bigint; ts: string }>> // coherence: targetId → flagger → standing at flag time
  nudges: Record<string, { id: string; targetType: string; targetId: string; identityFp: string; snapshot: string; placedTs: string; status: "ACTIVE" | "RESOLVED" | "EXPIRED" }>
  gallery: Record<string, Record<string, VoteDir>> // recorded and INERT — no rule may read it
  ingots: Record<string, { id: string; houseId: string; entityFp: string; yieldWhole: number; drossWhole: number; ts: string }>
  // Normalized name → holding act ids (ENTRY/LABEL), ORDERED by claim time — index 0 is the
  // first claimant, the collision partner every derived edge names. PLURAL since 2026-08-16
  // (keeper's A+A ruling): Law 39 means what it says — one word may openly name many concepts,
  // and every accepted binding HOLDS. The single-slot map was a v1 narrowing, retired.
  names: Record<string, string[]>
  votes: Record<string, Record<string, OpenVote>> // targetKey → voterFp → open vote
  stakes: Record<string, Stake[]> // targetKey → stakes
  supply: Supply
}

export const targetKey = (targetType: string, targetId: string) => `${targetType}:${targetId}`

export interface Outcome {
  accepted: boolean
  reason?: string
  /** derived consequences of this fold, for projections/tests (not part of state identity) */
  notes: string[]
  /** the effects trace — settlement details for the projector (never hashed, never validated) */
  fx?: import("./effects").Fx[]
}
