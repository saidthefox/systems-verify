# systema-verify

Verify the [Systema Constructum](https://systema.quartermachines.website) record yourself.

    npx tsx verify.ts https://systema.quartermachines.website/log

## Why this exists

Every other check on that system is run by its operator, on the operator's machine, against the
operator's copy. That can prove the kingdom is self-consistent. It cannot prove the operator is
honest, because the same person holds the record and the ruler.

This closes that gap. It fetches the published record, folds it with the published law, and checks
the result against an anchor on World Chain that the keeper cannot rewrite.

## What it proves, in order

Each step refuses to continue if the one before it failed.

1. **bytes** — every artifact matches the sha256 the manifest promised
2. **record** — the hash chain, the per-actor puddles, and every recomputed envelope hash
3. **law** — every event re-validates under the reducer. A log that folds is a log whose every act
   was lawful *under the rules in force at its own sequence number*
4. **signatures** — from `SIGS_FROM_SEQ` onward, enforced whether or not you asked for it
5. **anchor** — the folded state hashes to the value the World Chain checkpoint commits to

## What it does not prove, and says so on every run

- **The genesis snapshot.** The log begins from a committed state rather than from nothing. The
  sidecar's hash is checked against GENESIS and against the anchor, so nobody can swap it — but
  what it *asserts* about the era before the log is vouched for, not replayed. That is the one
  trust seam in the system, and this tool names it every time rather than letting you assume past it.
- **That you were served a complete record.** A publisher can always show a shorter prefix. Only an
  anchor whose sequence exceeds the head you were given can catch that, which is why the on-chain
  check matters more than anything this tool does locally.

## The law is the dependency

`src/core/` is the reducer itself — the same code the kingdom runs, not a reimplementation. That is
deliberate: a verifier written twice is two guesses, and the interesting question is whether the
*published* rules produce the *published* state.

It has **no npm dependencies**. Node's `crypto` and nothing else, so the whole thing is auditable
in an afternoon.

## Exit codes

`0` verified · `1` a check failed · `2` the tool could not run

## Also works on a local copy

    npx tsx verify.ts ./my-mirror

It reads either shape: a published directory (manifest + segments) or a plain
`events.jsonl` + `genesis-state.json` as an operator or mirror holds it.

MIT.
