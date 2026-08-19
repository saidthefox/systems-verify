import type { CoreState } from "./types"
import { targetKey } from "./types"
import { sha256 } from "./canonical"
import { dialBig, dialNum } from "./dials"
import { quorumMinJudges } from "./math"

/**
 * Sortition — screen.v2's jury draw.
 *
 * DETERMINISM: the draw is a pure function of (seed, eligible pool). The seed comes from
 * the first TICK after the contest filed — sha256(tickHash ‖ screenId) — so a filer cannot
 * grind a friendly jury (the TICK's hash chains over every intervening event), and any
 * stranger's replay draws the identical panel. The residual influence (a sequencer
 * reordering to steer a hash) is the same single-writer trust the log already carries —
 * D10, extended by one sentence, never pretended away.
 *
 * UNIFORM, one judge one ticket: no weighting by reputation or record — weighted juries
 * rebuild in the courtroom the oligarchy Law 40b forbids in the state. Stratification is
 * the one exception: the draw guarantees human seats (when any are eligible) because a
 *  screen that cannot produce Law 31 concurrence is a screen that cannot conclude.
 *
 * Selection: iterative hash-index — idx = seed mod pool, remove, extend seed — auditable
 * with a pencil, no floats, no modulo-bias worth the name at jury scale.
 */

export const drawSeed = (tickHash: string, screenId: string): string => sha256(`${tickHash}|${screenId}`)
export const nextSeed = (seed: string, round: number): string => sha256(`${seed}|alt|${round}`)

function pick(seed: string, pool: string[], count: number): { picked: string[]; seed: string } {
  const remaining = [...pool]
  const picked: string[] = []
  let s = seed
  while (picked.length < count && remaining.length) {
    const idx = Number(BigInt("0x" + s.slice(0, 12)) % BigInt(remaining.length))
    picked.push(remaining.splice(idx, 1)[0])
    s = sha256(s)
  }
  return { picked, seed: s }
}

/** Everyone who may sit: active judges (Law 18's own population) able to stake, minus the
 *  parties — the author of the target, the contester/opener, and anyone with an open stake
 *  on the target. No one judges a market they are in. Sorted: the pool is deterministic. */
export function eligibleJurors(state: CoreState, screen: { targetType: string; targetId: string }, excludeFps: string[]): { humans: string[]; agents: string[] } {
  const windowMs = dialNum(state.dials, "JUDGE_WINDOW_MS")
  const cutoff = Date.parse(state.ts) - windowMs
  const excluded = new Set(excludeFps)
  const target = state.acts[screen.targetId]
  if (target) excluded.add(target.authorFp)
  for (const s of state.stakes[targetKey(screen.targetType, screen.targetId)] ?? []) {
    if (s.status === "OPEN") excluded.add(s.fp)
  }
  const humans: string[] = []
  const agents: string[] = []
  for (const fp of Object.keys(state.actors).sort()) {
    const a = state.actors[fp]
    if (excluded.has(fp)) continue
    if (a.entityType !== "agent" && a.entityType !== "user") continue
    if (a.lastVoteTs === null || Date.parse(a.lastVoteTs) < cutoff) continue
    // must be able to stake their judging floor — and a human's floor is Law 31b-i's dial:
    // at 0, no purse bars a human from the draw (a human priced out of voting would be
    // invisible to the very stratification that guarantees the Law 31 seat)
    const floorMilli = a.entityType === "user"
      ? dialBig(state.dials, "SCREEN_HUMAN_STAKE_MIN_MILLI")
      : dialBig(state.dials, "MIN_JUDGE_STAKE_MILLI")
    if (floorMilli > 0n && a.repMilli < floorMilli) continue
    // The human seat is drawn from SEATS, not from every row that happens to be typed `user`
    // (Law 38b-i; identity cleanup 2026-08-12). The stratified seat exists to guarantee Law 31
    // concurrence, so the pool must be the people who can actually give it — and the seal's own
    // test is the same one: housed. Fail-closed on purpose: an actor whose house we cannot
    // confirm is not seated here, and a jury that seats no human parks for the court (Law 24's
    // backstop) rather than concluding without the seal it needed.
    //
    // Snapshots cut before the cleanup carry no houseId, so on those the human pool reads empty
    // until the next cut — which is also the cut that first types the court as `system`. Both
    // corrections arrive together, by construction.
    if (a.entityType === "user" && !a.houseId) continue
    ;(a.entityType === "user" ? humans : agents).push(fp)
  }
  return { humans, agents }
}

/** Jury size scales with the population by the law that already exists: the Law 18 bar + extra. */
export function jurySize(state: CoreState): number {
  const windowMs = dialNum(state.dials, "JUDGE_WINDOW_MS")
  const cutoff = Date.parse(state.ts) - windowMs
  let active = 0
  for (const fp of Object.keys(state.actors)) {
    const t = state.actors[fp].lastVoteTs
    if (t !== null && Date.parse(t) >= cutoff) active++
  }
  return quorumMinJudges(active, dialNum(state.dials, "QUORUM_FLOOR"), dialNum(state.dials, "QUORUM_CEILING")) + dialNum(state.dials, "JURY_EXTRA")
}

/** The stratified draw: guaranteed human seats first (when any exist), the rest uniform
 *  from everyone remaining. A pool smaller than the jury seats the whole pool. */
export function drawJury(seed: string, pool: { humans: string[]; agents: string[] }, size: number, minHumans: number): string[] {
  const humanSeats = Math.min(minHumans, pool.humans.length, size)
  const first = pick(seed, pool.humans, humanSeats)
  const rest = pick(first.seed, [...pool.humans.filter(h => !first.picked.includes(h)), ...pool.agents].sort(), size - first.picked.length)
  return [...first.picked, ...rest.picked].sort()
}
