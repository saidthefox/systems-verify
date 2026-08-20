# systema-verify

Check the [Systema Constructum](https://systema.quartermachines.website) record yourself, without
trusting the people who keep it.

    git clone https://github.com/saidthefox/systems-verify
    cd systems-verify && npm install
    ./bin/systema-verify https://systema.quartermachines.website/log

## Why this exists

Every other check on that system is run by its operator, on the operator's machine, against the
operator's copy. That can prove the kingdom is self-consistent. It cannot prove the operator is
honest, because the same person holds the record and the ruler.

This closes that. It fetches the published record, folds it with the published law, and compares
the result against a digest held in a **World Chain contract the keeper cannot rewrite**.

## What it proves, in order

Each step refuses to continue if the one before it failed.

1. **bytes** — every artifact matches the sha256 the manifest promised
2. **record** — the hash chain, the per-actor puddles, every recomputed envelope hash
3. **law** — every event re-validates under the reducer. A log that folds is a log whose every act
   was lawful *under the rules in force at its own sequence number*
4. **signatures** — from `SIGS_FROM_SEQ` onward, enforced whether or not you asked for it
5. **anchor** — the folded state's digest is read back **off World Chain** and compared

Step 5 is the one that matters, and it is on by default. The contract address is compiled into
this tool rather than read from the record, because a publisher who could name their own anchor
could anchor anything. Check it once yourself:

- chain: World Chain mainnet (id `480`)
- contract: `0x0EFa83693F6c64683B6E4a601BfB6dcfb6BCc720`
- call: `headAt(<height>)` returns the digest pinned at that height

`--rpc <url>` points at a different node; `--no-chain` skips the network entirely and says so
in the output.

## What it does NOT prove, and says so every run

- **The genesis snapshot.** The log begins from a committed state, not from nothing. Its bytes are
  hash-checked and covered by the pin, so nobody can swap it — but what it *asserts* about the
  pre-log era is vouched for, not replayed. That is the system's one trust seam and it is named
  on every run rather than buried here.
- **That you were served the whole record.** A publisher can always show a shorter prefix. Only an
  anchor whose seq exceeds the head you hold can catch that.

## Three verdicts, not two

| exit | verdict | means |
|---|---|---|
| 0 | `VERIFIED` | the bytes, the record, the law, the signatures and the anchor all hold |
| 1 | `FAILED` | a finding **about the record** |
| 2 | error | the run itself broke (network, bad path) |
| 3 | `INCONCLUSIVE` | **this tool is too old to judge that record** |

The third one exists because this package carries a copy of the kingdom's reducer, and a copy goes
stale on its own: the law gains an event kind, your clone does not have it, and folding stops. That
is a fact about your copy — the kingdom's sequencer accepted the event under a rulebook that knows
the kind — so the tool abstains instead of accusing. **`INCONCLUSIVE` is not a pass**, and no
record can reach `VERIFIED` through it. Fix it with `git pull && npm install`.

This matters more than it sounds. Every other failure mode here is loud and immediate; this one is
silent, arrives on its own schedule, and would otherwise make a correct record look forged to the
exact person who came to check whether it was.

The law in this package hashes to:

    853acc03808baaecdd6c9936e89f8924cefc9bdd416086fe0f80e059ed5cdd1a

Compare that against `pin.codeHash` in any published `manifest.json`. Equal means you hold the
rulebook that computed that pin. **Different is not automatically wrong** — the kingdom's law moves
between pins, and re-deriving the same digest under a different rulebook is a stronger result than
agreement, which the tool will say when it happens.

## This directory is generated

It is built from the main repository by `tools/build-verify-pkg.ts`, which also runs as a guard
(`--check`) that fails when this copy has drifted. Do not edit `src/` or `verify.ts` here — fix
them in the source repository and rebuild, or the two copies of the law start disagreeing again.
That has already happened once: a hand-made copy went stale in four hours and called a healthy
kingdom forged.

MIT.
