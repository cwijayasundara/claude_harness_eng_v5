## SECTION 4: Agent Team Execution (Step 4)

Spawn the generator agent for the current group. Multi-story groups follow **generator.md Rule 2 + `team-policy.js`** (team vs `solo_sequential` vs solo) — do not force multi-agent boundary tax on tiny independent stories.

### Orchestrator Spawn Prompt (Mandatory Template)

When invoking the generator from `/auto`, you (the orchestrator) **MUST** use a prompt that carries the team-policy mandate inline — a terse one-liner like `"Implement group A"` leaves too much latitude. Use this template, substituting `{GROUP_ID}` and the story count:

```
Implement group {GROUP_ID} ({N_STORIES} stories) using generator.md Rule 2 and .claude/scripts/team-policy.js.

Concretely:
1. Read specs/stories/ for every story in this group.
2. Read specs/design/component-map.md and build the micro-DAG (Step 2.5).
3. Decide team_mode via team-policy (solo | solo_sequential | team). Log the decision + reason to .claude/state/iteration-log.md.
4. If team: create `.claude/state/parallel-implement.lock` (empty file) and set env `HARNESS_PARALLEL_AGENTS=1` for the team window so pre-bash git-safety is active; spawn one Agent(subagent_type=implementer) per story — parallel Phase 1, then Phase 2 after Phase 1 commits. You are dispatching, not implementing (except designated Phase 3 integrator). Remove the lock when the team finishes.
5. If solo_sequential: implement stories one-by-one in this context — do NOT spawn per-story teammates.
6. If solo (N=1): implement yourself.
7. After implementation, run the validation gate (pytest, ruff, mypy/tsc, coverage) and hand off to the evaluator.
8. Structural advisor: after 2 consecutive evaluator FAILs on this group, spawn Agent(subagent_type=advisor) with a compact fail brief (cap: execution.advisor_max_per_run, default 3) before the next generator attempt.
```

If the group has only **1 story**, use the single-generator prompt — no team needed.

### Verification After Generator Returns

After the generator subagent returns:

1. Read `.claude/state/iteration-log.md` — there must be a `team_mode` decision for multi-story groups.
2. If `team_mode: team`, there must be one teammate-spawn entry per story (minus Phase-3-only integrators).
3. If `team_mode: solo_sequential`, zero teammate spawns is correct — do not re-dispatch for "missing team."
4. If multi-story and no team_mode logged, treat as Rule 2 violation: surface as ratchet failure, record in learned-rules, re-dispatch with stricter prompt.

Silent *unauthorized* solo on a large multi-story group still defeats the purpose — only policy-approved `solo_sequential` is allowed.

### Dependency Handshake

Before spawning teammates, the generator analyzes the component map:
1. Identifies shared files (files in 2+ stories)
2. Identifies interface boundaries (`Produces:` / `Consumes:` in component map)
3. Builds a micro-DAG grouping teammates into execution phases
4. Designates integrators for shared files

Log the micro-DAG to `iteration-log.md`.

If no cross-dependencies exist, all teammates spawn in parallel (legacy behavior).

### Phased Execution

| Phase | Who | Starts When | Must Do |
|-------|-----|------------|---------|
| 1 | Teammates with no upstream deps | Immediately | Implement + commit typed interface contracts |
| 2 | Teammates consuming Phase 1 outputs | All Phase 1 teammates complete | Code against committed interface contracts |
| 3 | Integrators for shared files | All Phase 2 teammates complete | Collect declared additions, write to shared files |

Max 5 concurrent teammates per phase. Batch in groups of 5 if more.

### Teammate Spawn Prompt

Every teammate receives:
- Story acceptance criteria (from `specs/stories/E{n}-S{n}.md`)
- Story readiness metadata (must be `ready`; otherwise do not spawn)
- File ownership (from `specs/design/component-map.md`)
- Learned rules (from `.claude/state/learned-rules.md` — inject verbatim)
- Process rules (from `.claude/state/process-rules.md` when non-empty — inject verbatim; workflow constraints, not code style)
- Quality principles (from `.claude/skills/code-gen/SKILL.md`)
- **Git safety (parallel team):** MUST NOT run `git stash`, `git stash pop`, `git reset --hard`, `git clean -fd`, or `git push --force`. MAY `git add <owned paths>` and `git commit`. Pre-bash-gate enforces this while `parallel-implement.lock` exists or `HARNESS_PARALLEL_AGENTS=1` (escape: `HARNESS_GIT_SAFETY=off`, human only).
- Interface contracts from upstream teammates (Phase 2+ only)
- If story involves external API: `.claude/skills/code-gen/references/api-integration-patterns.md`
- If the story edits pre-existing (non-sprint-new) symbols and `specs/brownfield/code-graph.json` exists: run `checking-coverage-before-change` on those symbols before the first edit; UNCOVERED routes through `pinning-down-behavior` / `sprouting-instead-of-editing`

### Model Tiering

Roles are assigned by **capability tier**, not a specific model — no prompt in this harness assumes which model it is running on (see `docs/prompting-standards.md` → "Model-agnostic by construction").

| Role | Tier | Rationale |
|------|------|-----------|
| `/auto` orchestrator | top-capability | Judgment, architectural decisions |
| Evaluator | top-capability | Skeptical verification |
| Design critic | top-capability | Subjective visual judgment |
| Generator (team lead) | cost-efficient | Coordination, brief-writing, integration |
| Implementer (team worker) | cost-efficient; **cheap** on `fusion` | Per-story mechanical implementation — spawned as `subagent_type: implementer` |
| Security reviewer | top-capability | Contextual vuln reasoning + adversarial find-then-refute |

- **top-capability** = Opus 5.
- **cost-efficient** = Sonnet 5.
- **cheap** = Haiku 4.5 (worker tier — only on the `fusion` preset, where the worker is cheaper than its lead).

The orchestrator runs on the **session model** (whatever `/model` is set to — Opus 5). Subagent models are pinned per agent in `.claude/agents/<name>.md` frontmatter (`model:`), stamped from the cost-posture preset in `project-manifest.json` → `execution.model_tier` (default `balanced`):

- **cost** — Sonnet generation, Opus judgment.
- **balanced** (default) — identical pins to `cost` today (top tier is a single model, Opus 5); kept as a distinct posture name for per-project re-tuning.
- **max-quality** — generation bumped to Opus 5; everything else already Opus, codebase-explorer stays Sonnet.
- **fusion** — cheap worker under a smart lead: generator lead stays Sonnet 5, the `implementer` team worker drops to Haiku 4.5 (the only preset where the worker is cheaper than the lead), judgment Opus. On every other preset the implementer pins to the same model as the generator, so the role changes no behavior unless `fusion` is selected.

Re-stamp after editing the manifest: `node .claude/scripts/model-tier.js <preset> --apply .claude/agents`. Full rationale + decision rule: `docs/model-allocation.md`.

---
