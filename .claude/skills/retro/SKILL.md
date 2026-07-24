---
name: retro
description: Review this harness's own recent loop-health signals and recommend scored, evidence-backed improvements to the harness itself (skills, gates, sensors, CLAUDE.md rules) — never to product code. Use after a `/auto`/`/gate` run, on a drift cadence, or on demand when the loop feels off. Interactive-only — recommends and records human decisions; does not apply anything.
argument-hint: "[--root DIR] [--apply-decisions]"
context: fork
---

# /retro — harness self-improvement recommender

Phase A step 2 of the agentic-flywheel evolution (`docs/agentic-flywheel-design.md`
§4.2). This is the harness's own "agent reviews the results and recommends
improvements to the harness" loop — Kief Morris's distinguishing mechanic
between *humans on the loop* and *the agentic flywheel*. At this stage the
loop is **interactive only**: `/retro` drafts scored recommendations and
records the human's decision on each. It never edits a skill, gate, sensor,
or `CLAUDE.md` itself — implementing an approved recommendation is a normal
follow-up task through the harness's existing escalation ladder (`/vibe` for
a small change, `/change` for anything touching more than a few files).
Promotion-as-PR (§4.3) and auto-approval (§4.5) are later phases, not built.

> **Effort:** run at `high`. This is evidence-grounded judgment over a small,
> already-condensed input set — not broad multi-file coding — so there is
> little to gain from `xhigh`/ultracode fan-out.

---

## Usage

```
/retro
/retro --root /path/to/project
/retro --apply-decisions
```

Without `--apply-decisions`, the skill only drafts new recommendations and
shows them for review. With `--apply-decisions`, it also walks any existing
`proposed` recommendations and records the human's approve/defer/reject
answer for each before drafting new ones.

## What this skill reads (report-only inputs — never modified)

- `specs/retro/loop-health.json` / `.md` — the condensed scorecard (`npm run
  loop-health`, `docs/agentic-flywheel-design.md` §4.1). Regenerate it first
  if missing or older than the current session's telemetry.
- `.claude/state/learned-rules.md` and `.claude/state/process-rules.md` —
  monotonic rule stores; a rule that keeps recurring across scorecards is
  itself evidence for a recommendation (e.g. "promote this to CLAUDE.md").
- `specs/drift/flake-history.md` — quarantine/flake trend.
- `harness-manifest.json` / `HARNESS.md` — to check whether a proposed target
  (a gate, sensor, guide) already exists and how it's currently wired, so a
  recommendation references the real file, not an invented one.
- `npm run sensor-value` — the biting-meta value meter: commit gates that never
  fire or never block over run history (candidate shelfware to retire). Below
  its data floor it prints INSUFFICIENT DATA; treat that as "no removal
  evidence yet", not "everything is earning its keep".
- `npm run sensor-comprehension-debt` — the merged-but-unread STOCK meter:
  reads `.claude/state/merge-provenance.jsonl`, keeps the `human_reviewed:false`
  (auto-merged) rows, and ranks them by dependents × security-boundary. A high
  total or a heavy top entry is evidence for a recommendation to schedule a
  human read-through of that unread code, not a control change. An empty ledger
  or a missing `code-graph.json` prints a note; treat that as "no stock
  evidence yet", not "no dark factory".
- `npm run control-budget -- --check` — the harness's own control-count ratchet
  (`HARNESS.md` → *The control budget*). Reports whether the registered-control
  count is at/over baseline. This is the *subtractive* counter-force: `/retro`
  is the venue where removals get proposed, not just additions.

## What this skill writes

- `specs/retro/recommendations.jsonl` — appends new entries; never rewrites
  or deletes prior ones (mirrors the monotonic-memory convention of
  `learned-rules.md`). Existing entries' `status` field may be updated in
  place when `--apply-decisions` records a human decision.

---

<execution_steps>

### Step 1 — Ensure the scorecard is current

Run `npm run loop-health` (or `node .claude/scripts/loop-health.js --root
<root>`) so `specs/retro/loop-health.json` reflects the current state before
you reason about it. Read the resulting `.md` for the human-readable form.

### Step 2 — Read supporting evidence

Read `learned-rules.md`, `process-rules.md`, `specs/drift/flake-history.md`
(if present), and the existing `specs/retro/recommendations.jsonl` (if
present, so you don't re-propose something already `proposed` or
`rejected` with the same evidence).

Also run `npm run sensor-value` and `npm run control-budget -- --check`. A gate
the value meter reports as **never-blocked** over a real run window is concrete
evidence for a *removal* recommendation (`class: docs` or a manifest edit to
retire it) — the flywheel must propose subtractions, not only additions, or the
control surface only ever grows. When you draft such a removal, cite the
sensor-value line as `evidence`.

