import { createHash } from "crypto"

/**
 * Canonical serialization + hashing. Key-sorted JSON, bigints as decimal strings — the same
 * stable() discipline contentHash uses today, extended for the state's bigint fields. This is
 * consensus-critical: two implementations that serialize differently compute different state
 * hashes from identical states.
 */
function stable(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString()
  if (Array.isArray(v)) return v.map(stable)
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>
    return Object.keys(o)
      .sort()
      .reduce((acc, k) => {
        if (o[k] !== undefined) acc[k] = stable(o[k])
        return acc
      }, {} as Record<string, unknown>)
  }
  return v
}

export const canonical = (v: unknown): string => JSON.stringify(stable(v))

/**
 * THE STATE HASH — canonical, and STABLE AGAINST THE STRUCT GROWING.
 *
 * `hashOf(state)` serializes whatever fields CoreState has TODAY, so the day the struct gained
 * `attestations: {}` every previously-anchored pin stopped reproducing — not because any event
 * changed, but because an empty map appeared in the serialization of every historical state.
 * Found 2026-08-19: both prod pins mismatched while `logHash` was identical, which is exactly
 * the signature of "the record is fine, the hash recipe moved".
 *
 * The fix is to drop EMPTY collections. A field that holds nothing contributes nothing, so a
 * new field is invisible to every state that predates the thing it records, and becomes part of
 * the hash the moment it actually holds something. `{}` and "absent" mean the same thing here —
 * nothing recorded — and the reducer already deletes keys as they empty (releaseName does this
 * explicitly), so the two are not distinguishable state in the first place.
 *
 * Versioned, because this IS a boundary: pins cast under v1 cannot be re-derived under v2, and
 * a verifier must be told which rule to apply rather than left to guess from a mismatch.
 */
export const STATE_HASH_V = 2

const isEmptyCollection = (v: unknown): boolean =>
  v !== null && typeof v === "object" &&
  (Array.isArray(v) ? v.length === 0 : Object.keys(v as object).length === 0)

function stableForState(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString()
  if (Array.isArray(v)) return v.map(stableForState)
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>
    return Object.keys(o)
      .sort()
      .reduce((acc, k) => {
        if (o[k] === undefined) return acc
        const inner = stableForState(o[k])
        if (isEmptyCollection(inner)) return acc // a field holding nothing says nothing
        acc[k] = inner
        return acc
      }, {} as Record<string, unknown>)
  }
  return v
}

/** The hash a checkpoint commits to. Use THIS for pins, never hashOf(state). */
export const stateHashOf = (state: unknown): string => sha256(JSON.stringify(stableForState(state)))
export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex")

/** Fingerprint an ed25519 SPKI key exactly as the sequencer and retired Chain do. */
export const keyFingerprint = (publicKeyB64: string): string =>
  createHash("sha256").update(Buffer.from(publicKeyB64, "base64")).digest("hex")

/** One reserved external-fact profile. It is governance's statement about Systema's own retired
 * infrastructure, so a public guest may not squat its globally unique act id. */
export const CHAIN_TERMINUS_ACT_ID = "systema-chain-archive-terminus-v1"
export const CHAIN_TERMINUS_ACT_HASH = "67de9aa2e96de62ad062a941f55fd394f31ba762f319fa9c7d26bf9d587f517e"
export const hashOf = (v: unknown): string => sha256(canonical(v))

export const ZERO64 = "0".repeat(64)

/** Law 12's blind comparison, as revised by Law 12-ii (2026-08-14): fold case and diacritics
 *  to base letters, keep every Unicode letter and digit, discard the rest. `café` ≡ `cafe`
 *  inside the gate; no script normalizes to nothing. One normalizer, everywhere — the core,
 *  the live gates, and the genesis importer must all call THIS one. */
export const norm = (s: string): string =>
  s.normalize("NFKD").toLowerCase().replace(/\p{M}+/gu, "").replace(/[^\p{L}\p{N}]+/gu, "")

/** Law 12-ii-a — the shape of a canonical name (and of a label's word): letters of any script,
 *  digits, hyphens, and apostrophes; lowercase where the script has case; hyphens/apostrophes
 *  join word-parts, never lead or trail. Returns an error string, or null when well-formed. */
export function nameShapeError(s: string): string | null {
  if (!s) return "a name needs at least one letter"
  // Law 39 / keeper 2026-08-15: a name is a word, not a definition — the 80-char bound is LAW
  // (matches LIMITS.ENTRY_NAME === LABEL_TEXT; kept literal here so canonical stays leaf-level).
  if (s.length > 80) return `a name is a word, not a definition — ${s.length} characters exceeds the 80-character bound (Law 39)`
  if (s !== s.toLowerCase()) return "lowercase where the script has case (Law 12-ii)"
  if (!/^[\p{L}\p{N}]+([-'][\p{L}\p{N}]+)*$/u.test(s)) {
    return "letters of any script, digits, hyphens, and apostrophes only — hyphens join words; spaces and underscores do not enter a new name (Law 12-ii)"
  }
  if (!norm(s)) return "a name must survive normalization (Law 12-ii: no script normalizes to nothing)"
  return null
}
