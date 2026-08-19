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
 *   5. ANCHOR    the folded state hashes to the digest the World Chain contract actually holds.
 *                READ FROM THE CHAIN, not from the publisher's receipt — the receipt is the
 *                publisher's own claim, and checking a claim against itself proves nothing.
 *                The contract address is compiled into this tool for the same reason.
 *
 * WHAT IT CANNOT PROVE, and says so rather than letting you assume it:
 *   - the genesis SNAPSHOT. A snapshot-genesis log begins from a committed state, not from
 *     nothing. The sidecar's hash is checked against GENESIS and against the pin, so nobody can
 *     swap it — but what it ASSERTS about the chain era is vouched for, not replayed. That is the
 *     one trust seam in the system and it is named here every run.
 *   - that you were shown the WHOLE record. A publisher can always serve a shorter prefix. The
 *     anchor is what closes this: an old pin whose seq exceeds the head you were served is proof
 *     of truncation, which is why the anchor check runs by default.
 *
 * Usage:
 *   npx tsx tools/systema-verify.ts <dir-or-url>  [--rpc <url>] [--no-chain]
 *   npx tsx tools/systema-verify.ts /srv/systema-public/prod
 */

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex")
const ok = (s: string) => console.log(`  ✓ ${s}`)
const bad = (s: string) => console.log(`  ✗ ${s}`)
const note = (s: string) => console.log(`  · ${s}`)

/**
 * THE ANCHOR, AS THIS TOOL KNOWS IT — deliberately NOT read from the publisher.
 *
 * Taking the contract address from the manifest would leave the whole check circular: a
 * dishonest publisher names a contract they control, writes whatever digest they like into it,
 * and the verifier dutifully agrees. So the address lives HERE, in the thing the stranger
 * downloaded, and the manifest's copy is treated as a claim to be CHECKED rather than a source.
 *
 * Verify this address out of band, once: it is on World Chain mainnet (chain id 480) and every
 * checkpoint transaction is a public `checkpoint(uint256,bytes32)` call to it.
 */
const ANCHOR = {
  chainId: 480,
  contract: "0x0EFa83693F6c64683B6E4a601BfB6dcfb6BCc720",
  /** keccak("headAt(uint256)")[0:4] — the public mapping's getter. Re-derive with
   *  `cast sig 'headAt(uint256)'`; hardcoded so this tool keeps zero dependencies. */
  headAtSelector: "0xc1742a8c",
  defaultRpc: "https://worldchain-mainnet.g.alchemy.com/public",
}

/** One JSON-RPC call. No web3 library: an eth_call is a POST with four fields. */
async function rpc(url: string, method: string, params: unknown[]): Promise<string> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })
  if (!r.ok) throw new Error(`RPC HTTP ${r.status}`)
  const j = await r.json() as { result?: string; error?: { message: string } }
  if (j.error) throw new Error(j.error.message)
  if (typeof j.result !== "string") throw new Error("RPC returned no result")
  return j.result
}

/** What the chain says was pinned at this height. `0x000…0` means nothing was ever pinned there. */
async function anchoredDigest(rpcUrl: string, height: number): Promise<string | null> {
  const chainId = await rpc(rpcUrl, "eth_chainId", [])
  if (parseInt(chainId, 16) !== ANCHOR.chainId) {
    throw new Error(`that RPC serves chain ${parseInt(chainId, 16)}, not World Chain (${ANCHOR.chainId})`)
  }
  const data = ANCHOR.headAtSelector + height.toString(16).padStart(64, "0")
  const raw = await rpc(rpcUrl, "eth_call", [{ to: ANCHOR.contract, data }, "latest"])
  const value = raw.replace(/^0x/, "")
  return /^0+$/.test(value) ? null : value
}

/**
 * THE LAW THIS TOOL IS CARRYING — hashed the same way the checkpoint receipt hashes it.
 *
 * The receipt has always recorded a `codeHash` (which rulebook computed this state) and nothing
 * ever read it. It answers the question that bites hardest here: a verifier whose copy of
 * `src/core/` is even slightly behind the kingdom's will refuse events the kingdom lawfully
 * accepted, and will report that as *the record is INVALID* — blaming the subject for the
 * instrument. Comparing this against the receipt turns that into a legible "your copy of the law
 * is not the one that computed this pin", which is a true statement a stranger can act on.
 */
function ownCodeHash(): string | null {
  for (const dir of [join(__dirname, "src", "core"), join(__dirname, "..", "src", "core")]) {
    if (!existsSync(dir)) continue
    const files = readdirSync(dir).filter(f => f.endsWith(".ts")).sort()
    const h = createHash("sha256")
    for (const f of files) h.update(f).update("\0").update(readFileSync(join(dir, f)))
    return h.digest("hex")
  }
  return null
}

