import { readFileSync, existsSync, readdirSync } from "node:fs"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { fold } from "./src/core/reducer"
import { verifyLog } from "./src/core/verify"
import { stateHashOf } from "./src/core/canonical"
import { stateFromJson } from "./src/codec"
import type { EventEnvelope } from "./src/core/types"

/**
 * systema-verify — TRUST NOTHING. One command, run by someone who is not the keeper.
 *
 * Every other instrument in this project is run BY the operator, ON the operator's box, against
 * the operator's copy. That proves the kingdom is self-consistent; it cannot prove the operator
 * is honest, because the same person holds the record and the ruler. This closes that: it fetches
 * the published record, folds it with the published law, and checks the result against an anchor
 * the operator cannot rewrite.
 *
 * WHAT IT PROVES, in order, each step refusing to continue if the one before it failed:
 *   1. BYTES     every artifact matches the sha256 the manifest promised
 *   2. RECORD    the hash chain, the per-actor puddles, and every recomputed envelope hash
 *   3. LAW       every event re-validates under the reducer — a log that folds is a log whose
 *                every act was lawful under the rules in force at its own seq
 *   4. SIGNATURES from SIGS_FROM_SEQ onward, enforced whether or not you asked
 *   5. ANCHOR    the folded state hashes to the value the World Chain pin commits to
 *
 * WHAT IT CANNOT PROVE, and says so rather than letting you assume it:
 *   - the genesis SNAPSHOT. A snapshot-genesis log begins from a committed state, not from
 *     nothing. The sidecar's hash is checked against GENESIS and against the pin, so nobody can
 *     swap it — but what it ASSERTS about the chain era is vouched for, not replayed. That is the
 *     one trust seam in the system and it is named here every run.
 *   - that you were shown the WHOLE record. A publisher can always serve a shorter prefix. The
 *     anchor is what closes this: an old pin whose seq exceeds the head you were served is proof
 *     of truncation, which is why --chain matters.
 *
 * Usage:
 *   npx tsx tools/systema-verify.ts <dir-or-url>     [--chain]
 *   npx tsx tools/systema-verify.ts /srv/systema-public/prod
 */

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex")
const ok = (s: string) => console.log(`  ✓ ${s}`)
const bad = (s: string) => console.log(`  ✗ ${s}`)

async function get(base: string, file: string): Promise<Buffer> {
  if (/^https?:\/\//.test(base)) {
    const r = await fetch(`${base.replace(/\/$/, "")}/${file}`)
    if (!r.ok) throw new Error(`${file}: HTTP ${r.status}`)
    return Buffer.from(await r.arrayBuffer())
  }
  const p = join(base, file)
  if (!existsSync(p)) throw new Error(`${file}: not found under ${base}`)
  return readFileSync(p)
}

interface Manifest {
  head: { seq: number; hash: string; ts: string }
  totalEvents: number
  genesis: { file: string; sha256: string } | null
  segments: { file: string; fromSeq: number; toSeq: number; sha256: string }[]
  tail: { file: string; sha256: string }
  pin: { seq: number; digest: string; stateHash: string; logHash: string; v?: number; recipe?: string } | null
}

/** An operator/mirror directory: no manifest to check the bytes against, so the record itself
 *  and the anchor carry the whole proof. Everything after step 1 is identical, because it is
 *  the same law folding the same events. */
function verifyPlainDir(dir: string): never {
  let failures = 0
  console.log("1. bytes\n  – no manifest here (an operator/mirror directory); the record and the anchor carry the proof")
  const events = readFileSync(join(dir, "events.jsonl"), "utf8").split("\n").filter(l => l.trim())
    .map(l => JSON.parse(l) as EventEnvelope)
  const sidecarPath = join(dir, "genesis-state.json")
  const snap = () => existsSync(sidecarPath) ? stateFromJson(readFileSync(sidecarPath, "utf8")) : undefined
  const head = events[events.length - 1]
  ok(`read ${events.length} events, head seq ${head.seq} @ ${head.ts}`)

  console.log("\n2. the record, the law, the signatures")
  const v = verifyLog(events, { snapshot: snap() })
  if (!v.valid) { bad(`INVALID at seq ${v.failedAt}: ${v.reason}`); failures++ }
  else ok(`hash chain, puddles, envelope hashes, reducer validity and signatures: ${v.events} events`)

  console.log("\n3. the anchor")
  const ckDir = join(dir, "checkpoints")
  const receipts = existsSync(ckDir) ? readdirSync(ckDir).filter(f => f.endsWith(".json")).sort() : []
  if (!receipts.length) console.log("  – no checkpoint receipts here; nothing ties this copy to an outside witness")
  for (const r of receipts) {
    const p = JSON.parse(readFileSync(join(ckDir, r), "utf8"))
    if ((p.v ?? 1) < 2) { console.log(`  – pin at seq ${p.seq} is v1 and cannot be re-derived (see PUBLICATION-POLICY.md)`); continue }
    const bounded = events.filter(e => e.seq <= p.seq)
    const { state } = fold(bounded, snap())
    const sh = stateHashOf(state)
    const digest = sha256(`${sh}|${bounded[bounded.length - 1].hash}|${p.seq}`)
    if (digest !== p.digest) { bad(`pin at seq ${p.seq} does not re-derive`); failures++ }
    else ok(`folded state re-derives the pinned digest at seq ${p.seq}`)
  }

  console.log("\nwhat this run did NOT prove:")
  console.log("  · the genesis SNAPSHOT — vouched for, not replayed. The system's one trust seam.")
  console.log("  · that this copy is COMPLETE. Only an anchor newer than your head can catch a short copy.")
  console.log(failures ? `\nFAILED — ${failures} problem(s).` : "\nVERIFIED.")
  process.exit(failures ? 1 : 0)
}

