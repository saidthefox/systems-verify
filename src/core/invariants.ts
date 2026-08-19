import type { CoreState } from "./types"
import { RAID_LIVE, targetKey } from "./types"
import { dialNum } from "./dials"

/**
 * The invariant suite — asserted after every fold in tests and fuzzing, sampled in prod
 * later (DECOSTUME). Each returns a violation string or null. These are the properties the
 * whole architecture exists to make unbreakable; a fuzzer that runs millions of random
 * events without tripping one is the Phase 1 exit criterion.
 */

type Check = (s: CoreState) => string | null

const coinConservation: Check = s => {
  let sum = 0n
  for (const fp of Object.keys(s.actors)) sum += s.actors[fp].balanceBase
  const rhs = s.supply.coinMintedBase - s.supply.coinBurnedBase
  const lhs = sum + s.supply.escrowPoolBase
  return lhs === rhs ? null : `coin conservation: balances+escrow ${lhs} ≠ minted-burned ${rhs}`
}

const repConservation: Check = s => {
  let sum = 0n
  for (const fp of Object.keys(s.actors)) sum += s.actors[fp].repMilli
  const rhs = s.supply.repMintedMilli - s.supply.repBurnedMilli
  return sum === rhs ? null : `rep conservation: Σrep ${sum} ≠ minted-burned ${rhs}`
}

const noNegativeBalances: Check = s => {
  for (const fp of Object.keys(s.actors)) {
    if (s.actors[fp].balanceBase < 0n) return `negative coin balance on ${fp}`
    if (s.actors[fp].openStakeMilli < 0n) return `negative committed rep on ${fp}`
  }
  return s.supply.escrowPoolBase < 0n ? "negative escrow pool" : null
}

const noOpenMarketOnRuledActs: Check = s => {
  for (const id of Object.keys(s.acts)) {
    const a = s.acts[id]
    if (a.status === "PROVISIONAL") continue
    const key = targetKey(a.kind, a.id)
    if (s.votes[key] && Object.keys(s.votes[key]).length) return `open votes on ruled act ${id}`
    if (a.status === "REJECTED" || a.status === "SUPERSEDED") {
      for (const st of s.stakes[key] ?? []) if (st.status === "OPEN") return `open stake on dead act ${id}`
    }
  }
  // screens settle when they resolve: a decided challenge or a raid past SCREEN keeps no market
  for (const id of Object.keys(s.challenges)) {
    if (s.challenges[id].status === "PENDING") continue
    const k = targetKey("CHALLENGE", id)
    if (s.votes[k] && Object.keys(s.votes[k]).length) return `open votes on resolved challenge ${id}`
  }
  for (const id of Object.keys(s.raids)) {
    if (s.raids[id].status === "SCREEN") continue
    const k = targetKey("RAID", id)
    if (s.votes[k] && Object.keys(s.votes[k]).length) return `open votes on advanced/finished raid ${id}`
  }
  return null
}

const contestLifecycle: Check = s => {
  const pendingByTarget = new Map<string, number>()
  for (const id of Object.keys(s.challenges)) {
    const c = s.challenges[id]
    if (c.status === "PENDING") pendingByTarget.set(c.targetId, (pendingByTarget.get(c.targetId) ?? 0) + 1)
  }
  for (const [t, n] of pendingByTarget) if (n > 1) return `${n} live challenges on ${t} — one live contest per target`
  const liveRaidTargets = new Map<string, number>()
  for (const id of Object.keys(s.raids)) {
    const r = s.raids[id]
    if (RAID_LIVE.includes(r.status)) liveRaidTargets.set(r.targetId, (liveRaidTargets.get(r.targetId) ?? 0) + 1)
  }
  for (const [t, n] of liveRaidTargets) if (n > 1) return `${n} live raids on ${t}`
  // a finished raid leaves no RAID coins open on its target (unless a NEW raid reopened it)
  for (const id of Object.keys(s.raids)) {
    const r = s.raids[id]
    if (RAID_LIVE.includes(r.status) || liveRaidTargets.has(r.targetId)) continue
    for (const st of s.stakes[targetKey(r.targetType, r.targetId)] ?? []) {
      if (st.status === "OPEN" && st.side === "RAID") return `open RAID stake behind finished raid ${id}`
    }
  }
  return null
}

const committedRepMatchesOpenVotes: Check = s => {
  const committed: Record<string, bigint> = {}
  for (const key of Object.keys(s.votes)) {
    for (const fp of Object.keys(s.votes[key])) {
      committed[fp] = (committed[fp] ?? 0n) + s.votes[key][fp].stakeMilli
    }
  }
  for (const fp of Object.keys(s.actors)) {
    const expect = committed[fp] ?? 0n
    if (s.actors[fp].openStakeMilli !== expect) {
      return `committed-rep drift on ${fp}: tracked ${s.actors[fp].openStakeMilli}, open votes sum ${expect}`
    }
  }
  return null
}

const sybilRules: Check = s => {
  // Law 38, read precisely: "holding is not minting" — the slots dial gates the MINT (which
  // AGENT_MINTED validation enforces), never the holdings. A house imported over the current
  // cap is history, not a violation (staging taught this at genesis, 2026-08-11). What must
  // hold structurally: the credential map never drifts.
  for (const houseId of Object.keys(s.houses)) {
    for (const cred of s.houses[houseId].credentialHashes) {
      if (s.credentialToHouse[cred] !== houseId) return `credential map drift for ${cred}`
    }
  }
  return null
}

const rulingsCarryProvenance: Check = s => {
  for (const id of Object.keys(s.acts)) {
    const a = s.acts[id]
    if (a.status === "PROVISIONAL") continue
    // D1 spec 5 — every terminal act names the rule that concluded it, except cascade/
    // collision/subsumption rejections, which carry their mark instead of a ruling.
    if (!a.ruling && a.status !== "REJECTED") return `${a.status} act ${id} without provenance`
    if (a.status === "SUPERSEDED" && !a.supersededBy) return `superseded act ${id} names no successor`
  }
  return null
}

const nudgeHand: Check = s => {
  const held = new Map<string, number>()
  for (const id of Object.keys(s.nudges)) {
    const n = s.nudges[id]
    if (n.status === "ACTIVE") held.set(n.identityFp, (held.get(n.identityFp) ?? 0) + 1)
  }
  const cap = dialNum(s.dials, "HAND_SIZE")
  for (const [fp, n] of held) if (n > cap) return `${fp} holds ${n} active nudges (hand is ${cap})`
  return null
}

export const INVARIANTS: Record<string, Check> = {
  coinConservation,
  repConservation,
  noNegativeBalances,
  noOpenMarketOnRuledActs,
  committedRepMatchesOpenVotes,
  sybilRules,
  rulingsCarryProvenance,
  contestLifecycle,
  nudgeHand,
}

/** All violations in one pass — empty array = the state is lawful. */
export function checkInvariants(s: CoreState): string[] {
  const out: string[] = []
  for (const name of Object.keys(INVARIANTS)) {
    const v = INVARIANTS[name](s)
    if (v) out.push(`${name}: ${v}`)
  }
  return out
}
