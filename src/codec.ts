import type { CoreState } from "./core/types"

/**
 * State serialization for the genesis sidecar (`genesis-state.json`).
 *
 * Bigints ride as `{ "$big": "123" }`. The tagging is a MANUAL pre-walk, never a
 * JSON.stringify replacer: Next's server runtime patches stringify to serialize bigints as
 * bare numbers WITHOUT consulting the replacer (found 2026-08-11 — the first staging
 * genesis wrote a sidecar whose bigints had silently become numbers, and the hash check
 * refused it at load, exactly as designed). The walk hands stringify a bigint-free tree,
 * so no runtime's cleverness can reach one. Round-trip preserves hashOf() exactly.
 */
const tag = (v: unknown): unknown => {
  if (typeof v === "bigint") return { $big: v.toString() }
  if (Array.isArray(v)) return v.map(tag)
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (x !== undefined) out[k] = tag(x)
    }
    return out
  }
  return v
}

export const stateToJson = (s: CoreState): string => JSON.stringify(tag(s))

export const stateFromJson = (json: string): CoreState =>
  JSON.parse(json, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v) && typeof (v as Record<string, unknown>).$big === "string"
      ? BigInt((v as Record<string, string>).$big)
      : v,
  ) as CoreState
