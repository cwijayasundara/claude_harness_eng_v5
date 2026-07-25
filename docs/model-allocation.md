# Model allocation & cost posture

How the harness assigns Claude models to roles, and how to dial the cost/quality trade-off per project. Pins are set by `execution.model_tier` in `project-manifest.json`, applied to each agent's `model:` frontmatter by `.claude/scripts/model-tier.js`. The prompt bodies are model-agnostic (see [prompting-standards.md](prompting-standards.md) → "Model-agnostic by construction") — the model is named only here.

Enterprise spend guidance: [token-cost-playbook.md](token-cost-playbook.md).

## Pricing (per 1M tokens, in / out)

| Model | Input | Output | Relative to Opus 5 |
|---|---|---|---|
| Opus 5 | $5 | $25 | **1× (top-capability)** |
| Sonnet 5 | $3 ($2 intro through 2026-08-31) | $15 ($10 intro) | 0.6× |
| Haiku 4.5 | $1 | $5 | 0.2× |

> Note: `budget-state.js` uses approximate per-token seeds for receipts; authoritative billing may differ. Prefer OTEL + cost-report for measured runs.

## Why the roles get the models they do

The harness runs a **GAN**: the generator produces, the evaluator judges. Cost follows token *volume*, and volume is uneven across roles:

- **Generation is the volume bucket** — code + tests. In team mode it splits into a **lead** (the `generator`, which decomposes the group and integrates) and a per-story **worker** (the `implementer`, which the lead spawns as a teammate). Both run on **Sonnet 5** unless `max-quality` — *except* the `fusion` posture, which keeps a Sonnet lead but drops the worker to Haiku 4.5.
- **Exploration is high-volume brownfield read** — on **`cost` / `enterprise`**, **Haiku 4.5**; on `balanced`+, Sonnet 5.
- **Judgment is low-volume** — planner, evaluator, reviewers, **advisor**: **Opus 5** on every tier.
- **Session / orchestrator** — recommend **Opus 5** even on cost (conductor reliability); not an agent pin (`/model`).

> **Lead vs worker.** In solo / solo_sequential mode the `generator` implements in its own context and no `implementer` is spawned. In team mode the `generator` is the lead dispatcher+integrator and spawns one `implementer` teammate per story. On every preset except `fusion` the worker pins to the *same* model as the lead, so the split is behaviour-neutral. `record-run` stamps each teammate receipt with the spawned agent's own frontmatter model, so the distinct `implementer` identity is what makes a cheaper worker measurable from the per-story receipts.

## The presets (`execution.model_tier`)

| Role | `cost` / `enterprise` | **`balanced` (monorepo dogfood)** | `max-quality` | `fusion` |
|---|---|---|---|---|
| planner | Opus 5 | Opus 5 | Opus 5 | Opus 5 |
| generator *(team lead)* | Sonnet 5 | Sonnet 5 | Opus 5 | Sonnet 5 |
| implementer *(team worker)* | Sonnet 5 | Sonnet 5 | Opus 5 | **Haiku 4.5** |
| evaluator | Opus 5 | Opus 5 | Opus 5 | Opus 5 |
| design-critic | Opus 5 | Opus 5 | Opus 5 | Opus 5 |
| security-reviewer | Opus 5 | Opus 5 | Opus 5 | Opus 5 |
| code-reviewer | Opus 5 | Opus 5 | Opus 5 | Opus 5 |
| modularity-reviewer | Opus 5 | Opus 5 | Opus 5 | Opus 5 |
| advisor | Opus 5 | Opus 5 | Opus 5 | Opus 5 |
| codebase-explorer | **Haiku 4.5** | Sonnet 5 | Sonnet 5 | Sonnet 5 |
| *session / orchestrator* | Opus 5 | Opus 5 | Opus 5 | Opus 5 |

- **`cost` / `enterprise`:** Product scaffold default (Token Saver). Sonnet generation, Haiku exploration, Opus judgment. `enterprise` is an alias of `cost`.
- **`balanced`:** This monorepo's dogfood default. Same generator as cost; Sonnet explorer.
- **`max-quality`:** Generator (lead + worker) bumped to Opus 5.
- **`fusion`:** "Cheap worker under a smart lead." A Sonnet 5 lead keeps decomposition/integration quality while the per-story `implementer` worker runs on Haiku 4.5 — the only preset where the teammate worker is cheaper than the lead. Judgment stays Opus, explorer stays Sonnet. Use it to A/B a blanket-cheap worker against a uniform-Sonnet generation bucket; the receipt-level model attribution makes the cost/outcome delta measurable.

On every preset except `fusion`, `implementer` equals `generator`, so the worker role is behaviour-neutral until you opt into `fusion`.

Pins are exact model IDs: `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5`.

> **Fable 5:** Removed as a live pin. `MODEL_PRICE` reserves `claude-fable-5` for a future advisor-only pin if product re-enables it — do not stamp agents with it today.

## Operating it

- **Set the posture:** `execution.model_tier` in `project-manifest.json`, then:
  ```bash
  node .claude/scripts/model-tier.js <cost|balanced|max-quality|enterprise|fusion> --apply .claude/agents
  ```
- Scaffold product apps (`web-app` / `api-service`) default to **`cost`**. Override via profile `modelTier` or the monorepo keep `balanced`.
- **Overrides are allowed** (defaults > denials). Log tier changes; do not swap the orchestrator model mid-session (cache rule).
