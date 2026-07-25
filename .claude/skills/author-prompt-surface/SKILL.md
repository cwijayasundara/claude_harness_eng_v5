---
name: author-prompt-surface
description: Use when creating or editing .claude/agents/*.md, .claude/skills/*/SKILL.md, or .claude/commands/* — apply docs/prompting-standards.md (trigger conditions, model-agnostic bodies, no reasoning-as-text, effort floors).
user-invocable: false
---

# Author Prompt Surface

Claude-only discipline for the harness monorepo (and any plugin that ships
agents/skills). Load **before** writing or rewriting a prompt surface.

## Required reading

Read and follow `docs/prompting-standards.md` in full. That document is the
source of truth; this skill is the invocation trigger + checklist.

## Surfaces this skill covers

| Path | Role |
|------|------|
| `.claude/agents/*.md` | Subagent prompts (`model:` frontmatter only for model pins) |
| `.claude/skills/*/SKILL.md` | Skill prompts and stage workflows |
| `.claude/commands/*` | Slash-command entrypoints |

## Checklist (every new or edited prompt)

Copy from `docs/prompting-standards.md` — fail the edit if any box is open:

- [ ] No anti-laziness `CRITICAL` / `MUST` / `If in doubt` left in (true invariants only).
- [ ] Every tool/subagent has a **use this when …** trigger condition.
- [ ] Finding/review steps say **report everything with severity**; gates filter downstream.
- [ ] Long-running steps audit progress claims against **tool results**.
- [ ] No "show/echo/transcribe your reasoning as text".
- [ ] Distinct blocks in XML tags; examples where behavior is subtle.
- [ ] Effort expectation noted for agentic/coding work (open `high` / `xhigh`, then measure downward).
- [ ] No instruction to **verify / re-check / double-check its own work** — that causes over-verification; structural verification (independent evaluator, deterministic gates) covers it.
- [ ] Nothing restated that the **platform's base system prompt** already installs (response length, scope discipline, tone, faithful reporting).
- [ ] Detail pushed to `references/*.md`; the always-loaded surface carries only **trigger + routing**.
- [ ] **No model named in the prompt body**; no directional nudge that assumes one model's default (criterion, not nudge).

## Model pins

- Pin models only in agent frontmatter (`model:`) or the session model.
- Never name a model generation in the prompt body.
- One prompt body must run unchanged if the pin changes.

## When *not* to use this skill

- Product application code under `src/` / generated apps.
- Disposable artifacts (mockups, ARB narratives, research) — use the lite lanes.
- Editing deterministic hooks/scripts — use code-gen + tests, not prompting standards.

## After editing

If the change is a new control (gate, sensor, reviewer), also follow
`HARNESS.md` / `harness-manifest.json` registration so the control is not orphaned.
