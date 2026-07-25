# Prompting Standards — authoring agents & skills

How to write the harness's prompt surfaces (`.claude/agents/*.md`, `.claude/skills/*/SKILL.md`, `.claude/commands/*`) so they get the best out of the current Claude models. Distilled from Anthropic's [prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices) and [Prompting Opus 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5).

## Which model runs where (tune the prompt to its reader)

| Surface | Model (tier) | Implication for the prompt |
|---|---|---|
| `/auto` orchestrator, direct chat | **Opus 5** (session model) | Top-capability tier. Long-horizon autonomy; needs grounded-progress + don't-stop-early + reversible-action guidance. Do **not** ask it to echo its reasoning as response text (see §7). |
| `planner`, `evaluator`, `design-critic`, `security-reviewer` | **Opus 5** (top-capability) | Literal instruction follower; report-everything-then-filter for judging; effort matters. |
| `generator` | **Opus 4.7** (default tier; Sonnet 4.6 on `cost`, Opus 5 on `max-quality`) | Set effort explicitly; precise, observable acceptance criteria. |
| `codebase-explorer` | **Sonnet 4.6** (cost-efficient, read-only) | Set effort explicitly; precise, observable acceptance criteria. |

Opus 5 is the single top-capability model. The actual model is pinned in each agent's `model:` frontmatter (and the session model for the orchestrator); that frontmatter is the *only* place a model is named — never the prompt body.

## Model-agnostic by construction

Even with one top-capability model today, prompt bodies name **no** model and assume **no** model's innate defaults. This keeps a model swap — the next generation, or a per-role re-pin — a one-line frontmatter change rather than a prompt rewrite. Two principles enforce it:

**Principle A — Write to the stricter rule.** Where a behavior is model-sensitive, adopt the version that is safe across models, not the one that happens to suit the current pin. It costs nothing on a model that didn't need it and prevents a failure when the pin changes. Examples already applied: never echo reasoning as text (§7), ground every progress claim, lead-with-outcome brevity, never end a turn on a promise.

**Principle B — Criterion, not nudge.** Phrase every *steerable* behavior as a condition to evaluate, never a directional push. A nudge ("delegate more" / "spawn fewer subagents") assumes a specific innate default and inverts on a model with the opposite lean. A criterion ("delegate when fanning out across independent items; work directly for single-file/sequential work") is self-correcting — any model converges to the same behavior regardless of its default. The harness's subagent structure is the worked example: the generator spawns *one teammate per story per phase* and `/auto` spawns *named agents for named roles*, so no model's delegation default matters.

### Behavior map — write the right-hand column

Known model tendencies to write defensively against, and the model-agnostic instruction that neutralizes each:

| Behavior | Tendency to guard against | Model-agnostic instruction to write |
|---|---|---|
| Subagents | over- or under-delegation, depending on the model — this reversed between two adjacent generations (4.8 under-reached, 5 over-reaches), so a directional nudge written for either would now be actively wrong | Criterion: "spawn when fanning out across independent items / isolated context; work directly for single-file, sequential, context-sharing work." |
| Reasoning visibility | some models degrade or refuse if asked to echo reasoning as text | Never instruct echoing reasoning; read structured `thinking` blocks instead. |
| Verbosity | over-elaboration at high effort | "Lead with the outcome; be selective about what you include." |
| Early stopping | ending a turn on a promise without the tool call | "Don't end a turn on a promise — issue the tool call now." |
| Effort sweet spot | two-sided: shallow reasoning if set too low, silent overspend if a floor inherited from an older generation is left in place | "Open at `xhigh` for coding/agentic, `high` elsewhere, then measure whether a lower tier holds." |
| Progress claims | fabricated status on long runs | "Audit each claim against a tool result before reporting." |
| Self-verification | newer models verify their own work unprompted; an instruction to verify then causes *over*-verification and wasted cycles | Say nothing. Let structural verification (independent evaluator, deterministic gates) do it — never add "double-check your answer" to a prompt body. |
| Prescriptiveness | rigid step-by-steps can degrade a capable model | Prescribe only where determinism is load-bearing (the gates); elsewhere give goal + boundaries. |

### Keep the divergence in one place

The *only* legitimate per-model knobs are **`model:` (frontmatter / session model)** and **effort** (the `/effort` convention + the per-skill "ultracode tip"). Never name a model or assume a model's default in prompt prose. Swapping the pinned model must be a one-line frontmatter change. Do **not** template prompts per-model (`{{IF MODEL}}…`) — keep one prompt that any current Claude model can run.

## The standards

**1. Dial back aggressive over-prompting.** Current models follow the system prompt closely and *overtrigger* on anti-laziness language written for older models. Prefer `Use X when …` over `CRITICAL: YOU MUST use X`; delete `If in doubt, use X` and `Default to using X`. Reserve emphatic phrasing for genuine invariants (a hard gate, a safety rule) — not to coax tool use. (A `NEVER` that states an architectural invariant — "`/auto` never writes code directly" — is fine; a `NEVER` nagging the model to be thorough is not.)

**2. Say *when*, not just *what*, for every tool/capability.** Opus 5 reaches for search, subagents, memory, and custom tools *conservatively*. Put the trigger condition in the tool/skill description itself — "Use this when the diff touches auth or persistence," not just "reviews security." Prescriptive "call this when…" descriptions measurably raise the should-call rate.

