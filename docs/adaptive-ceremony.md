# Adaptive ceremony — re-baseline the harness per model generation

Harness structure that was load-bearing for one model generation becomes drag
for the next. Anthropic's harness-design work documented this directly: sprint
decomposition was *necessary* for Opus 4.5 and became *optional* on Opus 4.6,
while the independent evaluator stayed worth its cost ("worth it when the task
sits beyond what the current model does reliably solo"). Ceremony is a dial,
not a constant — and the dial must be re-measured, not guessed.

## The knob

`project-manifest.json` → `execution.ceremony`:

| Value | Behavior |
|---|---|
| `full` (default) | Current pipeline exactly as documented in `/auto` |
| `trimmed` | Single-story groups skip sprint decomposition (straight to contract + implement); design-critic GAN loop caps at 3 iterations instead of 10 |

Two components are **never** trimmed, at any setting:

- **The independent evaluator.** Self-evaluation bias does not improve with
  model capability; an agent grading its own work over-praises it regardless
  of generation. Gates 5/7/8 run in every profile.
- **The deterministic gates** (hooks, ratchet, contracts). They cost almost
  nothing and they are the part that does not depend on the model behaving.

## The re-baselining ritual

Run this when the orchestrator or teammate model changes generation (not for
patch releases):

1. Pick one representative story group from a real project (mid-complexity,
   touches API + UI).
2. Run it twice from the same base commit: once at `ceremony: full`, once at
   `trimmed`. Same model, same prompts.
3. Compare: evaluator verdict, gate failures, fix cycles, wall-clock, cost.
4. Decide per component: a component earns its place only if removing it
   degraded the outcome (not just changed the style). Record the decision and
   the evidence in this file's changelog below.
5. Default new projects to the cheapest profile that held quality.

Do not trim from memory of an older model's failures, and do not add ceremony
to compensate for a weakness the current model no longer has.

## The model-generation migration ritual

The re-baselining ritual above measures *ceremony*. This wider ritual covers
everything else a model-generation change touches. A new generation is
usually announced by the upstream-watch workflow flagging a new
`*-migration` plugin in `anthropics/claude-code/plugins`.

1. **Run Anthropic's migration plugin first, if one shipped** (e.g.
   `claude-opus-4-5-migration`). Apply the model-string changes only; defer
   its prompt adjustments until step 3 shows they're needed.
2. **Re-pin model tiers.** Update `.claude/scripts/model-tier.js` presets to
   the new exact model IDs and re-run `test/model-tier.test.js` — the
   security-reviewer invariant and "exact IDs, never aliases" rules must hold.
3. **Run the eval before flipping anything on `main`.** On a branch with the
   new IDs, run the unit suite plus one representative e2e story group, and
   read the transcripts — Anthropic's migration guides list the axes that
   shift (literalism, tool-trigger thresholds, verbosity, effort calibration).
4. **Prune in both directions.** Audit `.claude/agents/*` and
   `.claude/skills/*/SKILL.md` against `docs/prompting-standards.md`: delete
   emphasis and workarounds the new generation no longer needs (the
   anti-laziness `CRITICAL/MUST` class), and only then add new rules for
   failures actually observed in step 3.
5. **Treat the upgrade as a security event.** Re-run the hook-security tests
   and spot-check that permission gates and destructive-command denials still
   trigger — injection resistance and tool-trigger thresholds regress
   non-monotonically across generations.
6. **Re-baseline ceremony** (ritual above) and record the outcome in the
   changelog below.

## Changelog

| Date | Models | Decision | Evidence |
|---|---|---|---|
| 2026-06 | Opus 4.8 orchestrator, Sonnet 4.6 teammates | `full` remains default; `trimmed` available per-project | Knob introduced; no measured run yet — first re-baseline owed at next model-generation change |
| 2026-07-25 | Opus 5 judgment tier, Sonnet 5 teammates | Step 2 (re-pin) done; `full` remains default | Claude 5 generation. Judgment pins moved `claude-opus-4-8` → `claude-opus-5` (`model-tier.js`, 7 agent frontmatters, docs); unit suite 2472/2472. **Ceremony re-baseline still owed** — steps 3 and 6 need a billed two-run comparison on a real story group, which has not been executed. Do not read this row as a measured result. |
