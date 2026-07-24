# SAME-INVARIANT overlap de-dup audit — operator runbook

Periodic harness-maintenance pass that finds controls guarding the **same invariant**
so they can be merged (the one-owner-per-invariant work behind the v6 reduction). It is
**operator tooling, not a control** — nothing here is in `harness-manifest.json`, so it
never touches the control-budget ratchet. You do not add a control in order to remove
controls.

The audit has two halves that compose:

- a **deterministic pre-pass** (`tools/overlap-candidates.js`) that ranks candidate
  pairs cheaply from the manifest, so the LLM agents adjudicate a short list instead of
  full-scanning each axis (~30–70k tokens/axis saved); and
- a **full-scan backstop** — the four read-only audit agents actually reading source —
  which is what catches a same-invariant pair the pre-pass could not cluster. The
  pre-pass only *ranks*; it can only narrow recall, so the backstop must still run on a
  cadence and sweep the residual.

## Cadence

Run the full backstop when `--stale` reports controls added since the last full audit,
or on a fixed cadence — e.g. `/schedule` a monthly `node tools/overlap-candidates.js
--stale` and run the full audit when it lists anything. There is deliberately no
manifest-registered sensor: a `cadence: drift` entry here would not be invoked by
`drift-report.js` (which only reads the code-graph), so it would be documentation, not
a live signal. `/schedule` is the honest driver.

## Procedure

1. **Check staleness.** `node tools/overlap-candidates.js --stale`
   Lists controls added since the last full audit. No marker yet ⇒ everything is stale
   (first run is a signal, not a silent pass). If it reports `(none)`, the backstop is
   current — you can stop, or run the pre-pass anyway to re-check.

2. **Run the pre-pass.** `node tools/overlap-candidates.js --json > candidates.json`
   Produces `{ pairs, residual, units }`. Each pair carries `axes`, `sameAxis`,
   `signals` (gap_ref / wired_at / description), and a `score`.

3. **Adjudicate — one agent per axis, over BOTH buckets.** For axis *X*, hand the agent
   `pairs.filter(p => p.axes.includes("X"))` **and** the `residual` list. The pairs are
   ranked leads; the residual is *not* certified overlap-free — it is exactly what the
   deterministic signals could not cluster, so the full-scan agent must still read those
   controls' source. A high score is a lead, not a verdict: a shared engine file (e.g.
   several `drift-report.js` sensors) is often a legitimate hub, not a duplicate — which
   is why a human/agent adjudicates rather than the tool auto-merging.

4. **Merge confirmed overlaps** under one owner (see the `net_add_justification` notes
   the earlier merges left in `harness-manifest.json` for the pattern), and re-run
   `npm run control-budget` so the budget ratchets down.

5. **Record the audit.** `node tools/overlap-candidates.js --record`
   Writes `.claude/state/dedup-audit-marker.json` — the control set this full audit
   covered — so the next `--stale` measures drift from here. Record only after a **full**
   backstop pass (agents read source), not after a pre-pass-only run.

## Why the residual bucket matters

Deterministic clustering by shared gap id, file, or vocabulary cannot see a
same-invariant pair that shares none of those (the merged canary controls spanned four
differently-named call sites). If agents only ever saw clustered pairs, such an overlap
would be invisible **and** the run would read as "clean" — a vacuous pass. The residual
list and the staleness marker together guarantee coverage never silently narrows: the
pre-pass makes the common case cheap, the backstop keeps it honest.