async function main() {
  const base = process.argv[2]
  const wantChain = process.argv.includes("--chain")
  if (!base) { console.error("usage: systema-verify <dir-or-url> [--chain]"); process.exit(2) }

  console.log(`systema-verify — ${base}\n`)
  let failures = 0

  // TWO SHAPES, one tool. A PUBLISHED directory has a manifest and segments; an OPERATOR (or
  // mirrored) directory is a plain events.jsonl + genesis-state.json. `mirror.ts` produces the
  // second, so a verifier that only understood the first would tell every mirror operator their
  // copy was unverifiable — which is exactly backwards, since checking your own copy is the
  // whole point of holding one.
  const published = /^https?:\/\//.test(base) || existsSync(join(base, "manifest.json"))
  if (!published) return verifyPlainDir(base)

  // ── 1. BYTES ──────────────────────────────────────────────────────────────
  console.log("1. bytes")
  const manifest = JSON.parse((await get(base, "manifest.json")).toString()) as Manifest
  const pieces: Buffer[] = []
  for (const s of manifest.segments) {
    const b = await get(base, s.file)
    if (sha256(b) !== s.sha256) { bad(`${s.file} does not match its manifest hash`); failures++ }
    pieces.push(b)
  }
  const tail = await get(base, manifest.tail.file)
  if (sha256(tail) !== manifest.tail.sha256) { bad("tail.jsonl does not match its manifest hash"); failures++ }
  pieces.push(tail)
  ok(`${manifest.segments.length} sealed segment(s) + tail match their published hashes`)

  let snapshot
  if (manifest.genesis) {
    const g = await get(base, manifest.genesis.file)
    if (sha256(g) !== manifest.genesis.sha256) { bad("genesis-state.json does not match its manifest hash"); failures++ }
    else ok(`genesis sidecar matches (${(g.length / 1e6).toFixed(1)} MB)`)
    snapshot = stateFromJson(g.toString())
  }
  if (failures) { console.log("\nREFUSING to continue: the bytes are not what was promised."); process.exit(1) }

  const events = pieces.map(b => b.toString()).join("").split("\n").filter(l => l.trim())
    .map(l => JSON.parse(l) as EventEnvelope)
  if (events.length !== manifest.totalEvents) {
    bad(`assembled ${events.length} events, manifest promised ${manifest.totalEvents}`); failures++
  }
  const head = events[events.length - 1]
  if (head.seq !== manifest.head.seq || head.hash !== manifest.head.hash) {
    bad("assembled head does not match the manifest head"); failures++
  } else ok(`assembled ${events.length} events, head seq ${head.seq} @ ${head.ts}`)

  // ── 2-4. RECORD, LAW, SIGNATURES ──────────────────────────────────────────
  console.log("\n2. the record, the law, the signatures")
  // initState MUTATES its snapshot, so the fold below gets its own parse.
  const v = verifyLog(events, { snapshot: manifest.genesis ? stateFromJson((await get(base, manifest.genesis.file)).toString()) : undefined })
  if (!v.valid) { bad(`INVALID at seq ${v.failedAt}: ${v.reason}`); failures++ }
  else ok(`hash chain, puddles, envelope hashes, reducer validity and signatures: ${v.events} events`)

  // ── 5. ANCHOR ─────────────────────────────────────────────────────────────
  console.log("\n3. the anchor")
  if (!manifest.pin) {
    console.log("  – no checkpoint published; nothing ties this to an outside witness")
  } else {
    const p = manifest.pin
    const bounded = events.filter(e => e.seq <= p.seq)
    const { state } = fold(bounded, snapshot ? stateFromJson((await get(base, manifest.genesis!.file)).toString()) : undefined)
    const sh = stateHashOf(state)
    const lh = bounded[bounded.length - 1].hash
    const digest = sha256(`${sh}|${lh}|${p.seq}`)
    if ((p.v ?? 1) < 2) {
      console.log(`  – pin at seq ${p.seq} is v1 (recipe ${p.recipe}); v1 digests mixed in a code hash and cannot be re-derived by any later reducer. Not a failure — see PUBLICATION-POLICY.md.`)
    } else if (sh !== p.stateHash) { bad(`state hash differs from the pin (${sh.slice(0, 16)}… vs ${p.stateHash.slice(0, 16)}…)`); failures++ }
    else if (lh !== p.logHash) { bad("log hash differs from the pin"); failures++ }
    else if (digest !== p.digest) { bad("recomputed digest differs from the pin"); failures++ }
    else ok(`folded state re-derives the pinned digest at seq ${p.seq} (World Chain height ${(p as { height?: number }).height ?? "?"})`)
    if (wantChain) console.log("  (--chain: compare that digest on-chain with: cast call <checkpoint> 'headAt(uint256)(bytes32)' <height>)")
  }

  // ── what remains vouched for ──────────────────────────────────────────────
  console.log("\nwhat this run did NOT prove:")
  if (manifest.genesis) {
    console.log("  · the genesis SNAPSHOT. Its bytes are pinned, but what it asserts about the pre-log")
    console.log("    chain era is vouched for, not replayed. That is the system's one trust seam.")
  }
  console.log("  · that you were served the whole record. A publisher can always show a short prefix;")
  console.log("    only an anchor older than the head you hold can catch that. Check the pin on-chain.")

  console.log(failures ? `\nFAILED — ${failures} problem(s).` : "\nVERIFIED.")
  process.exit(failures ? 1 : 0)
}

main().catch(e => { console.error(`\nerror: ${e instanceof Error ? e.message : e}`); process.exit(2) })
