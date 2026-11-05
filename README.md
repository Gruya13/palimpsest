# Palimpsest

**A proof-carrying development environment.** Every change — code or knowledge —
carries executable evidence bound to a frozen git revision. The same evidence
engine validates both domains: code and knowledge.

> **Name.** A palimpsest is a manuscript with older text erased and overwritten,
> while the old layers remain visible. Palimpsest does not delete experience — it
> rewrites it into knowledge, and the trace remains.

## What it is

Palimpsest is an architecture (and a working Node.js implementation) for projects
worked on by multiple AI agents and humans. Instead of trusting claims, the system
*executes* evidence and gates transitions on it:

- **Evidence envelope** — a canonical JSON document (`claims`, `checks`, `author`,
  `verifier`, `revision`) that binds every `ok` verdict to a frozen revision and
  to an artifact hash.
- **Board** — a task board whose `verified` gate checks evidence validity,
  revisions, independence of the verifier, and reproducibility of execution.
- **Memory** — a versioned knowledge store in which each record is bound to a
  revision and a falsifier; changed code marks dependent records `stale`.
- **Filter** — five gates that decide whether a candidate record may enter the
  worker-visible channel (`MEMORY.md`).
- **Dreams** — a deterministic compiler (NREM) and a non-binding LLM pass (REM):
  raw dreams are never stored, only validated interpretations.
- **Control layer** — leases, isolated worktrees, attestation of execution, and
  gated integration into `main`.
- **Ingest** — raw sources become candidate records through a source proof.

## Principles

1. No model verifies its own work; independence is computed from
   `{vendor, thread, model}` and enforced by a gate.
2. Only the control layer changes `main`; workers write in isolated worktrees.
3. One writer per worktree; write zones are orthogonal and protected.
4. Evidence, not claims: an unexecuted check is `unexecuted` and blocks; a fake
   `ok` without an artifact is rejected; a proof is re-executed before integration.
5. Evidence is bound to a frozen revision and must be reproducible in a fresh clone.
6. Knowledge has an expiry: when the code changes, dependent records become
   `stale` and leave the channel.
7. Uncertainty is a first-class outcome: open questions have an owner, a deadline
   and escalation.

## Quick look (API)

```js
import { runCommand } from "./src/evidence/run.mjs";
import { checkEnvelope } from "./src/evidence/check.mjs";

// execute a command at a frozen revision and build an envelope
const run = await runCommand({ repo, revision, argv: [process.execPath, "--test"] });
// → { verdict: "ok", exitCode: 0, outputSha256, command, durationMs, executedAt }

// verify an envelope against its revision
const result = checkEnvelope(proofPath, { repo, at: revision });
// → { status: "ok" } | { status: "unproven" | "stale" | "changed", reasons }
```

Other modules:

| Module | Role |
|---|---|
| `src/evidence/` | envelope, run, check, stale, lock, independence, attestation, verification |
| `src/board/` | task board and the `verified` gate |
| `src/memory/` | record store, `MEMORY.md` channel, deadline/escalation |
| `src/san/` | NREM/REM dreams, falsifiers, interpretations, proposals, archive, trace |
| `src/filter/` | five-gate knowledge filter |
| `src/control/` | lease, worktree, integration, reproduction |
| `src/ingest/` | raw source → source proof → candidate record |
| `src/budnost/` | wakefulness index and cycle |

## Status

The executable core (`src/`) is complete and self-contained (Node.js >= 20, ESM,
no runtime dependencies). This public repository contains the engine. The
project's internal documentation, test suites and proof-carrying development
process are not part of this distribution.

## License

MIT — see [LICENSE](LICENSE).
