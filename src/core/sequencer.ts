import type { Candidate, CoreState, EventEnvelope, Outcome } from "./types"
import { canonical, hashOf, sha256, ZERO64 } from "./canonical"
import { activatePending, applyEvent, fold, initState, validate } from "./reducer"

/**
 * The sequencer, simulated — orders candidates, stamps seq/ts, hash-chains the envelope
 * (global `prev` + the per-entity puddle `entityPrev`), and folds accepted events into
 * state. This same class is the Phase 2 shadow-writer's core and the fuzzer's harness.
 *
 * Trust boundary (D10): the sequencer cannot forge actor signatures — verification of
 * `sig` against the actor's registered key happens here, at the door, via an injectable
 * verifier (tests stub it; the real ed25519 verifier arrives with the shadow writer).
 * The reducer itself never touches crypto beyond hashing.
 */

export const sigPayload = (c: Candidate) => `${c.kind}|${c.v}|${sha256(canonical(c.payload))}`

export interface SubmitResult {
  accepted: boolean
  reason?: string
  event?: EventEnvelope
  outcome?: Outcome
}

export class LogSim {
  state: CoreState
  events: EventEnvelope[] = []
  private entityHeads = new Map<string, string>()
  private verifySig: (c: Candidate) => boolean

  constructor(
    genesis: {
      ts: string
      keys?: { court: string; governance: string; sequencer: string }
      dials?: Record<string, number | string | boolean>
      systemKeys?: { fingerprint: string; publicKey: string; label?: string }[]
      /** DECOSTUME Phase 3's seam: start from a committed state snapshot instead of empty.
       *  The GENESIS payload carries only the hash; the snapshot itself rides beside the
       *  log (genesis-state.json) and is re-proven on every load. */
      snapshot?: CoreState
    },
    verifySig: (c: Candidate) => boolean = () => true,
  ) {
    this.verifySig = verifySig
    const keys = genesis.snapshot ? genesis.snapshot.keys : genesis.keys
    if (!keys) throw new Error("genesis needs keys (or a snapshot that carries them)")
    const g = this.seal({
      seq: 0, ts: genesis.ts, kind: "GENESIS", v: 1, actor: keys.governance,
      // the payload owns COPIES — the log must never alias caller objects (the KEY_EVENT
      // aliasing lesson, 2026-08-11)
      payload: genesis.snapshot
        ? { keys: { ...keys }, stateHash: hashOf(genesis.snapshot) }
        : {
            keys: { ...keys },
            ...(genesis.dials ? { dials: { ...genesis.dials } } : {}),
            ...(genesis.systemKeys ? { systemKeys: genesis.systemKeys.map(k => ({ ...k })) } : {}),
          },
      sig: "genesis",
    })
    this.events.push(g)
    this.state = initState(g, genesis.snapshot)
  }

  private seal(e: Omit<EventEnvelope, "prev" | "entityPrev" | "hash">): EventEnvelope {
    const prev = this.events.length ? this.events[this.events.length - 1].hash : ZERO64
    const entityPrev = this.entityHeads.get(e.actor) ?? null
    const hash = hashOf({ ...e, prev, entityPrev })
    const sealed: EventEnvelope = { ...e, prev, entityPrev, hash }
    this.entityHeads.set(e.actor, hash)
    return sealed
  }

  /** Submit a candidate at time `ts`. Only accepted commands become events — a rejection
   *  leaves the log untouched (EVENTS.md: the log records accepted inputs, nothing else). */
  submit(c: Candidate, ts: string): SubmitResult {
    if (Date.parse(ts) < Date.parse(this.state.ts)) return { accepted: false, reason: "sequencer clock went backwards" }
    if (!this.verifySig(c)) return { accepted: false, reason: "signature verification failed" }
    activatePending(this.state, this.state.seq + 1) // the candidate is judged under the rules at ITS seq
    const shaped = { kind: c.kind, v: c.v, actor: c.actor, payload: c.payload, ts }
    const reason = validate(this.state, shaped)
    if (reason) return { accepted: false, reason }
    const event = this.seal({ seq: this.state.seq + 1, ts, kind: c.kind, v: c.v, actor: c.actor, payload: c.payload, sig: c.sig })
    const outcome = applyEvent(this.state, event)
    this.events.push(event)
    return { accepted: true, event, outcome }
  }

  tick(ts: string): SubmitResult {
    return this.submit({ kind: "TICK", v: 1, actor: this.state.keys.sequencer, payload: {}, sig: "seq" }, ts)
  }

  /** Rebuild a sequencer from a persisted log — the restart path the shadow writer lives on.
   *  The whole log refolds (replay IS the load), and the chain heads resume exactly. */
  static resume(events: EventEnvelope[], verifySig: (c: Candidate) => boolean = () => true, snapshot?: CoreState): LogSim {
    const sim: LogSim = Object.create(LogSim.prototype)
    sim.events = [...events]
    sim.verifySig = verifySig
    sim.entityHeads = new Map()
    for (const e of events) sim.entityHeads.set(e.actor, e.hash)
    sim.state = fold(events, snapshot).state
    return sim
  }
}