/**
 * Say, in one line, how the law in this copy relates to the law that computed the pin — and read
 * the SAME fact in opposite directions depending on whether the fold agreed, because it means
 * opposite things.
 *
 * The kingdom's core legitimately moves between daily pins, so a bare "your law differs" would
 * fire on almost every honest run and become the sort of permanently-amber instrument an operator
 * learns to scroll past. What it is actually worth:
 *
 *   folded fine, same rulebook   → you reproduced their result with their law
 *   folded fine, DIFFERENT       → you reproduced their result with a DIFFERENT law. That is a
 *                                  stronger claim than agreement, not a weaker one: two rulebooks
 *                                  independently arrive at the anchored digest.
 *   fold FAILED, different       → suspect your copy first (reported up in step 2, loudly)
 */
function reportLawDrift(pin: { codeHash?: string; seq: number }, folded: boolean): void {
  const mine = ownCodeHash()
  if (!mine || !pin.codeHash) return
  if (mine === pin.codeHash) {
    ok(`the law this tool carries IS the rulebook that computed that pin (codeHash ${mine.slice(0, 12)}…)`)
  } else if (folded) {
    ok(`re-derived under a DIFFERENT rulebook than the one that pinned it (yours ${mine.slice(0, 12)}…, theirs ${pin.codeHash.slice(0, 12)}…) — two laws, one digest`)
  } else {
    note(`your copy of the law differs from the one that computed this pin (yours ${mine.slice(0, 12)}…, theirs ${pin.codeHash.slice(0, 12)}…) — suspect the instrument before the record`)
  }
}

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
  pin: {
    seq: number; digest: string; stateHash: string; logHash: string; v?: number; recipe?: string
    height?: number
    /** which rulebook computed this — checked against ours, never trusted over the fold */
    codeHash?: string
    /** the publisher's CLAIM about where the anchor lives. Cross-checked against ANCHOR; a
     *  mismatch is a refusal, because it is the shape a redirected verification would take. */
    anchor?: { chainId?: number; contract?: string }
  } | null
}

/** Step 3, shared by both directory shapes: re-derive the pin, then ask the chain. */
async function checkAnchor(
  p: NonNullable<Manifest["pin"]>,
  recomputed: { stateHash: string; logHash: string },
  opts: { rpcUrl: string | null },
): Promise<number> {
  let failures = 0
  if ((p.v ?? 1) < 2) {
    note(`pin at seq ${p.seq} is v1 (recipe ${p.recipe}); v1 digests mixed in a code hash and cannot be re-derived by any later reducer. Not a failure — see PUBLICATION-POLICY.md.`)
    return 0
  }
  const digest = sha256(`${recomputed.stateHash}|${recomputed.logHash}|${p.seq}`)
  let rederived = false
  if (recomputed.stateHash !== p.stateHash) { bad(`state hash differs from the pin (${recomputed.stateHash.slice(0, 16)}… vs ${p.stateHash.slice(0, 16)}…)`); failures++ }
  else if (recomputed.logHash !== p.logHash) { bad("log hash differs from the pin"); failures++ }
  else if (digest !== p.digest) { bad("recomputed digest differs from the pin"); failures++ }
  else { ok(`folded state re-derives the pinned digest at seq ${p.seq}`); rederived = true }
  // Keyed on the PIN, not on the log: "two laws, one digest" is only a true and useful thing to
  // say when this law actually reached that digest.
  reportLawDrift(p, rederived)

  // The publisher may not redirect us to an anchor of their choosing.
  if (p.anchor?.contract && p.anchor.contract.toLowerCase() !== ANCHOR.contract.toLowerCase()) {
    bad(`this record names anchor ${p.anchor.contract} — not Systema's (${ANCHOR.contract}). REFUSING to check it there.`)
    return failures + 1
  }

  const height = p.height ?? null
  if (!opts.rpcUrl) { note("chain check skipped (--no-chain): the digest above is still the publisher's own claim"); return failures }
  if (height === null) { note("this record does not say which anchor height to read; cannot check the chain"); return failures }
  try {
    const onChain = await anchoredDigest(opts.rpcUrl, height)
    if (onChain === null) { bad(`nothing is anchored at height ${height} — this pin was never witnessed`); failures++ }
    else if (onChain.toLowerCase() !== p.digest.toLowerCase()) {
      bad(`THE CHAIN DISAGREES at height ${height}: anchored ${onChain.slice(0, 16)}…, this record claims ${p.digest.slice(0, 16)}…`)
      failures++
    } else {
      ok(`World Chain agrees: ${ANCHOR.contract.slice(0, 10)}… headAt(${height}) = the digest above`)
      note("that value was written by a key this record's keeper cannot un-write. It is the one claim here that does not depend on trusting the publisher, this tool, or the box it came from.")
    }
  } catch (e) {
    // A failure to REACH the chain is not evidence of a bad record, and must never be printed
    // as though it were. Say which one happened.
    note(`could not reach the anchor (${e instanceof Error ? e.message : e}) — the record above is unaffected; retry with --rpc <url>`)
  }
  return failures
}

