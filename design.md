# Claude Harness Engine v5 — Architecture Reference

> **Doc map:** this file is canonical for *architecture rationale*. For the live gate/sensor inventory see `HARNESS.md`; for install/usage see `README.md`; for the "which doc for what" index see `CODEBASE_MAP.md`.

Comprehensive design document for the Claude Harness Engine: a GAN-inspired orchestration system for autonomous, long-running application development with Claude Code.

Copied into target projects by `/scaffold`.

Current scaffold version: `2.0.0`.

Canonical repository: `https://github.com/cwijayasundara/claude_harness_eng_v5.git`.

Based on:
- [Anthropic: Harness Design for Long-Running Apps](https://www.anthropic.com/engineering/harness-design-long-running-apps)
- [Anthropic: Effective Harnesses for Long-Running Agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- [OpenAI: Harness Engineering](https://openai.com/index/harness-engineering/)
- [Steve Krenzel: AI is Forcing Us to Write Good Code](https://bits.logic.inc/p/ai-is-forcing-us-to-write-good-code)
- [Andrej Karpathy: Autoresearch Loop](https://x.com/karpathy) — monotonic ratchet pattern

---

## 1. Design Philosophy

### The Problem with Autonomous Code Generation

When an AI agent generates code autonomously, three failure modes dominate:

1. **Self-evaluation bias** — The agent that wrote the code cannot objectively judge it. It rationalizes failures ("the test is probably wrong"), skips edge cases, and declares victory prematurely.
2. **Quality regression** — Without enforcement, coverage drops, functions grow, architecture drifts, and the codebase degrades over multiple iterations. Each fix introduces new problems.
3. **Context exhaustion** — Complex projects exceed a single context window. Without recovery, work restarts from scratch every session, knowledge is lost, and the same mistakes repeat.

### The Solution: GAN + Ratchet

The harness combines two complementary patterns to address all three failure modes:

**GAN (Generative Adversarial Network) pattern** — Separate the generator (writes code) from the evaluator (verifies code). Neither can do the other's job. The generator cannot evaluate; the evaluator cannot write. This structural separation eliminates self-evaluation bias.

**Karpathy Ratchet** — Every metric (test coverage, lint cleanliness, architecture alignment) can only move forward, never backward. Once coverage reaches 85%, it never drops below 85%. Once a learned rule is extracted, it's never deleted. Progress is monotonic, and quality accumulates across sessions.

Together: the GAN ensures honest verification at each step, and the ratchet ensures that verified quality is never lost.

---

## 2. End-to-End System Design

The harness is now an **agent factory**: one scaffold, optional framework skill packs, and two interchangeable execution surfaces (a local Claude Code workspace, or a Linear/Jira-driven tracker queue serviced by `symphony_clone`).

```
┌───────────────────────────────────────────────────────────────────────────┐
│  0. AUTHORING — Human + Claude Code (interactive)                          │
│                                                                            │
│  /scaffold (asks 8 questions) ─► writes:                                   │
│    project-manifest.json · CLAUDE.md · design.md · init.sh                 │
│    .claude/  (agents · skills · hooks · templates · state)                 │
│    specs/   (brd · stories · design · brownfield · reviews)                │
│                                                                            │
│  Optional packs injected at scaffold time:                                 │
│    • Official Claude Code plugins (superpowers, code-review, …)            │
│    • Framework skill packs into .claude/skills/ (-a claude-code)            │
│        – LangChain / LangGraph / DeepAgents (9 skills)                     │
│        – Google ADK (7 skills)                                             │
│    • Tracker config (Linear / Jira) — opt-in                               │
└────────────────────────────────────┬──────────────────────────────────────┘
                                     │
                                     ▼
┌───────────────────────────────────────────────────────────────────────────┐
│  1. PLANNING — Same in both runtimes                                       │
│                                                                            │
│  Greenfield large : /brd → /spec → /design + /test --plan-only (parallel)  │
│  Greenfield small : /build --lite (compressed BRD + 1 group)                       │
│  Brownfield       : /brownfield → /code-map → /seam-finder                 │
│  Small fixes      : /vibe (micro-contract)                                 │
│                                                                            │
│  Output contract:                                                          │
│    specs/stories/dependency-graph.md   (groups + blockers)                 │
│    specs/design/component-map.md       (file ownership per story)          │
│    specs/test_artefacts/               (test plan, cases, fixtures)        │
│    features.json                       (pass/fail registry)                │
└────────────────────────────────────┬──────────────────────────────────────┘
                                     │
              ┌──────────────────────┴──────────────────────┐
              │                                              │
              ▼                                              ▼
┌─────────────────────────────────────┐    ┌─────────────────────────────────────┐
│  2a. LOCAL RUNTIME                   │    │  2b. AGENT-FACTORY RUNTIME           │
│  (default — single workstation)      │    │  (opt-in — Linear/Jira + Docker)     │
│                                      │    │                                      │
│  Human runs in Claude Code:          │    │  /tracker-publish writes one Linear/ │
│    /auto --group <id>                │    │  Jira issue per dependency group.    │
│  or /auto for the next wave.         │    │                                      │
│                                      │    │  symphony_clone (Docker container):  │
│  /auto orchestrates the ratchet:     │    │   • polls tracker for Ready + label  │
│   generator → evaluator → critic     │    │   • clones repo to /workspaces/<key> │
│   → security → generator.        │    │   • runs `claude --print …` with the │
│                                      │    │     /auto prompt for that group      │
│  Human reviews diffs and merges.     │    │   • reads result.json proof          │
│                                      │    │   • opens PR + comments back         │
│                                      │    │   • moves issue to Human Review      │
└──────────────────────┬───────────────┘    └────────────────────┬────────────────┘
                       │                                          │
                       └────────────────────┬─────────────────────┘
                                            ▼
┌───────────────────────────────────────────────────────────────────────────┐
│  3. EXECUTION — Identical inside the workspace                             │
│                                                                            │
│  /auto loop per group:                                                     │
│   1. Recover state (program.md, learned-rules.md, features.json)          │
│   2. Negotiate sprint contract (generator proposes → evaluator finalizes) │
│   3. Spawn agent team (phased DAG, ≤5 parallel teammates)                  │
│   4. Run 8 ratchet gates (tests→lint→coverage→arch→eval→critic→sec→diff)  │
│   5. Self-heal failed gates (max 3 attempts; different strategy each)      │
│   6. Update features.json, learned-rules.md, claude-progress.txt           │
│   7. Commit. Hooks enforce length, secrets, layers, review.                │
└────────────────────────────────────┬──────────────────────────────────────┘
                                     │
                                     ▼
┌───────────────────────────────────────────────────────────────────────────┐
│  4. DELIVERY                                                               │
│                                                                            │
│  Local mode    : commits on main branch (or /commit-push-pr).             │
│  Factory mode  : agent/<issue-key> branch + GitHub PR + Linear proof.     │
│                                                                            │
│  Humans always own merge and "Done." The orchestrator never closes —       │
│  except via the AUTO_MERGE opt-out (local: /build --auto --auto-merge or   │
│  AUTO_MERGE=true env; symphony: AUTO_MERGE key), which lets GitHub auto-   │
│  merge once the repo's required status checks pass (both runtimes).        │
└───────────────────────────────────────────────────────────────────────────┘
```

### Why two runtimes share one scaffold

The scaffold writes a single **work contract** (`dependency-graph.md`, `component-map.md`, `features.json`, sprint contracts). Both runtimes consume it.

- **Local** is the fast loop: solo engineer, 1-3 hour cycles, full feedback in the same chat.
- **Agent factory** is the queue loop: tracker visibility, parallel groups across machines, human review surface in Linear/Jira.

Neither runtime changes how `/auto` runs inside the workspace. The only difference is **who picks the next group and where the proof shows up**.

---

## 3. Component Inventory

| Component | Count | Location | Purpose |
|---|---:|---|---|
| Slash command (true) | 1 | `.claude/commands/scaffold.md` | Bootloader only |
| Skills (virtual commands) | 26 | `.claude/skills/<name>/SKILL.md` | All other workflows |
| Specialized agents | 8 | `.claude/agents/<name>.md` | Subagents with tool allowlists + model tier |
| Lifecycle hooks | 7 | `.claude/hooks/*.js` | SessionStart, PreToolUse (Write/Edit + Bash), PostToolUse, UserPromptSubmit, Stop, SubagentStop |
| Templates | — | `.claude/templates/*` | Sprint contract, story, init.sh, .gitignore, tracker config, state seeds, etc. (count omitted — it rots on every template add) |
| State files | 12 tracked in this repo; 6 scaffold seeds | `.claude/state/`, `.claude/templates/state-seeds/` | Runtime snapshot + initial scaffold continuity files |
| Utility scripts | 14 | `.claude/scripts/*.js`, `.claude/scripts/*.sh` | Model tiering, telemetry, validation, archive, certification, upstream watch |
| GitHub automation | 2 workflows | `.github/workflows/`, `.github/upstream/` | CI and upstream Claude Code drift watch |
| Official plugins (default-on) | 9 | `enabledPlugins` in `settings.json` | Superpowers, code-review, frontend-design, … |
| Framework skill packs | 2 (opt-in) | `.claude/skills/<pack-prefix>-*` (via `-a claude-code`) | LangChain (9 skills) · Google ADK (7 skills) |
| Tracker orchestrator | 1 sibling project | `symphony_clone/` | Docker service for Linear-driven dispatch |
| LSP servers | auto-detected | `project-manifest.json` `lsp.servers` | Symbol navigation for agents (go-to-definition, find-references) |

### LSP Integration

`/scaffold` auto-detects the project's languages from the stack and writes recommended LSP servers into `project-manifest.json`. The `init.sh` bootstrap script checks whether each server binary is on `$PATH` and prints install commands for missing ones.

| Language | LSP Server | Install |
|----------|-----------|---------|
| Python | pyright | `npm i -g pyright` |
| TypeScript / JS | typescript-language-server | `npm i -g typescript-language-server typescript` |
| Go | gopls | `go install golang.org/x/tools/gopls@latest` |
| Java | jdtls | `brew install jdtls` |
| C# | omnisharp-roslyn | `dotnet tool install -g omnisharp` |
| Rust | rust-analyzer | `rustup component add rust-analyzer` |

The `codebase-explorer` agent has `LSP` in its tool grants and uses it for symbol-level navigation when available. All other agents benefit implicitly — Claude Code routes go-to-definition and find-references through whichever LSP server is running.

### The 26 skills, grouped by lane

| Lane | Skills |
|---|---|
| Greenfield pipeline | `brd`, `spec`, `design`, `implement`, `evaluate`, `review`, `test`, `deploy`, `build`, `auto` |
| Lite/brownfield/vibe | `brownfield`, `code-map`, `seam-finder`, `vibe` |
| Behavior change | `change` (incl. `--issue N`), `refactor` (incl. `--sweep`) |
| Behavior-preservation sub-skills | `checking-coverage-before-change`, `pinning-down-behavior`, `sprouting-instead-of-editing`, `keeping-refactors-pure`, `checking-migration-safety`, `upgrading-dependencies` |
| Reference and guardrails | `code-gen`, `clarify` |
| Tracker add-on | `tracker-publish` |
| Framework packs | `install-framework-packs` |

### The 8 agents

| Agent | Model | Tool grants | Responsibility |
|---|---|---|---|
| planner | Opus 5 | Read · Write · Glob · Grep · Bash | BRD, stories, dep graph, architecture, schemas |
| generator | Sonnet 4.6 | + Edit · Agent (spawns teammates) | Code + tests, spawns agent team, TDD |
| evaluator | Opus 5 | + Playwright MCP (navigate, click, fill, snap) | Runs app, 3-layer verification + latency regression ratchet, structured failures |
| design-critic | Opus 5 | + Playwright MCP (resize, hover, screenshot) | GAN scoring (DQ/O/C/F), plateau pivot |
| security-reviewer | Opus 5 | Read · Write · Grep · Glob · Bash | OWASP scan + adversarial find-then-refute; enforced gate (BLOCK on critical/high) |
| code-reviewer | Opus 5 | Read · Write · Grep · Glob · Bash | Fresh-context structure (SOLID/maintainability) + correctness review of the diff |
| codebase-explorer | Sonnet 4.6 | Read · Glob · Grep · Bash · LSP | Read-only brownfield discovery and symbol navigation |

The Model column shows the **`balanced` default**. **Opus 5 is the top-capability tier** (prompts are model-agnostic by construction; see `docs/prompting-standards.md`). The cost posture is set by `execution.model_tier` (`cost`/`balanced`/`max-quality`) and stamped as exact model ids into each `.claude/agents/<name>.md` `model:` line; see `docs/model-allocation.md`.

### The enforcement hooks

All hooks include remediation instructions ("Fix: …") so they steer the agent, not just block it. They key off the tool name only — no per-command/agent gating — so they fire on every matching edit, including raw ad-hoc edits made outside any slash command.

One consolidated hook per event — each spawns once and dispatches its checks in-process from `.claude/hooks/lib/`, so an edit costs 2 Node spawns instead of 13:

| Event matcher | Hook | Purpose |
|---|---|---|
| `SessionStart` | `check-git-hooks.js` | Advisory: warns once when a git repo is missing the harness commit-time gates (e.g. `git init` without re-scaffolding). Never blocks; exempts the harness repo and foreign pre-commit hooks |
| `PreToolUse Write|Edit|MultiEdit` | `pre-write-gate.js` | Blocks BEFORE disk, first failure wins: scope → machinery trust-boundary → **prompt-cache prefix** (`CLAUDE.md`, `.mcp.json`, `.claude/settings*.json`; `HARNESS_PREFIX_EDIT=1`) → `.env` protection → secret scan on inserted content only → `security-patterns.{json,yaml}` `block: true` rules (`HARNESS_PATTERN_BLOCK=off`) → 300-line file cap → 30-line function cap → TDD test-first (`HARNESS_TDD_GATE=off`) |
| `PreToolUse Bash` | `pre-bash-gate.js` | Closes the shell write-bypass: extracts write targets from the command (redirections, `tee`, `sed -i`, `dd`, `cp`/`mv`) and re-applies project scope, the machinery trust-boundary, and `.env` protection so a shell write can't disable a gate (`HARNESS_PROTECT=off`) |
| `PostToolUse Edit|Write|MultiEdit` | `verify-on-save.js` | Queue file in `pending-reviews.jsonl` (silent), then one-way layer imports check, ruff/mypy or eslint on the saved file — report-only, never `--fix` |
| `UserPromptSubmit · Stop · SubagentStop` | `record-run.js` | Telemetry journal — off the per-edit hot path |
| `Stop` | `review-on-stop.js` | Force reviewer agents before turn ends; session-learnings advisories when clean |

Commit-time gates are real **git hooks** (installed by `/scaffold` Step 8) — they block the commit before it exists, fire once however the commit was invoked, and cannot be fooled by `--amend` or strings containing "git commit":

| Git hook | Purpose |
|---|---|
| `pre-commit` | Staged-file layer scan → sprint-contract `VERDICT: PASS` check → project-wide `tsc --noEmit` (TS) → pytest coverage ratchet vs baseline / 80% floor (Python; `HARNESS_COVERAGE_GATE=off` bypass). Skips when no source files are staged. A gate that fails open (toolchain unprovisioned/timed out) prints a loud `WARNING: GATE SKIPPED` so a silent skip is never mistaken for a pass |
| `prepare-commit-msg` | Harness-Lane/Mode/Iteration/Group commit trailers |

A hook crash never blocks work, but is never silent either: failures are appended to `.claude/state/hook-errors.log`.

**TDD is enforced in two complementary layers.** Layer 1, the `pre-write-gate.js` test-first check (above), is deterministic and on by default: it blocks any source write with no test, but enforces test *existence* only. Layer 2 is the optional third-party [`tdd-guard`](https://github.com/nizos/tdd-guard) plugin, which adds LLM-judged red-green *ordering* (it reads live test results to catch implementation-before-failing-test and over-implementing). tdd-guard is opt-in — it needs an interactive `/plugin install` + `/tdd-guard:setup` plus per-project test reporters, so a scaffold can't auto-provision it. The two run as separate PreToolUse hooks; do not hand-add tdd-guard's command to `settings.json` (its setup registers its own hook). See the scaffold's generated `design.md` for the enable steps.

---

## 4. The GAN Architecture

### Why Separation Matters

In traditional AI code generation, the same agent writes code and decides if it works. This creates three cognitive biases:

- **Confirmation bias** — "I wrote it, so it probably works." The agent skips checks that might reveal issues.
- **Rationalization** — "It fails this test, but the test is probably wrong." The agent explains away failures instead of fixing them.
- **Scope creep** — "While I'm here, let me also improve this." The agent gold-plates instead of delivering what was specified.

The GAN architecture eliminates these biases structurally:

```
Generator                              Evaluator
(writes code — cannot evaluate)        (runs app — cannot write code)
     |                                      |
     |-- 1. Propose sprint contract ------->|
     |<-- 2. Evaluator finalizes -----------|  (negotiation: exactly 2 calls)
     |                                      |
     |-- 3. Implement code + tests -------->|
     |      (TDD: red -> green -> refactor) |
     |                                      |-- 4. Start app (Docker/local/stub)
     |                                      |-- 5. Layer 1: curl API endpoints
     |                                      |-- 6. Layer 2: Playwright browser flows
     |                                      |-- 7. Layer 3: Design-critic scoring
     |                                      |-- 8. Read Docker logs on failure
     |                                      |
     |<-- 9. VERDICT: PASS or FAIL --------|  (binary — no partial credit)
     |      + structured failure JSON       |
     |                                      |
     |-- 10. Self-heal (if FAIL) ---------->|
     |       (targeted fix from failure JSON)|
     |<-- 11. Re-evaluate -----------------|
     |                                      |
     (max 3 attempts, then revert + learn)
```

### Sprint Contracts: The Agreement Protocol

Before any code is written, the generator and evaluator negotiate a **sprint contract** — a machine-readable JSON document that defines exactly what "done" means:

```json
{
  "group": "C",
  "stories": ["E3-S1", "E3-S2"],
  "features": ["F005", "F006"],
  "contract": {
    "api_checks": [
      {
        "id": "api-001",
        "method": "POST",
        "path": "/documents/upload",
        "expected_status": 201,
        "expected_body": { "document_id": "string" }
      }
    ],
    "playwright_checks": [
      {
        "id": "pw-001",
        "url": "/upload",
        "steps": [
          { "action": "navigate", "value": "/upload" },
          { "action": "fill", "selector": "getByLabel('File')", "value": "test.pdf" },
          { "action": "click", "selector": "getByRole('button', { name: 'Submit' })" },
          { "action": "assert_visible", "selector": "getByText('Upload successful')" }
        ]
      }
    ],
    "design_checks": {
      "visual_hierarchy": { "required": true, "min_score": 7 },
      "accessibility": { "required": true, "min_score": 5 }
    },
    "performance_checks": [
      { "endpoint": "/documents/upload", "max_response_time_ms": 2000 }
    ],
    "architecture_checks": {
      "layering": { "required": true },
      "typing": { "required": true },
      "folder_structure": { "required": true }
    }
  }
}
```

Negotiation is exactly 2 calls: generator proposes, evaluator finalizes. The result is immutable.

### Three-Layer Verification

The evaluator never reads source code. It only runs the application and checks observable behavior:

| Layer | What | How | Catches |
|-------|------|-----|---------|
| **1. API** | Endpoints return correct status + schema | `curl` against running app + `jsonschema` validation | Backend logic, schema mismatches, error handling |
| **2. Playwright** | UI works as user expects | Playwright MCP: navigate, click, fill, assert with semantic selectors | Frontend bugs, broken forms, missing feedback, dead buttons |
| **3. Vision** | UI has distinctive, quality design | Screenshots scored by design-critic on 4 weighted criteria | Generic templates, poor spacing, inconsistent styling |
| **4. Security** | No exploitable vulnerabilities | `security-reviewer` agent → `security-verdict.json`; gate fails on any critical/high finding | Injection, auth bypass, IDOR, SSRF, hardcoded secrets, unsafe deserialization |

On any Layer 1 or 2 failure, the evaluator reads Docker logs (or process stderr in local mode) to extract the actual stack trace. The generator receives the exact error, not "got 500 instead of 201."

The Layer 4 security gate is enforced by `/evaluate` and the `/auto` loop: a functional pass with an open critical/high finding is still a FAIL, and the finding routes into the same self-healing loop. The advisory `security-guidance` plugin (in-session warnings) layers *in front of* this gate but does not satisfy it — only the `security-reviewer` agent's verdict does.

At `/gate`, when the diff crosses a security/data/API boundary, both the evaluator and security-reviewer axes re-verify across 3 independent fresh-context instances (no shared conversation between them) and resolve by majority vote (2-of-3) — the two axes can legitimately disagree with each other, but neither is decided by a single instance's blind spot. An instance that errors or times out fails safe to the stricter outcome (BLOCK/FAIL) for its axis. The vote is recorded in `specs/reviews/reverify-votes.json` alongside the existing `security-verdict.json` and evaluator report, which are still sourced from the first-spawned instance so every existing consumer is unaffected.

### The Design-Critic GAN Loop

For frontend groups, after the main ratchet passes, the design-critic runs a secondary GAN loop with weighted scoring:

`Score = (DQ × 1.5 + O × 1.5 + C × 0.75 + F × 0.75) / 4.5`

| Criterion | Default Weight | Measures |
|-----------|---------------|----------|
| Design Quality | 1.5× | Coherent visual identity, color palette, layout |
| Originality | 1.5× | Distinctive vs template defaults |
| Craft | 0.75× | Typography hierarchy, spacing, alignment |
| Functionality | 0.75× | User can understand and complete tasks |

Two pass conditions must BOTH be met: weighted average ≥ 7 AND every individual criterion ≥ 5. Calibration anchors at score 5, 7, 9 in `evaluate/references/scoring-examples.md`. Plateau detection (no improvement across 3 iterations) triggers a forced pivot.

---

## 5. The Karpathy Ratchet

### Concept: Monotonic Progress

Every quality metric can only move forward, never backward. The ratchet has 8 sub-gates run in sequence:

```
Gate 1: Unit tests pass          [all modes]     -- pytest / vitest exit 0
Gate 2: Lint + types clean       [all modes]     -- ruff / mypy / tsc exit 0
Gate 3: Coverage >= baseline     [all modes]     -- floor 80%, never drops
Gate 4: Architecture alignment   [full/lean]     -- one-way layer imports
Gate 5: Evaluator verdict        [full/lean]     -- API + Playwright vs running app
Gate 6: Design critic score      [full only]     -- vision scoring (4 criteria)
Gate 7: Security gate            [full/lean]     -- security-reviewer, fail on critical/high
Gate 8: Fresh-context code review [full/lean]    -- code-reviewer, fail on structure/correctness BLOCKs
```

**Coverage as verification, not just testing.** Steve Krenzel's framing: "100% coverage isn't a goal — it's verification that the agent double-checked every line it wrote." Floor 80%. Baseline ratchets upward. Below-baseline commits are rejected.

**Architecture enforcement** is one-way:

```
Types (Layer 1) → Config (Layer 2) → Repository (Layer 3) → Service (Layer 4) → API (Layer 5) → UI (Layer 6)
```

The `verify-on-save` hook scans every file edit and the git `pre-commit` gate re-scans staged files. Upward imports are blocked.

**Learned rules**: when the same error appears 2+ times in `failures.md`, the harness extracts a permanent directive into `learned-rules.md`. Rules are **monotonic** — never deleted, only added. They become institutional knowledge injected into every future agent prompt — not just `/auto`'s teammate spawns, but every pipeline entry point that can touch production code (`/change`, `/vibe`, `/feature`), so a rule learned in one lane can't be silently unlearned by working through another.

### Self-Healing Loop

On FAIL, the ratchet doesn't immediately revert. It attempts targeted self-healing (max 3 attempts), each with a different fix strategy. `prior_attempts` accumulation prevents the same fix being tried twice. After 3 failures the change is reverted, a learned rule is extracted, the group is marked BLOCKED, and `/auto` continues with the next unblocked group.

The 10 failure categories: `lint_format`, `type_error`, `import_error`, `key_error`, `timeout`, `connection_refused`, `validation_error`, `assertion_error`, `api_transient`, `api_permanent`. Each maps to a distinct auto-fix.

### Session Chaining

Recovery cost ≈ 700–1000 tokens per iteration. `/auto` reads:

1. `.claude/program.md` — constraints may have changed mid-run
2. `.claude/state/learned-rules.md` — inject verbatim into all agent prompts
3. `claude-progress.txt` — last session block only
4. `features.json` — what's passing, what's failing
5. `specs/stories/dependency-graph.md` — what's the next unblocked group

---

## 6. Agent Teams and Phased Execution

### Why Parallel

Sequential: 3 stories × 3h = 9h.
Phased agent team: 3 parallel teammates = 4h.

### Dependency Handshake

Before spawning teammates, the generator analyzes `component-map.md` for:

1. **Shared files** — files appearing in 2+ stories get a designated integrator.
2. **Interface boundaries** — `Produces:` / `Consumes:` annotations define data flow.
3. **Micro-DAG** — teammates grouped into execution phases.

```
Phase 1: teammate-upload   (no upstream deps)
            produces: UploadResult {document_id, status}
Phase 2: teammate-process  (consumes UploadResult)
            produces: ProcessedDocument {document_id, fields}
Phase 3: integration       (merges shared types.py)
```

Within a phase, teammates run in parallel (max 5). Only cross-phase dependencies are sequential.

### Teammate Isolation

Each teammate receives: story acceptance criteria, owned files (no overlap), learned rules verbatim, quality principles from `code-gen/SKILL.md`, upstream interface contracts (Phase 2+ only), API integration patterns (if relevant). No teammate reads the full codebase.

---

## 7. Verification Modes

The evaluator supports 3 modes for reaching the running application:

| Mode | When to Use | How It Works |
|------|------------|-------------|
| **docker** (default) | Full-stack containerized apps | `docker compose up`, health-check retry, `docker compose logs` for error context |
| **local** | Dev servers, serverless emulators | Start processes via configured commands, health-check against URLs, process stderr for errors |
| **stub** | No runnable backend (serverless, external-only) | Auto-generate mock server from `api-contracts.schema.json`, validate request/response shapes |

Configured in `project-manifest.json` under `verification.mode`. All modes use the same health-check retry loop (5 attempts, exponential backoff).

---

## 8. Execution Modes

| Mode | Cost | Gates | Agent Teams | Evaluator | Design Critic | When to Use |
|------|------|-------|-------------|-----------|---------------|-------------|
| **Full** | $100–300 | All 7 | Yes (phased) | Per group | Per group | Production apps, complex requirements |
| **Lean** | $30–80 | All 7 except design-critic | Yes | Per group | Skipped | Backend-heavy, internal tools |

Both modes run every gate including the Gate 7 security review and the evaluator; **Lean** differs only by not running the design-critic vision loop. (The former Solo and Turbo modes were removed — Solo skipped the security gate and the evaluator, and Turbo deferred all verification to the end; both defeated the ratchet. For small/quick work use `/build --lite` or `/vibe` instead.)

**Fast-lane optimization:** for trivial changes (lint, docs, type annotations), gates 4–6 are skipped on that commit only. Detection: `git diff --name-only` shows only non-code files, or the commit message matches lint/doc patterns.

---

## 9. Lane Selection

The harness has three pre-pipeline lanes alongside the full SDLC pipeline.

| Lane | Use it when | Outputs | Cost |
|---|---|---|---|
| `/brownfield` + `/code-map` + `/seam-finder` | Any substantial work in an existing codebase | `specs/brownfield/code-graph.json`, `architecture-map.md`, `risk-map.md`, `change-strategy.md`, `seams-<goal>.md` | Cheap (read-only graph build) |
| `/build --lite` | New project, ≤5 stories, single group, single module, no DB/auth/billing | Compressed BRD (≤50 lines), 3–5 stories in Group A, `folder-structure.md`, `component-map.md`, `api-contracts.md` | Small |
| `/vibe` | Tiny safe edits: ≤3 files, <150 lines, no new workflow, no auth/billing/migrations | Micro-contract + narrow diff + targeted verification | Tiny |
| `/brd` → `/spec` → `/design` + `/test --plan-only` → `/auto` → `/test --e2e-only` | Everything else | Full BRD, stories, dependency graph, design + test plan (parallel), autonomous build, then E2E tests | Highest |

Escalation contract: if the work outgrows the chosen lane (lite turns into 7 stories, vibe touches a migration), stop and re-enter via the larger lane. Lanes never silently grow.

---

## 10. Optional Framework Skill Packs

`/scaffold` asks whether to install framework-specific skill packs alongside the harness. These are **opt-in** and ship through the open `skills` CLI; with `-a claude-code` they land inside `.claude/skills/<pack-prefix>-*` directly alongside the 26 harness skills. If the install is blocked (auto-mode classifier), `/scaffold` records the intent in `project-manifest.json#framework_skill_packs` and `/install-framework-packs` can re-run installs idempotently.

| Pack | Source | Skill count | Trigger phrases |
|---|---|---:|---|
| LangChain / LangGraph / DeepAgents | `cwijayasundara/agent_cli_langchain` | 9 | "scaffold a langgraph agent", "build an agent using ADK middleware", "add LangSmith evals" |
| Google ADK | `google/agents-cli` | 7 | "start a new ADK project", "deploy my ADK agent", "publish to Gemini Enterprise" |

Each pack carries its own scaffolder, workflow, code, deploy, observability, and (where applicable) eval/publish skills. They do **not** replace the harness — they layer on top, giving the same `/auto` ratchet loop framework-aware code generation.

Install command (executed by `/scaffold` if the user selects the pack):

```bash
npx --yes skills add -y --agent claude-code <github-org/repo>
```

The chosen packs are recorded in `project-manifest.json` under a `framework_skill_packs` array so future enhance/upgrade flows can see what was installed.

**Design rationale:** the harness defines *how to build software with discipline*; the framework packs define *how to build software with this framework*. Composing them turns the harness into a per-framework agent factory without duplicating SDLC primitives.

---

## 11. Two Runtimes Built on One Scaffold

### Local Runtime (default)

A solo engineer (or small pod) drives Claude Code directly:

```
$ claude --plugin-dir ~/claude_harness_eng_v5/.claude
> /scaffold                # one time
> /brd                     # or /build --lite, or /brownfield
> /spec                    # human gate
> /design                  # human gate
> /auto                    # autonomous ratchet loop
```

Proof lives on disk (`specs/reviews/`, `iteration-log.md`, commits). Reviews and merges happen in the same chat or via the local git tooling.

### Agent-Factory Runtime (Linear or Jira)

When the team wants a visible queue and parallel execution across machines, the harness exposes a tracker contract:

1. **Publish step (one time)** — Inside Claude Code, run `/tracker-publish`. The skill reads the approved `dependency-graph.md` + `component-map.md` and creates **one tracker issue per dependency group**. Group dependencies become tracker blockers. The mapping is written to `.claude/state/tracker-map.json`.
2. **Orchestrator step (continuous)** — `symphony_clone` runs as a Docker container. Each tick:
   - polls Linear for issues in the configured ready state + ready label whose blockers are terminal,
   - claims the top eligible issue, moves it to `In Progress`,
   - clones the repo to `/workspaces/<issue-key>`, creates `agent/<issue-key>`,
   - runs `claude --print --permission-mode bypassPermissions "<generated /auto prompt>"`,
   - reads `.claude/state/tracker-runs/<group>/result.json`,
   - pushes the branch, opens a GitHub PR, comments proof back, moves the issue to `Human Review` (or `Blocked`).

   The orchestrator routes each eligible issue by label: `agent-plan` issues follow the PRD planning path; `agent-ready` issues follow the groomed-group execute path; a third label, `agent-feature` (configurable via `FEATURE_LABEL`), routes a raw brownfield change ticket to `/feature "<title>" --auto` — one issue → one PR — distinct from the `plan` and `execute` paths.

The orchestrator's safety boundaries:

- Reads secrets from `.env`, never from committed files.
- Will not dispatch unless the tracker issue is in the configured ready state, has the configured ready label, and all blockers are terminal.
- Will not mark work `Done` — `Human Review` is the terminal autonomous state. Merge stays human.
- Resolves workflow states through configurable aliases (`REVIEW_STATE_CANDIDATES`, `BLOCKED_STATE_CANDIDATES`) so different Linear workspaces map cleanly.
- Retries failed runs with exponential backoff (`MAX_RETRY_ATTEMPTS`, `RETRY_BASE_DELAY_MS`, `RETRY_MAX_DELAY_MS`) before moving an issue to `Blocked`.
- Persists per-run state in `STATE_DIR/state.json` and JSONL logs in `LOG_ROOT/orchestrator.jsonl`. An optional dashboard exposes `/`, `/health`, `/state` when `STATUS_PORT` is set.

### Packaging contract

The `symphony_clone/` directory is **versioned alongside the harness but never copied into target projects by `/scaffold`**. The target repo only carries:

```
.claude/                        # skills · agents · hooks · templates · state
specs/stories/dependency-graph.md
specs/design/component-map.md
features.json
.claude/tracker-config.json     # only if tracker mode was selected at scaffold time
.claude/state/tracker-runs/     # written by /auto runs in tracker mode
```

The orchestrator is infrastructure. The scaffold is the contract.

### Result contract

`/auto --group <id>` (in tracker mode) writes:

```text
.claude/state/tracker-runs/<group>/result.json
```

Success:

```json
{
  "group": "A",
  "status": "human_review",
  "summary": "Implemented group A.",
  "branch": "agent/ENG-101",
  "commit": "abc123",
  "tests": ["npm test: passed"],
  "reports": ["specs/reviews/evaluator-report.md"],
  "features_updated": ["F001"]
}
```

Blocked:

```json
{
  "group": "A",
  "status": "blocked",
  "summary": "Could not complete group A.",
  "blocker": "Missing required API credential for integration verification.",
  "tests": [],
  "reports": []
}
```

---

## 12. State Files

| File | Growth | Purpose |
|------|--------|---------|
| `program.md` | Edited by human | Karpathy bridge — edit to steer `/auto` mid-run |
| `iteration-log.md` | Append-only | Full history: stories, verdicts, coverage, commits |
| `learned-rules.md` | Monotonic (never deleted) | Defensive rules extracted from repeated failures |
| `failures.md` | Append-only | Raw failure data for pattern extraction |
| `.claude/state/pending-reviews.jsonl` | Recreated/cleared by hooks | Files changed this turn that require reviewer agents |
| `coverage-baseline.txt` | Ratcheted upward | Never drops; floor is 80% |
| `features.json` | Updated per evaluation | Granular pass/fail with failure_layer and timestamps |
| `claude-progress.txt` | Appended per session | Session chaining recovery context |
| `sprint-contracts/` | One file per group | Negotiated done-criteria; immutable after negotiation |
| `specs/reviews/eval-scores.json` | Appended per critique | User-visible design scores over time |
| `calibration-profile.json` | Edited by human/scaffold | Scoring weights, threshold, plateau detection config |
| `.claude/state/tracker-map.json` | Updated by `/tracker-publish` | Maps local dependency groups and stories to Linear/Jira issue keys |
| `.claude/state/tracker-runs/<group>/result.json` | Written by `/auto --group <id>` in tracker mode | Proof contract consumed by the external orchestrator |

---

## 13. Superpowers Integration

The harness integrates with the [Superpowers](https://github.com/obra/superpowers) plugin to augment key pipeline stages with proven developer workflow patterns.

| Pipeline Stage | Superpowers Skill | Purpose |
|---|---|---|
| `/brd` (Step 0) | `superpowers:brainstorming` | Explore user intent and hidden assumptions before the Socratic interview |
| `/design` (Step 0) | `superpowers:brainstorming` | Evaluate architectural trade-offs before committing to a design |
| `/implement` (Step 0) | `superpowers:writing-plans` | Produce structured implementation plan before spawning agent teams |
| `/implement` (teammates) | `superpowers:test-driven-development` | Red-green-refactor enforced in every teammate prompt |
| `/change --issue N` (Step I2) | `superpowers:systematic-debugging` | Root cause analysis before writing failing test |
| `/refactor` (Step 4) | `superpowers:writing-plans` | Structured refactoring plan before execution |
| `/auto` (self-healing) | `superpowers:systematic-debugging` | Diagnose failure root cause before each fix attempt |
| `/auto` (completion) | `superpowers:verification-before-completion` | Evidence-based verification before claiming build complete |
| evaluator agent | `superpowers:verification-before-completion` | Run all checks and confirm output before emitting PASS verdict |
| generator agent | `superpowers:test-driven-development` | TDD workflow invoked before writing implementation code |

The harness handles **what** to build (SDLC pipeline, sprint contracts, ratchet gates). Superpowers handles **how to think about building it** (structured exploration, disciplined debugging, verification discipline). Without superpowers the harness still works; with it, agents explore alternatives before committing and verify evidence before claiming success.

---

## 14. Graph-Grounded Brownfield Discovery

Brownfield discovery is the entry point for existing-codebase work. v5 uses graph-grounded artifacts so planner and generator agents cite evidence instead of inferring architecture from filenames.

```text
/brownfield
    |
    v
/code-map  --> AST indexer (Python ast + tree-sitter wheels) | regex fallback
    |
    v
specs/brownfield/code-graph.json   (+ per-file symbol records with line ranges)
    |
    +--> symbol-map.md        (fan-in-ranked signatures, token-budgeted)
    +--> skeletons/*.skel.md  (god files: signature-only views, Read(offset,limit) slices)
    +--> dependency-graph.md
    +--> coupling-report.md   (hubs, cycles, unstable hubs, dead-code candidates)
    |
    v
architecture-map.md, risk-map.md, change-strategy.md
    |
    | freshness: PostToolUse(Edit|Write) appends to .claude/state/graph-dirty.jsonl;
    | Stop/SubagentStop (graph-refresh.js) re-parses only dirty files and
    | re-renders symbol-map.md — the graph never goes stale mid-build.
    |
    v
/seam-finder "<goal>"  -->  seams-<goal>.md
```

The vendored fallback has zero npm dependencies and covers Python, Node, TypeScript, Java, C#, and Go. It emits file/import/top-level-symbol graphs for all six; Python also gets coarse call edges and `__init__.py` re-export handling. If `graphify` or `hex-graph` is available, `/code-map` prefers the higher-fidelity producer and projects the result into the same schema.

`/seam-finder` ranks candidate cut-points for a concrete goal using Fowler-style scoring:

| Component | Weight | Meaning |
|---|---:|---|
| Observable | 0.4 | Boundary heuristic: routes, controllers, queues, repositories, services, adapters |
| Funnel | 0.4 | Normalized fan-in + fan-out from `code-graph.json` |
| Asymmetry | 0.2 | Read/write imbalance; pure readers or writers are easier to split |
| Goal bump | ×1.5 | Candidate path or symbols match the requested goal |

Agent contract: in brownfield mode, "module X depends on Y" claims must cite `code-graph.json` edge evidence. Refactor targets, hub warnings, cycle warnings, and first safe next steps must read from `coupling-report.md` and `seams-<goal>.md` rather than being invented.

---

## 15. Pipeline Commands

| Command | Purpose | Human Gate? | Superpowers |
|---------|---------|-------------|-------------|
| `/scaffold` | Bootstrap a project | Yes (8 questions) | — |
| `/brd` | Socratic interview → BRD | Yes | brainstorming |
| `/spec` | BRD → stories + dependency graph + features.json | Yes | — |
| `/design` | Architecture + schemas + mockups (runs parallel with `/test`) | Yes | brainstorming |
| `/test` | Test plan + cases + fixtures (`--plan-only`) or Playwright E2E (`--e2e-only`) | No | — |
| `/implement` | Code generation with agent teams | No | writing-plans, TDD |
| `/evaluate` | Run app, verify sprint contract | No | verification |
| `/gate` | Evaluator + security review (renamed from `/review`) | No | — |
| `/deploy` | Docker Compose + init.sh | No | — |
| `/build` | Full 10-phase pipeline | Phases 1–3 | verification |
| `/auto` | Autonomous ratcheting loop | No (reads program.md) | debugging, verification |
| `/build --lite` | Compressed greenfield lane (small projects) | One approval | — |
| `/vibe` | Controlled small-change lane | Micro-contract | — |
| `/brownfield` | Graph-grounded map of an existing codebase | No | — |
| `/code-map` | Deterministic dependency graph | No | — |
| `/seam-finder` | Ranked cut-points for a concrete goal | No | — |
| `/change` | Behavior change (story or --issue N) | No | systematic-debugging (issue mode) |
| `/refactor` | Quality-driven refactoring | No | writing-plans |
| `/tracker-publish` | Publish approved dependency groups to tracker issues | Yes | — |
| `/install-framework-packs` | Re-attempt installs for framework packs declared in `project-manifest.json` (idempotent) | No | — |

---

## 16. Quality Principles

Detailed rules in `.claude/skills/code-gen/SKILL.md`. Summary:

1. **TDD mandatory** — Write failing tests FIRST, then implement. Red-green-refactor.
2. **100% meaningful coverage** — Every line verified by a test. 80% hard floor.
3. **Small modules** — One file = one responsibility. Warn 200, block 300 lines.
4. **Static typing** — Zero `any` in TypeScript. Full annotations in Python.
5. **Functions under 30 lines** — Decompose into named, testable subfunctions.
6. **Explicit error handling** — Typed error classes, no bare exceptions.
7. **No dead code** — Every line traces to a story.
8. **Self-documenting** — Good names over comments, types as documentation.
9. **Structured logging** — `extra` dicts, not f-strings. Log at service boundaries.
10. **No silent fallbacks** — Failed operations raise typed errors. Callers decide.

---

## 17. What Belongs Where — Quick Reference

| If you're a… | You touch | You don't touch |
|---|---|---|
| Solo engineer (local mode) | Claude Code chat, `program.md`, BRD interview answers | `symphony_clone/`, Linear |
| Engineering pod (local mode) | Same + branch/PR review on GitHub | `symphony_clone/`, Linear |
| Agent-factory operator | `.env` for symphony_clone, Linear workflow states, tracker config | Application code |
| Reviewer (factory mode) | Linear proof comments, GitHub PR diff, evaluator/security reports | Generated code (read-only) |
| Framework user (LangChain/ADK) | The framework pack's `*-scaffold` / `*-code` skills, plus all of the above | Internal harness skill bodies |

The scaffold gives every persona a deterministic surface, then composes them through the same `/auto` ratchet.
