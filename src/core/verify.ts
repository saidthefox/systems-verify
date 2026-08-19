import { createHash, createPublicKey, verify as edVerify } from "crypto"
import type { Candidate, CoreState, EventEnvelope } from "./types"
import { hashOf, ZERO64 } from "./canonical"
import { sigPayload } from "./sequencer"
import { applyEvent, initState } from "./reducer"
import { dialNum } from "./dials"

/**
 * The verification layer — the sequencer's door and the stranger's replay (D10).
 *
 * Same crypto discipline as systema-chain: ed25519 over DER/spki, fingerprint =
 * sha256(raw DER bytes). The reducer itself never touches signatures; the sequencer
 * verifies at the door, and verifyLog re-proves the whole record — hash chain, per-entity
 * puddles, and (optionally) every signature under the keys the log itself registered.
 */

export const fingerprintOf = (publicKeyB64: string): string =>
  createHash("sha256").update(Buffer.from(publicKeyB64, "base64")).digest("hex")

export function ed25519Verify(publicKeyB64: string, payload: string, sigB64: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyB64, "base64"), format: "der", type: "spki" })
    return edVerify(null, Buffer.from(payload), key, Buffer.from(sigB64, "base64"))
  } catch {
    return false
  }
}

/** Resolve the public key a candidate must verify under: a registered actor's key, or —
 *  for the self-registering events (HOUSE_FOUNDED, AGENT_MINTED, ENTITY_REGISTERED) — the
 *  key carried in the payload, bound by fingerprint. */
function keyFor(state: CoreState, c: Pick<Candidate, "actor" | "payload">): string | null {
  const registered = state.actors[c.actor]?.publicKey
  if (registered) return registered
  const carried = c.payload.publicKey
  if (typeof carried === "string" && fingerprintOf(carried) === c.actor) return carried
  return null
}

/** The real sequencer-door verifier: pass to LogSim in place of the test stub. */
export function realVerifier(stateRef: () => CoreState) {
  return (c: Candidate): boolean => {
    const pub = keyFor(stateRef(), c)
    if (!pub) return false
    return ed25519Verify(pub, sigPayload(c), c.sig)
  }
}

export interface LogVerdict {
  valid: boolean
  failedAt?: number
  reason?: string
  events: number
}

/**
 * Re-prove a log end to end: seq gaps, hash chain, per-entity puddle links, recomputed
 * envelope hashes, reducer validity of every fold — and, with { sigs: true }, every
 * signature under the keys the log itself registered (system keys must arrive via the
 * GENESIS `systemKeys` roster or self-registering events; an unverifiable signer fails
 * the log, never skips it).
 */
export function verifyLog(events: EventEnvelope[], opts: { sigs?: boolean; snapshot?: CoreState } = {}): LogVerdict {
  if (!events.length) return { valid: false, reason: "empty log", events: 0 }
  const fail = (e: EventEnvelope, reason: string): LogVerdict => ({ valid: false, failedAt: e.seq, reason, events: events.length })

  let state: CoreState
  try {
    // A snapshot-genesis log cannot be folded without its sidecar, and the whole point of this
    // function is that a STRANGER can run it: they will have the log and genesis-state.json,
    // which is exactly what the replicas carry. Without this parameter the verifier refused the
    // very shape it was built to check (found 2026-08-18 running it against a replica).
    state = initState(events[0], opts.snapshot)
  } catch (err) {
    return { valid: false, failedAt: 0, reason: String(err instanceof Error ? err.message : err), events: events.length }
  }

  let prev = ZERO64
  const entityHeads = new Map<string, string>()
  for (const e of events) {
    if (e.prev !== prev) return fail(e, "broken prev_hash link")
    const expectedEntityPrev = entityHeads.get(e.actor) ?? null
    if (e.entityPrev !== expectedEntityPrev) return fail(e, "broken entity chain link (the puddle)")
    const recomputed = hashOf({ seq: e.seq, ts: e.ts, kind: e.kind, v: e.v, actor: e.actor, payload: e.payload, sig: e.sig, prev: e.prev, entityPrev: e.entityPrev })
    if (recomputed !== e.hash) return fail(e, "hash mismatch")
    // A STRANGER ENFORCES WHAT THE DOOR ENFORCED. `opts.sigs` checks everything, which is what
    // an auditor wants; but from SIGS_FROM_SEQ onward the LAW requires it, so the verifier
    // demands it whether or not the caller asked — otherwise a replay could call a log valid
    // that the kingdom's own door would have refused. Below that seq the custodial era stands
    // as it was lived: signatures were not required, and re-judging history under a later rule
    // would refuse the record for obeying the rule in force at the time.
    const sigsRequiredHere = dialNum(state.dials, "SIGS_FROM_SEQ") > 0
      && e.seq >= dialNum(state.dials, "SIGS_FROM_SEQ")
    if ((opts.sigs || sigsRequiredHere) && e.kind !== "GENESIS") {
      const pub = keyFor(state, e)
      if (!pub) return fail(e, `no verifiable key for actor ${e.actor}`)
      if (!ed25519Verify(pub, sigPayload(e), e.sig)) return fail(e, "signature verification failed")
    }
    if (e.seq > 0) {
      try {
        applyEvent(state, e)
      } catch (err) {
        return fail(e, `reducer refused: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    prev = e.hash
    entityHeads.set(e.actor, e.hash)
  }
  return { valid: true, events: events.length }
}