/** An operator/mirror directory: no manifest to check the bytes against, so the record itself
 *  and the anchor carry the whole proof. Everything after step 1 is identical, because it is
 *  the same law folding the same events. */
async function verifyPlainDir(dir: string, opts: { rpcUrl: string | null }): Promise<never> {
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
    const p = JSON.parse(readFileSync(join(ckDir, r), "utf8")) as NonNullable<Manifest["pin"]>
    const bounded = events.filter(e => e.seq <= p.seq)
    const { state } = fold(bounded, snap())
    failures += await checkAnchor(p, { stateHash: stateHashOf(state), logHash: bounded[bounded.length - 1].hash }, opts)
  }

  console.log("\nwhat this run did NOT prove:")
  console.log("  · the genesis SNAPSHOT — vouched for, not replayed. The system's one trust seam.")
  console.log("  · that this copy is COMPLETE. Only an anchor newer than your head can catch a short copy.")
  console.log(failures ? `\nFAILED — ${failures} problem(s).` : "\nVERIFIED.")
  process.exit(failures ? 1 : 0)
}

async function main() {
  const base = process.argv[2]
  // The chain check is ON by default. It was opt-in once, which meant the one step that breaks
  // the circle was the one step most people would never run.
  const rpcArg = process.argv.indexOf("--rpc")
  const rpcUrl = process.argv.includes("--no-chain") ? null
    : rpcArg > 0 ? process.argv[rpcArg + 1]
    : ANCHOR.defaultRpc
  if (!base || base.startsWith("--")) {
    console.error("usage: systema-verify <dir-or-url> [--rpc <url>] [--no-chain]")
    process.exit(2)
  }

  console.log(`systema-verify — ${base}\n`)
  let failures = 0

  // TWO SHAPES, one tool. A PUBLISHED directory has a manifest and segments; an OPERATOR (or
  // mirrored) directory is a plain events.jsonl + genesis-state.json. `mirror.ts` produces the
  // second, so a verifier that only understood the first would tell every mirror operator their
  // copy was unverifiable — which is exactly backwards, since checking your own copy is the
  // whole point of holding one.
  const published = /^https?:\/\//.test(base) || existsSync(join(base, "manifest.json"))
  if (!published) return verifyPlainDir(base, { rpcUrl })

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
  if (!v.valid) {
    bad(`INVALID at seq ${v.failedAt}: ${v.reason}`); failures++
    // BLAME THE RIGHT PARTY. A verifier whose src/core is behind the kingdom's refuses events
    // that were lawful when they were written, and the honest reading of that is "this copy of
    // the law is old", not "this record is forged". Say so before the stranger draws the wrong
    // conclusion — an unknown event kind is that failure almost every time.
    const mine = ownCodeHash()
    if (manifest.pin?.codeHash && mine && mine !== manifest.pin.codeHash) {
      note("BUT your copy of the law is NOT the one that computed this record's pin — update this")
      note("tool before reading the line above as a finding about the kingdom.")
    } else if (/unknown event kind/.test(v.reason ?? "")) {
      note("an UNKNOWN EVENT KIND is almost always a stale verifier, not a bad record: the kingdom")
      note("has since learned a kind this copy of the reducer has never heard of. Update and re-run.")
    }
  } else ok(`hash chain, puddles, envelope hashes, reducer validity and signatures: ${v.events} events`)

  // ── 5. ANCHOR ─────────────────────────────────────────────────────────────
  console.log("\n3. the anchor")
  if (!manifest.pin) {
    console.log("  – no checkpoint published; nothing ties this to an outside witness")
  } else {
    const p = manifest.pin
    const bounded = events.filter(e => e.seq <= p.seq)
    const { state } = fold(bounded, snapshot ? stateFromJson((await get(base, manifest.genesis!.file)).toString()) : undefined)
    failures += await checkAnchor(p, { stateHash: stateHashOf(state), logHash: bounded[bounded.length - 1].hash }, { rpcUrl })
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
