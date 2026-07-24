# Harness Engineering — external anthology & what we adopted

A record of a review of Ryan Lopopolo's *Harness Engineering* anthology
(<https://github.com/cwijayasundara/harness-engineering>, default branch `trunk`) — the
field guide behind OpenAI's "harness engineering" article — read against this harness on
`v6-reduction` on 2026-07-24, and the one recommendation we implemented from it.

## What the anthology is

Prose, not tooling: 12 theses (`docs/`), 2 diagnostic playbooks (`playbooks/`), and an
eval method (`evals/`). Its thesis: hold the model + coding agent constant as a black
box; improve the two external levers — **context** and **tools** — so the worker can
*recover intent, operate the real system, respect authority, prove the outcome, and
leave the next run better equipped*. The load-bearing theses for us:

- **Optimize for measured effectiveness** — tokens, lines, agents, and checks are
  *inputs*. Optimize accepted outcomes per unit of scarce **human attention**.
- **Preserve coherence and own lifetime risk** — abundant implementation makes future
  coherence scarce; a control set with many overlapping checks can be *harder* to
  maintain and less safe than a few well-owned boundaries.
- **Improve one harnessed job** (playbook) — `baseline → earliest gap → smallest owning
  intervention → native verification → fresh rerun → retain, revise, or remove`, and
  crucially: *"Test without the intervention when its added value remains unclear."*

## How it maps to this harness

Mostly **validation of the `v6-reduction` direction**, not new machinery. Our
`tools/check-partition.js` ("one rule that holds is worth more than a taxonomy that
doesn't"), the bite ledger (`sensor-outcomes.js`), the value meter
(`sensor-value-report.js`), the canary (`sensor-canary.js`), and the control-budget
ratchet already embody most of the anthology. Importing its structure wholesale would be
accretion — the opposite of the goal.

Genuinely pick-up-able, in priority order:

1. **The withhold-and-rerun subtractive test** (implemented — see below).
2. **De-dup the kernel by "one authoritative owner per invariant"** — the review
   playbook's warning signs (one fact copied across manifests/policy/fixtures/tests;
   overlapping defensive checks; duplicated validation) are a checklist for shrinking the
   kernel further by *merging* controls, not just moving them to packs. Not yet done.
3. **Reframe the effectiveness denominator** as human-relay / review-convergence cycles
   per job, treating control count purely as a cost line. Framing, mostly already tracked
   by loop-health. Not yet done.

## What we implemented: the withhold-and-rerun verdict layer

**The gap.** The bite ledger records whether a control *fired* and *blocked*. The canary
proves a control's detector still *bites a synthetic bad input* (mechanical liveness).
Neither answers the question that authorizes removal: *if this control were absent, would
a **real** representative job degrade?* A gate can be canary-proven-live yet removable —
if no real trajectory ever produces the input it catches, it is carrying cost with no
realized benefit. Only Ryan's withhold-and-rerun disambiguates, and nothing recorded it.

**The mechanism.**

- `.claude/hooks/lib/withhold-verdicts.js` — an append-only verdict ledger
  (`.claude/state/sensor-withhold.jsonl`), one row per experiment: `{ sensor, degraded,
  job, evidence, ts }`. `degraded=true` → withholding degraded a real job → it earns its
  place; `degraded=false` → the job closed unchanged → safe to cut. Unlike the bite
  ledger it is **not** best-effort — an operator-invoked record must fail loud.
- `.claude/scripts/sensor-withhold.js` (`npm run sensor-withhold`) — `record --sensor
  <id> --degraded <true|false> [--job "..."] [--evidence "..."]`, or no args to list.
- `sensor-value-report.js` now reads the latest verdict per control and adds two decisive
  buckets: **REMOVABLE** (withhold showed no degradation — safe to cut) and
  **CONFIRMED-VALUABLE** (withheld → a real job degraded — keep). When an ambiguous
  candidate has no verdict, the report prints the exact `sensor-withhold.js record`
  command to run next.

**The scoping rule that matters.** A verdict reclassifies **only** genuinely-ambiguous
candidates (never-blocked / proven-live). A gate the ledger already proves blocks real
diffs is not shelfware; one no-degradation job must never relabel a live control
"removable" — that is the "instrument says retire a live control" failure the meter was
built to avoid (see the 2026-07-24 value-meter tier-awareness fix).

**Operator loop** (feeds the deferred Phase 5 quarantine sweep with evidence instead of
guesses): run `npm run sensor-value` → pick an ambiguous candidate → withhold it, rerun a
representative job → `npm run sensor-withhold record ...` → the next report shows it as
REMOVABLE or CONFIRMED-VALUABLE. Surfaced in `/retro` alongside the value meter.
