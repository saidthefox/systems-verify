/**
 * The dials — every rule-affecting parameter, as governance-settable state (EVENTS.md,
 * Principle 2: the reducer reads no env). GENESIS carries overrides; DIAL_SET changes them
 * by governance/court signature. Values mirror production today.
 */
export const GENESIS_DIALS: Record<string, number | string | boolean> = {
  // Amendment 7
  A7_ACTIVE: true,
  SOFT_FORFEIT_PERMILLE: 250, // losing vote forfeits stake·f/1000 on a soft settlement
  FILING_CAP: 8,
  FILING_REGEN_MS: 675_000, // 0.1875 h
  INFLIGHT_CAP: 15,
  // Signatures (2026-08-18). 0 = not enforced. Set by DIAL_SET to a FUTURE seq once the offices
  // hold real keys, and from that seq every event must verify under a key the log itself
  // registered. Events before it carry the custodial-era `shadow` marker and are checked by the
  // hash chain alone — an honest seam, recorded rather than pretended away.
  SIGS_FROM_SEQ: 0,
  // Rule versioning (D1 spec 3) — switched by AMENDMENT_RATIFIED at its activation seq;
  // the reducer refuses to fold under a version it does not implement (fail loud, never guess)
  QUORUM_RULE_VERSION: 1,
  // Law 18 (rev 2) quorum bar
  QUORUM_FLOOR: 3,
  QUORUM_CEILING: 9,
  JUDGE_WINDOW_MS: 30 * 24 * 3600 * 1000,
  MIN_JUDGE_STAKE_MILLI: 1000,
  CONCURRENCE_BONUS_MILLI: 1000, // Law 19a
  // Acceptance reputation (Law 11c curve for edges)
  ACCEPT_REWARD_MILLI: 2000,
  EDGE_DECAY_K: 3,
  // Coin rewards, base units (A7 7E repricing; A5 always in force post-genesis)
  REWARD_ENTRY_BASE: 200_000_000,
  REWARD_DEFINITION_BASE: 400_000_000,
  REWARD_LABEL_BASE: 100_000_000,
  REWARD_EDGE_BASE: 300_000_000, // ÷(K+n), floored, min 1
  SETTLED_QUARTER: true, // Amendment 5: mint floor(R/4) now, hold the rest
  HOLDBACK_RELEASE_MIN_BASE: 100_000_000, // Law 22 — a ≥1-coin attestation frees the holdback
  // Amendment 5 edge yield — an edge that points at ATTESTED structure pays twice over: this much
  // to its writer per attested endpoint, and this much again split pro-rata among that endpoint's
  // attesters (the ROYALTY blocks on the chain). Both are mints, not transfers.
  EDGE_YIELD_BASE: 5_000_000, // 0.05 coin — mirrors YIELD_BONUS in lib/chain.ts
  MIN_STAKE_BASE: 10_000_000, // 0.1 coin floor stake
  // Coherence culling (breadth, not weight)
  INCOHERENCE_FLAGGER_FLOOR: 3,
  INCOHERENCE_FLAGGER_SHARE_PCT: 3, // ceil(active·3%) flaggers needed, floored above
  INCOHERENCE_MIN_ABOVE_MEDIAN: 2,
  FALSE_FLAG_COST_MILLI: 2000,
  // Law 33 — the pointed finger
  HAND_SIZE: 3,
  NUDGE_TTL_MS: 48 * 3600 * 1000,
  // Law 35 — the forge (dross: one coin in ten, minimum one)
  SMELT_MIN_WHOLE: 2,
  // screen.v2 — sortition + sealed votes for contest screens (DORMANT: v1 = prod parity.
  // Activation is an AMENDMENT_RATIFIED at a future seq — ideally the Law 40 franchise's
  // own first ratification.)
  SCREEN_RULE_VERSION: 1,
  JURY_EXTRA: 2, // jury size = the Law 18 bar + this
  JURY_MIN_HUMANS: 1, // stratified draw guarantees this many human seats when any are eligible
  JURY_ALTERNATE_ROUNDS: 2, // redraws before the screen proceeds with whoever committed
  COMMIT_WINDOW_MS: 24 * 3600 * 1000,
  REVEAL_WINDOW_MS: 24 * 3600 * 1000,
  // The contest ladder (Laws 14/24/31, Amendment 5E)
  CHALLENGE_STAKE_BASE: 200_000_000, // burned at filing (Law 14); outweighed by the uphold reward
  CHALLENGE_UPHELD_REP_MILLI: 5000,
  CHALLENGE_UPHELD_COIN_BASE: 500_000_000,
  RAID_MIN_COINS_BASE: 100_000_000, // contesting an attested act stakes ≥ 1 coin
  RAID_COALITION_TTL_MS: 7 * 24 * 3600 * 1000,
  // Law 31b — the human voice (drafted 2026-08-12; dormant values mirror prod today,
  // switched by DIAL_SET in lockstep with prod's HUMAN_VOICE_OPEN door)
  SCREEN_HUMAN_STAKE_MIN_MILLI: 1000, // 31b-i: 0 in force — being human is the stake
  HUMAN_RESET_LIMIT: 0, // 31b-ii: 0 = unlimited dissent resets; 1 = one retrial, then the court
  // Laws 31c/31d — RESERVED, ratified dormant, NOT implemented: the ladder's guard halts
  // the fold if either is set (fail loud, never guess — D1)
  SEAL_WINDOW_MS: 0,
  DISSENT_SLOTS: 0,
  // Law 38
  HOUSE_AGENT_SLOTS: 1,
  // Law 38b-i (ratified 2026-08-12) — one human account per house. Enforced at the app's door in
  // a serializable transaction against User.houseId; since 2026-08-15 an Actor DOES carry its
  // houseId (offices are typed `system` and unhoused), and the core uses the seat for the
  // screen-seal gate. The one-human-per-house count itself still lives at the door only.
  // The dial lives here so the roster knows it and a later DIAL_SET is a rule change at a seq.
  HOUSE_HUMAN_SLOTS: 1,
  // Doors (closed/open state as law, not env)
  CONTEST_AGENTS_OPEN: false,
  FORGE_OPEN: false,
  MINT_AGENTS_OPEN: true,
}

export const dialNum = (dials: Record<string, unknown>, key: string): number => {
  const v = dials[key]
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`dial ${key} is not a number`)
  return v
}
export const dialBig = (dials: Record<string, unknown>, key: string): bigint => BigInt(dialNum(dials, key))
export const dialBool = (dials: Record<string, unknown>, key: string): boolean => dials[key] === true