**3. Code review / finding tasks: report everything, filter downstream.** "Only report high-severity" or "be conservative" makes Opus 5 investigate fully and then *silently drop* low-severity findings — recall falls. Tell the finder its job is **coverage**: report every finding with a `confidence` and `severity`, and let a separate gate/stage filter. The `security-reviewer` is the reference implementation ("you report everything — no vulnerability is too minor"; severity assigned per finding; the **gate** filters to critical/high).

**4. Calibrate effort — start high, then sweep *down*.** Open at `xhigh` for coding/agentic work and `high` for other intelligence-sensitive work, then measure whether a lower tier holds. On the current generation `low` and `medium` are unusually strong — often beating a prior generation's `xhigh` — so an effort floor inherited from an older model is usually over-spending, and the ladder is not monotonic. Raising effort is still the first lever for *shallow reasoning* or *low tool use*; it is **not** a lever for response length (see §11). Note the `max_tokens ≥64k` pairing applies to product code that calls the API directly — this harness makes no such calls, so it is guidance for generated code, not for prompt surfaces.

**5. Lead with the outcome; be selective, not terse.** Models can over-elaborate at high effort (surveying options they won't pursue, narrating each line). The fix is a brevity instruction, not fragments: *"Lead with the outcome — your first sentence answers 'what happened.' Drop details that don't change what the reader does next. Readability matters more than compression; don't use arrow-chains or invented shorthand in user-facing text."*

**6. Ground progress claims in long autonomous runs.** Instruct long-running skills to *audit each status claim against an actual tool result from the session* before reporting it. This nearly eliminates fabricated "all green" reports and is the loop-level twin of the pipeline's artifact-grounding gates. See `/auto` → "Long-run autonomy & grounded progress."

**7. Don't ask the model to reproduce its reasoning as response text.** Prompts that say "show your reasoning," "explain your thinking step by step in your answer," or "echo your chain of thought" can degrade output or, on some models, trigger a `reasoning_extraction` refusal. If you need reasoning visibility, read the structured `thinking` blocks (adaptive thinking) — don't instruct the model to transcribe them. ("Think before you answer" is fine; "print your thinking" is not.)

**8. Structure with XML tags; show examples.** Wrap distinct instruction blocks in descriptive tags (`<scope_control>`, `<investigate_before_answering>`) so the model parses them unambiguously, and prefer 3–5 `<example>`-tagged examples over abstract rules. Tell the model what to do, not what to avoid.

**9. No prefilled assistant turns.** Last-assistant-turn prefills 400 on current models. Use structured outputs (a schema), tool enums, or a system instruction ("respond directly, no preamble") instead. The deterministic gates already prefer JSON verdict files over prose — keep that pattern.

**10. Don't over-prescribe.** Skills written as rigid step-by-steps for older models can *degrade* a current model's output. Where a skill's value is determinism (the ratchet gates), keep the steps; where it's just micromanaging a capable model, prefer stating the goal and constraints and letting it plan. Bias new prompt text toward "goal + boundaries," not exhaustive procedure.

**11. Don't restate what the platform already installs.** Claude Code ships a base system prompt that already carries the general-purpose behavioral guidance — response length and readability, scope discipline, faithful reporting, correction etiquette, matching surrounding code style. Restating any of it in an agent, skill, or `CLAUDE.md` costs prefix budget and risks *conflicting* with the platform wording, which is worse than silence. Write only what is specific to **this repo or this role**: a gotcha, an invariant, a hard-won incident. If a rule would be equally true in any repository, the platform already has it — leave it out. (Length is the common trap: it responds to an explicit instruction, not to `effort` — but the platform's instruction is usually enough.)

**12. Prefer progressive disclosure over an upfront dump.** Only the trigger condition and the routing belong in an always-loaded surface (`CLAUDE.md`, a skill `description`, an agent `description`). Detail belongs one hop away in `references/*.md` that the model reads when the task actually calls for it — the `design` and `evaluate` skills are the reference implementations. A skill whose `SKILL.md` exceeds roughly 20KB is usually a tree waiting to be split, and every skill description is paid on every turn whether or not the skill fires.

## Quick checklist for a new/edited prompt

- [ ] No anti-laziness `CRITICAL:/MUST/If in doubt` left in (only true invariants stay).
- [ ] Every tool/subagent has a "use this when …" trigger condition.
- [ ] Finding/review steps say "report everything with severity," gate downstream.
- [ ] Long-running steps audit progress claims against tool results.
- [ ] No "show/echo/transcribe your reasoning as text" (degrades output; refusal risk on some models).
- [ ] Distinct blocks in XML tags; examples where behavior is subtle.
- [ ] Effort expectation noted for agentic/coding skills (open `high`/`xhigh`, then measure downward).
- [ ] No instruction to verify, re-check, or double-check its own work (causes over-verification; structural verification covers it).
- [ ] Nothing restated that the platform's base system prompt already installs (length, scope, tone, reporting).
- [ ] Detail pushed to `references/*.md`; the always-loaded surface carries only trigger + routing.
- [ ] No model named in the prompt body, and no behavior phrased as a directional nudge that assumes one model's default (criterion, not nudge) — prompts must run unchanged if the pinned model changes.

When a new model *generation* ships (not a patch release), don't edit prompts ad hoc — run the model-generation migration ritual in `docs/adaptive-ceremony.md`, which includes auditing every prompt against this checklist and deleting rules the new generation has made redundant.