### Step 3 — Draft recommendations (report everything, let the human filter)

For each concrete, evidence-backed opportunity to improve the harness, draft
one recommendation. Your job here is coverage, not pre-filtering — write down
every plausible one with an honest `confidence` and `risk`, and let the human
(and, later, the scored-auto-approval gate in §4.5) decide what to act on.
Do not silently drop a low-confidence idea; record it at low confidence
instead.

Emit a recommendation **when** a scorecard observation, a recurring failure
category, or a rule that keeps reappearing across runs points to a specific,
nameable harness change — not for every scorecard line, and not as a
restatement of a note the scorecard already prints verbatim.

Each recommendation is one JSON object:

```json
{
  "id": "REC-<YYYYMMDD>-<3-digit-seq>",
  "target": "skill:auto | gate:cycle-gate | sensor:loop-health | rule:learned-rules | manifest | claude-md | <specific file path>",
  "change": "One paragraph: the concrete change, not the problem restated.",
  "class": "docs | sensor-tune | gate-tighten | rule-add | prompt-edit | gate-loosen | security",
  "risk": "low | med | high",
  "cost": "low | med | high",
  "benefit": "low | med | high",
  "confidence": 0.0,
  "evidence": ["specs/retro/loop-health.md#observations", "or a file:line, or a run-id"],
  "status": "proposed",
  "human_gate": true
}
```

`human_gate: true` is **required** whenever `class` is `gate-loosen` or
`security` — `validate-recommendations.js` rejects it otherwise. This is a
deliberate, permanent invariant (design doc §4.5): the flywheel must never be
able to score or auto-approve its own way past a guardrail, even after
Phase C ships. Every other class may omit `human_gate` (it defaults to
human review anyway at this stage — the field exists to make the *permanent*
exception structurally undeniable, not to mark the common case).

<example>
Good — specific, evidence-backed, correctly classed:
```json
{
  "id": "REC-20260713-001",
  "target": "sensor:loop-health",
  "change": "Lower the tool-error-rate attention line in deriveNotes() from 10% to 5%, since this repo's baseline window has run at 0% for the observed period.",
  "class": "sensor-tune",
  "risk": "low", "cost": "low", "benefit": "med", "confidence": 0.6,
  "evidence": ["specs/retro/loop-health.md#signals", ".claude/hooks/lib/loop-health.js:83"],
  "status": "proposed"
}
```

Bad — vague, no file evidence, would be rejected on review:
```json
{ "id": "REC-2", "target": "the harness", "change": "make it better",
  "class": "docs", "risk": "low", "cost": "low", "benefit": "high",
  "confidence": 0.9, "evidence": ["general sense"], "status": "proposed" }
```
</example>

### Step 4 — Validate before presenting

Append the drafted entries to `specs/retro/recommendations.jsonl`, then run
`npm run validate-recommendations`. If it reports errors, fix the offending
entries and re-run — do not present malformed recommendations to the human.

### Step 5 — Present for interactive review

**If Step 3 drafted zero new recommendations, stay silent** — print one line
("loop-health: no new recommendations this run") and stop. Do not produce a
review prompt when there is nothing to review; `/retro` is auto-invoked at
the end of every `/auto` session (SECTION 11), and a review prompt on every
quiet run trains the human to stop reading them.

Otherwise, show each new recommendation's `target`, `change`, `class`, and
scores in a short table. State plainly that nothing has been applied. Ask
which recommendations to approve, defer, or reject; for anything approved,
name the follow-up route (`/vibe` for a single small file, `/change` for a
broader edit) rather than making the edit yourself in this skill.

### Step 6 — Record decisions (`--apply-decisions` only)

Update the `status` field of each recommendation the human ruled on
(`approved` / `deferred` / `rejected`) in place in
`specs/retro/recommendations.jsonl`. Re-run `npm run
validate-recommendations` to confirm the file is still well-formed.

</execution_steps>

---

## Relationship to other harness surfaces

- **`/agent-readiness`** answers "how mature is this codebase's control
  system" as a standing snapshot. **`loop-health`** (§4.1) answers "what did
  recent runs actually look like." **`/retro`** is the only one of the three
  that exercises judgment and proposes change — the other two are pure
  aggregation.
- **`review-on-stop.js`** (the Stop hook) already nudges toward rule
  promotion at ≥10 learned rules; `/retro` supersedes that nudge with
  evidence-scored, reviewable recommendations, but does not replace the hook.
- This skill never touches product code in a scaffolded target project — its
  `target` values name harness surfaces (skills, gates, sensors, `CLAUDE.md`)
  only. A recommendation about product code belongs in `/change` or
  `/refactor`, not here.
