/**
 * Input bounds — LAW, not transport (keeper's ruling 2026-08-15: "we don't want this
 * attackable service to be open"). The caps live in the core because after the cutover the
 * reducer is the only door; a bound absent here simply does not exist as a rule. The live
 * routes' lib/limits.ts re-exports THESE — one source, two kingdoms, no drift.
 *
 * REFUSE, NEVER TRUNCATE: contentHash commits to the text and is anchored on the chain; a
 * silent slice would sign an act its author never wrote. (Short decorative fields — sense —
 * keep their live-side slice; they are not hashed as the act.)
 *
 * ENTRY_NAME === LABEL_TEXT deliberately: every canonicalName becomes a CANONICAL label, so a
 * name legal at one door and refused at the other would be an incoherence in the names layer
 * (Law 39).
 */
export const LIMITS = {
  ENTRY_NAME: 80,
  LABEL_TEXT: 80,
  SCOPE: 4000,
  DEFINITION_BODY: 8000,
  EDGE_NOTE: 2000,
  REASONING: 4000,
  PROVENANCE_TRACE: 4000,
  PROVENANCE_NOTE: 1000,
  SOURCES_MAX: 20,
  SOURCE_LENGTH: 300,
  /** An attestation's inline record (Amendment 1 as amended). Generous because the POINT is that
   *  the evidence rides WITH the claim — Quarter Machines' PLEX draw record is ~57KB of pool, and
   *  on the chain it could never fit, so it lived at the attester's own endpoint and the anchor
   *  was a hash of something that might one day stop being served. Refused, never truncated: a
   *  clipped record hashes to nothing and would fail its own verification. */
  ATTESTATION_RECORD: 131_072,
  /** Whole-request ceiling, enforced in middleware. Matches systema-chain's express.json limit. */
  BODY_BYTES: 262_144,
} as const

export function tooLong(field: string, value: unknown, max: number): string | null {
  if (typeof value !== "string") return null
  if (value.length <= max) return null
  return `${field} is ${value.length} characters; the limit is ${max}. Say it shorter — the record keeps what you file, exactly as you file it.`
}

export function firstTooLong(checks: Array<[string, unknown, number]>): string | null {
  for (const [f, v, m] of checks) {
    const err = tooLong(f, v, m)
    if (err) return err
  }
  return null
}
