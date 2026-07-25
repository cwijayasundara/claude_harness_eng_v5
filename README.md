# Claude Harness Engine v6

A Claude Code plugin for building and changing software with a generator/evaluator loop, ratcheting quality gates, and explicit human review before merge.

Current version: `3.0.0`

> **v6 is a descendant of v5, not a rewrite.** It carries the full history (`v5-preserve` is an
> ancestor of `main`), so every change is reviewable against a real baseline. What changed is
> structural: the harness is now a **51-unit kernel plus nine opt-in packs**, the boundary
> between them is mechanically enforced, and every control records whether it actually fires.
> See [Kernel and packs](#kernel-and-packs) and [Does a control earn its place?](#does-a-control-earn-its-place).
>
> **Breaking:** scaffold profiles changed meaning — `core` no longer installs the brownfield,
> compliance or vertical packs. See the profile table below before upgrading a project.

**Field guide (navigable HTML):** open [docs/harness-guide.html](docs/harness-guide.html) in a browser — architecture diagrams, lane picker, GAN/ratchet under the covers, multi-dimension **vs Devin** comparison, playbooks, and glossary. Offline; no build step.

> **Doc map:** this README is canonical for *install & usage*. For the control system (gates/sensors) see `HARNESS.md`; for architecture rationale see `design.md`; for the "which doc for what" index see [`CODEBASE_MAP.md`](CODEBASE_MAP.md).

## Start Here

### Recommended: install as a local plugin

This repo ships a **local marketplace** (`.claude-plugin/marketplace.json`), so you can install the harness as a persistent Claude Code plugin — it stays loaded across sessions with no `--plugin-dir` flag to retype:

```bash
git clone https://github.com/cwijayasundara/claude_harness_eng_v6.git ~/claude_harness_eng_v6

# Register the local marketplace (points at your clone), then install the plugin
claude plugin marketplace add ~/claude_harness_eng_v6
claude plugin install claude_harness_eng_v6@claude-harness-local
```

`claude plugin install` defaults to `--scope user` (available in every project). Use `--scope project` to write it into a specific project's `.claude/settings.json` (shared with everyone who clones that project), or `--scope local` for a gitignored per-project install. After pulling new commits, refresh with `claude plugin marketplace update claude-harness-local`.

Then inside Claude Code:

```text
/scaffold
```

If your Claude Code UI shows a namespaced command, use `/claude_harness_eng_v6:scaffold`.

Installing gives you every harness *command*; `/scaffold` still installs the lean `core` surface into your project by default (`/scaffold --full` for the full set). The deterministic gate hooks wire up when `/scaffold` copies `.claude/` into a target project.

#### Quick one-session load (no install)

To try it without installing, point `--plugin-dir` at the checked-in `.claude/` directory — the plugin root that holds `.claude-plugin/plugin.json`. Per the [plugins reference](https://code.claude.com/docs/en/plugins-reference#plugin-caching-and-file-resolution), this loads the plugin for the current session only:

```bash
claude --plugin-dir ~/claude_harness_eng_v6/.claude
```

#### Optional: start in auto mode

Add `--permission-mode auto` to launch a mostly-hands-off session (auto-runs actions except ones a background classifier flags — force pushes, credential leaks, prod deploys, destructive commands):

```bash
claude --permission-mode auto
```

To make it the default so you don't pass the flag each time, set it in your **user-level** `~/.claude/settings.json`:

```json
{ "permissions": { "defaultMode": "auto" } }
```

> **Not the project's `.claude/settings.json`.** Claude Code (v2.1.142+) *silently ignores* `defaultMode: "auto"` from a repo's `.claude/settings.json` or `.claude/settings.local.json` — a checked-in config is not allowed to escalate itself to auto mode (it just starts in `default`, with no error). So `auto` **cannot be scoped to a single repo** via committed settings: user-level `~/.claude/settings.json` turns it on for *every* project, so to keep auto scoped to one repo pass the `--permission-mode auto` flag (or a shell alias) at launch instead.

Modes, least → most permissive: `plan`, `default`, `acceptEdits`, `auto`, `bypassPermissions`. Prefer `auto`; reserve `bypassPermissions` (skips *all* checks) for isolated, offline containers only. Auto mode skips per-action prompts but does **not** bypass the harness's own pipeline gates (`/build` phases 1–3, `/gate` before merge).

### Optional: build a pruned SKU (core / full / lite)

`--plugin-dir <clone>/.claude` loads the **full** harness surface. To load a lean/pruned loadout instead — or to produce a distributable tree/tarball — build a SKU first. **`dist/` is a generated build artifact: it is gitignored and absent from a fresh clone** until you run `npm run package:skus`:

```bash
npm run package:skus
# → dist/skus/harness-core , dist/skus/harness-lite , dist/skus/harness-full

cd ~/my-project
# Point at the packaged SKU root itself — NOT a .claude/ subfolder.
# package:skus flattens .claude/* up to the package root (plugin.json lives at
# harness-core/.claude-plugin/), so do NOT append /.claude here.
claude --plugin-dir /path/to/claude_harness_eng_v6/dist/skus/harness-core
```

| SKU | Load (`--plugin-dir`) | Use when |
|---|---|---|
| **harness-core** (default product) | `dist/skus/harness-core` | Building/changing software |
| **harness-full** | `dist/skus/harness-full` | Need optional skills / full surface |
| **harness-lite** | `dist/skus/harness-lite` | Mockups / ARB docs / research only |

SKU vocabulary: [docs/product-skus-and-tiers.md](docs/product-skus-and-tiers.md).  
Publish process (marketplace / tarball / interim): [docs/marketplace-publish.md](docs/marketplace-publish.md).

For an arbitrary selection — including **kernel-only** — compose one directly instead:

```bash
node tools/pack-install.js --list                          # what each pack adds
node tools/pack-install.js --out ~/lean                    # kernel only: 51 units, 79 files
node tools/pack-install.js --out ~/bf --packs brownfield   # kernel + one pack
```

Both paths read the same `.claude/config/packs.json`, so a SKU and a composed install can
never disagree about what a profile contains.

## Kernel and packs

The harness is a **kernel** plus nine opt-in **packs**. The kernel is what has usage evidence:
the three lanes (`/vibe`, `/change`, `/gate`), `/refactor`, `code-gen`, the `implementer` /
`code-reviewer` / `security-reviewer` agents, the five session hooks, and the commit gate.

| Profile | Units | Adds |
|---|---:|---|
| `kernel` | 51 | the lanes and the commit gate — nothing that assumes a pipeline, an existing codebase, or a client mandate |
| `core` | 220 | planning, verification, legacy-discipline, telemetry, scaffold |
| `brownfield` | 251 | + brownfield (code-graph, nav, seams) |
| `full` | 286 | + compliance, domain, dist |

**One structural rule holds it together:** *a kernel unit may not hard-reference a pack
unit — and, more generally, no composed profile may hard-reference a pack it does not
install (profile-closure).* Both are enforced; declared exceptions live in `accepted_edges`.

```bash
node tools/check-partition.js --strict     # exit 1 on a kernel violation OR a profile break
```

"Hard" means it would break if the target were gone — `require()`, `node .claude/scripts/x.js`,
a `subagent_type` dispatch. A remediation string that names a script, or a doc link to another
skill, is **soft**: uninstalling the pack makes it a stale message, not a crash. Guarded loads
(`packRun(...)`, `try { require(...) } catch`) are reported as optional edges rather than
violations, so correct code is never rewritten just to satisfy the checker.

A pack that is not installed is *reported*, never silently dropped:

```
skip  duplication-ratchet  [brownfield] — "brownfield" pack not installed
gate-checks: 0 passed, 0 blocked, 0 warn, 3 skipped (pack not installed)
```

Justified exceptions live in `accepted_edges[]` in `packs.json`, each requiring a written
reason, printed on every run, and reported **STALE** once the edge disappears.

## Does a control earn its place?

Every control now records whether it **ran**, whether it **blocked**, and how long it took —
across session (every write), commit, and integration (`/gate`) cadences.

```bash
npm run sensor-value
```

```
NEVER FIRED (never ran — check wiring or retire): …
NEVER BLOCKED (ran but never caught anything — candidate shelfware): …
SLOW (>=500ms average — correct but costly): …
BLOCKS OFTEN (>50% of runs — real systemic issue, or false-blocking): …
```

This is the subtractive half of the loop: without it, no control can ever be removed, because
nothing shows which ones are inert. The report refuses to nominate anything below its evidence
threshold, and **BLOCKS OFTEN is surfaced for a human rather than auto-judged** — the ledger
cannot tell a correct block from a wrong one, and pretending otherwise is how a meter starts
lying.

### Upgrading an already-scaffolded project

Inside Claude Code (scaffolded projects with the skill installed):

```text
/scaffold-upgrade
/scaffold-upgrade --apply
```

Or from a shell — refresh hooks/scripts/git-hooks/agents without wiping `project-manifest.json` or `.claude/state/`:

```bash
# dry-run (default)
node /path/to/claude_harness_eng_v6/.claude/scripts/scaffold-upgrade.js --target ~/my-project
# apply
node /path/to/claude_harness_eng_v6/.claude/scripts/scaffold-upgrade.js --target ~/my-project --apply
# also refresh skills (larger prompt surface change)
node …/scaffold-upgrade.js --target ~/my-project --apply --include-skills
```

## Dashboard

### 1. Pick The Scaffold

```
What are you installing into?
├── New product repo / app / service / CLI          → /scaffold            (core)
├── Existing codebase you will keep changing        → /scaffold --brownfield
├── Need the compliance or vertical packs too       → /scaffold --full
└── Want telemetry env + dashboard files            → /scaffold --telemetry
```

Default answer: `/scaffold` (core). **Changed in v6:** `core` is greenfield product work and no
longer ships the brownfield pack — pick `--brownfield` when you are working in an existing
codebase and want the code-graph, nav and seam tooling.

In v5 these profiles had drifted into near-synonyms: `core` spanned all eight packs, so
`brownfield` added a single skill and its own test described it as "a backward-compatible alias
for core". They are distinguishable again, and negative assertions keep them that way.

### 2. Pick The Work Route

```
Are you building something NEW?
├── Yes → small scope (CLI, library, ≤5 stories)?  → /build --lite
│         otherwise                                 → /build
│
└── No (existing codebase) → normal route: /feature "<request>"
          first time here? /feature refreshes the DeepWiki/code-map first, then:
          ├── tiny safe edit (≤3 files, <150 lines, no auth/API) → /vibe
          ├── structure only, no behavior change                 → /refactor
          ├── one bounded behavior change — the DEFAULT lane,
          │   even for auth / API / migration work               → /change  (add --issue N for a GitHub bug)
          └── multi-story scope: >~2–3 stories, spans many
              modules, or a new subsystem                        → /build (brownfield-aware)
```

**Sensitivity does not force the heavy pipeline — only scale does.** A single bounded change belongs in `/change` even when it touches auth, a public API, or a migration; that sensitivity raises the *review tier inside* `/change` (adversarial review, security-reviewer, feature-flag defaults), it does not send you to `/brd→/spec→/design`. The full pipeline is for work that genuinely needs more than ~2–3 stories, spans many modules, or introduces a new subsystem. See `/change` Step 0 for the exact auto-routing table.

Not sure? Describe the request plainly. The harness should classify the lane before it edits.

**Z/L continuum (team PR placement):** you are not “Team vibe” or “Team read every line” as a permanent identity — **each task** gets a score and a band (L / M / Z), then a harness lane and a human read plan. One-page rubric: [docs/zl-continuum-rubric.md](docs/zl-continuum-rubric.md).

## Command Cards

The public surface is intentionally small:

```
New product          → /build
Existing product     → /feature "<request>"
Sprint N of an existing product → /sprint <prd-file>
Verify/review        → /gate
```

The other commands below are still available, but the harness should usually route to them for you.

| Command | Use when | What happens |
|---|---|---|
| `/scaffold` | New target repo setup | Installs the lean core harness, settings, hooks, state seeds, manifest, and project guide |
| `/build --lite "<idea>"` | Small greenfield project | Short interview, compact plan, one group, then `/auto` |
| `/build <prd> --lite --auto` | Small PRD, hands-off | Headless lite: compressed plan (≤5 stories, one group, no interview/gate) -> PR; auto-escalates to the full `--auto` pipeline if the PRD exceeds lite scope |
| `/build <prd>` | Normal greenfield build | BRD -> stories -> design/test plan -> `/auto`, with human gates |
| `/build <prd> --auto` | PRD is ready and you want hands-off | PRD -> PR with no human approval gates; machine gates still block red builds |
| `/sprint <prd-file>` | Next PRD for an existing (harness-built or brownfield) product | Grounds the PRD against the prior sprint's requirements, amends the living design with a human-reviewed diff (never regenerates it), then `/auto` |
| `/feature` | Normal existing-code feature/change. Run as `/feature "<request>"` | Refreshes committed DeepWiki/code-map, creates or publishes story, routes to the right lane, gates, opens PR |
| `/brownfield` | Discovery-only map of an existing repo | Delegates graph/wiki generation to `/code-map`, writes short architecture/test/risk/change strategy, stops before code |
| `/code-map` | Agent needs deterministic repo map only | Produces `code-graph.json`, `symbol-map.md`, and `wiki/WIKI.md` |
| `/vibe` | Very small safe edit | Controlled fast lane for tiny changes |
| `/change` | Behavior change in existing code | Test-first change route; use `--issue N` for a GitHub bug |
| `/refactor` | No behavior change | Behavior-preserving cleanup with coverage and refactor-purity gates; use **`/refactor --mechanical`** for bulk pattern→pattern ports (`specs/migrate/` mapping + 3-file canary) |
| `/gate` | Before merge or after manual edits | Evaluator + **tiered dual** fresh-context code review (auto on large/security/`strict` diffs) + observability/perf-smell ratchets; security review when the diff crosses a security/data/API boundary (3-instance majority vote when triggered); always ends with **quality-card** + logical **walkthrough** + `docs/CODEBASE.md` refresh. Renamed from old harness `/review` to avoid native `/review` collision |
| `/fix-diagnostics` | Large lint/type walls | Dynamic workflow over the diagnostics work queue (tsc/eslint/ruff/mypy → shards → fix); skill form: `fix-from-diagnostics`. Not a substitute for `/gate` |
| `/pr-respond <pr#>` | A harness PR has red CI or review comments | Polls checks + comments, classifies via the self-healing table, fixes, pushes, replies with evidence; bounded and budget-metered; never merges |
| `/status` | See progress | Reads current pipeline state; also available as `npm run status` |
| `/agent-readiness` | Is this codebase ready for heavy AI-agent use? | 8-pillar synthesis dashboard over signals the harness already collects; also available as `npm run agent-readiness` |

## Approval Modes

| Mode | Command | Human gates |
|---|---|---|
| Gated | `/build <prd>` | Approve BRD, stories, design/test plan |
| Semi-auto | `/build <prd> --autonomous` | One plan approval gate |
| Full-auto | `/build <prd> --auto` | Zero human gates |
| Sprint (gated) | `/sprint <prd-file>` | Approve requirement delta + decomposition, approve design amendment |
| Sprint (semi-auto) | `/sprint <prd-file> --autonomous` | One consolidated gate before the design amendment; the amendment approval itself is never skipped |

Machine gates always stay on: tests, lint/types, coverage, architecture, evaluator, design critic when enabled, adaptive/dual review, and diff review. The generator does not grade itself, and the harness does not merge for you.

**Review cost dial:** `project-manifest.json#review` — `adversarial: auto|always|never`, file/line thresholds (defaults 8 files / 200 lines), `block_merge_policy: union`. Small `/vibe` edits stay single-reviewer under `auto`.

### Unattended permissions (`settings.auto.json`)

The `--auto` / `--autonomous` flags above control **approval gates** (BRD/story/design sign-off). They do *not* remove the per-tool **permission prompts** an interactive session still raises for `Bash`, `Write`, etc. For a truly hands-off headless run there is no human to answer those prompts, so `/scaffold` ships a second, opt-in permission profile:

| File | Role | Loaded when |
|---|---|---|
| `.claude/settings.json` | Curated interactive allowlist — prompts for risky ops | Always (default) |
| `.claude/settings.auto.json` | **Unattended full-auto profile** — no permission prompts (`Bash(*)`, `Write(*)`, `Edit(*)`, … + `CLAUDE_AUTO_CONTINUE=1`, agent teams) | Only when passed explicitly |

Both files are copied into every scaffolded project (`scaffold-apply.js`). Claude Code does **not** auto-load `settings.auto.json` — you opt in per run:

```bash
claude -p "/build docs/prd.md --auto" --settings .claude/settings.auto.json
```

It **merges over** `settings.json`, so the deterministic gate hooks (`pre-write-gate`, `pre-bash-gate`), git hooks, the `/auto` ratchet, security review, and pre-PR verify all still fire, and no PR opens over a red build.

> ⚠️ **Run it only inside an isolation boundary.** `Bash(*)` still permits *reading* host secrets (`~/.ssh`, cloud creds) and network egress — the gate hooks only constrain writes. Use it inside a container / CI runner / VM with no host secrets mounted and limited egress. **Do not** make it the default `settings.json`; interactive dev sessions keep the curated allowlist.

For long unattended PRD-to-PR runs, prefer the resilient chain launcher — see the recovery section below.

## If Your Run Dies (and What It Costs First)

`/auto` runs are resumable by design — a killed session, closed laptop, or budget stop loses nothing that was committed:

- **Just re-invoke `/auto`.** It resumes from `claude-progress.txt` (the append-only progress log every iteration writes), re-reads `features.json` and git state, and runs a startup smoke check before building on prior work. Nothing needs exporting from the dead session. (Wall-clock is metered from `.claude/state/budget-start`, which survives the dead session — a long gap counts as spend.)
- **See where it stopped** with `/status` (or `node .claude/scripts/pipeline-status.js status`), which reads the same state files.
- **Budget stops are clean stops.** Every run is metered (wall-clock, agent spawns, estimated cost via `node .claude/scripts/budget-state.js`) and stops at an iteration boundary when a cap is hit, setting `next_action: "BUDGET — …"` in `claude-progress.txt`. Raise the cap via `project-manifest.json#execution.budget` (or relaunch through `/build … --budget <spec>` / `--budget off`), then re-invoke `/auto` to resume.
- **For long unattended PRD-to-PR runs**, prefer `node .claude/scripts/build-chain.js docs/prd.md` — it starts a fresh `claude -p` process per build wave through the same progress file, so a killed process resumes at the next wave.

Default budget caps by model tier (`.claude/scripts/budget-state.js`):

| Tier | Wall-clock | Agent spawns | Est. cost |
|------|-----------|--------------|-----------|
| `cost` | 30 min | 80 | ~$8 |
| `balanced` (default) | 90 min | 200 | ~$25 |
| `max-quality` | 180 min | 400 | ~$60 |

Cost figures are surfaced estimates (Σ per-spawn receipts × tier rate), not billing data. A first `--auto` run on `balanced` that stops after ~90 minutes with `BUDGET` in `next_action` is behaving as designed — resume it or merge what's done.

## Cost per outcome (model tiers & the `fusion` preset)

Model choice is a **measured** decision, not a vibe: a per-token-cheaper worker can be *dearer per shipped story* if it needs more evaluator/self-heal cycles. Model-tier presets (`node .claude/scripts/model-tier.js <preset>`) pin one model per agent role — generation is high-volume, judgment (evaluator + reviewers + planner) stays on Opus 5 across every posture:

| Preset | Generator (lead) | `implementer` (worker) | Explorer | Judgment |
|---|---|---|---|---|
| `cost` / `enterprise` | Sonnet 5 | Sonnet 5 | Haiku 4.5 | Opus 5 |
| `balanced` (default) | Sonnet 5 | Sonnet 5 | Sonnet 5 | Opus 5 |
| `max-quality` | Opus 5 | Opus 5 | Sonnet 5 | Opus 5 |
| **`fusion`** | Sonnet 5 | **Haiku 4.5** | Sonnet 5 | Opus 5 |

`fusion` is the only preset where the per-story **worker is cheaper than the lead** ("cheap worker under a smart lead"). The lead keeps judgment on Opus while the per-story worker runs on Haiku.

## Existing-Code Flow

For sprint-by-sprint product work on an existing repo, start with `/feature "<request>"`.

`/feature` keeps the committed DeepWiki fresh, creates or publishes the story when a tracker is configured, checks the existing design before planning changes, delegates to `/vibe`, `/change`, `/refactor`, or `/build` by scope, runs tests and gates, and leaves the issue in Human Review with the PR linked.

When the next unit of work is a full PRD rather than a single request, use `/sprint <prd-file>` instead — it grounds the PRD against the prior sprint's requirements and produces a human-reviewed design amendment before any code generation, so the system evolves sprint by sprint instead of being regenerated each time.

Use `/brownfield` directly only when you want discovery without implementation. Use `/brownfield --seams "<goal>"` when you need safe cut-points before a risky change. Use `/brownfield --full` only for heavier CI/flag/perf inventory and evaluator scoring.

## Harness vs native Claude Code commands

| Need | Native Claude Code | Harness |
|---|---|---|
| Review a GitHub PR | `/review` | Use native `/review` |
| Run blocking pre-merge quality checks | - | `/gate` |
| Eyeball/run the app | `/run`, `/verify` | `/evaluate` when you need scored verification |
| Mechanical cleanup | `/simplify` | `/refactor` wraps `/simplify` with behavior-preservation gates |
| Generate only CLAUDE.md | `/init` | `/scaffold` for full harness bootstrap |

Rule: native commands own atomic actions; the harness owns orchestration, ratcheting, and writer/grader separation.

## What The Harness Protects

- TDD before production edits
- Coverage ratchet and per-diff coverage checks
- Lint/type/layer gates
- Security review before PR when the diff touches security/data/API boundaries
- Fresh-context diff review (**tiered dual adversarial** `code-reviewer` instances on large/security/`strict` diffs; implementer never self-reviews)
- **No stub-to-green** (code-gen + reviewer Iron Laws + commit-time `stub-smell-gate`)
- **No deleted/skipped tests** to green a suite (G31) and **canary-first** mechanical rollouts (G32 + implement/feature)
- **Multi-agent git safety** (no stash / reset --hard / force-push while parallel implement is active)
- **Process rules** (`.claude/state/process-rules.md`) — fix the workflow when agents misbehave, not only the tree
- **Diagnostics work queue** for large type/lint walls (`diagnostics-shard.js` + `fix-from-diagnostics` / `/fix-diagnostics`)
- Brownfield discipline: architecture claims cite `code-graph.json`
- Token waste discipline: living DeepWiki/code-map navigation, compact command/search output, and advisory warnings for broad reads or noisy raw commands
- Human review before merge

Design notes: [docs/proposals/bun-adversarial-mechanical-loops.md](docs/proposals/bun-adversarial-mechanical-loops.md) (inspired by [Bun’s Claude-assisted Rust rewrite](https://bun.com/blog/bun-in-rust)).

### Complexity dial

Commit-time ceremony is dialed by **`project-manifest.json#quality.sensor_tier`**: `minimal` · `standard` (default) · `strict`. Install boundaries are separate products (**harness-lite / core / full**). See [docs/product-skus-and-tiers.md](docs/product-skus-and-tiers.md). This monorepo dogfoods itself (Project Zero) via the root `project-manifest.json`.

**Per-save speed dial:** the `verify-on-save` hook runs the project linter/typechecker on every source write. It prefers a project-local binary (`node_modules/.bin/eslint`, `.venv/bin/ruff`/`mypy`) over the `npx`/`uv run` wrappers to skip per-call resolver overhead, falling back to the wrapper when the local binary is absent. To make saves non-blocking entirely — surfacing lint/type findings as warnings and leaving the commit gate as the enforcing checkpoint — set **`project-manifest.json#quality.verify_on_save: "advisory"`** (or `HARNESS_VERIFY_ADVISORY=1`). Architecture (layer/bounded-context) checks stay blocking regardless. The graph-refresh index rebuild is also deferred off every `SubagentStop` and coalesced into the top-level `Stop`, so agent-team runs no longer re-index once per teammate.

### Project Zero CI

Harness JS is linted and secrets-scanned in GitHub Actions:

```bash
npm ci
npm run lint                 # eslint on .claude hooks/scripts + tests
npm test
npm run agent-readiness      # regenerate readiness report
npm run agent-readiness:assert   # hard ratchet: min active pillars + no regression vs baseline
```

gitleaks runs as a separate CI job (`.gitleaks.toml`).

After a deliberate readiness improvement (new pillar becomes active), refresh the committed baseline:

```bash
npm run agent-readiness:baseline
# then commit .claude/state/agent-readiness-baseline.json
```

Runtime churn hygiene (local; `*.jsonl` is gitignored):

```bash
npm run retention:dry   # preview
npm run retention       # prune .claude/runs (>14d) and state/archive (>30d)
```

## Human trust surfaces (review without drowning in diffs)

When agents generate code, humans need **proof** and a **map** — not alphabetical PR noise:

| Command | What you get |
|---------|----------------|
| `/gate` | Full pre-merge gate; always ends with quality card + walkthrough |
| `npm run quality-card` | Single trust receipt (`specs/reviews/quality-card.md`) |
| `npm run walkthrough` | Logical change groups + severity + blast radius |
| `npm run pr-body -- --require-gate` | PR body that embeds both (exits 1 if red) |
| `npm run human-codebase` | `docs/CODEBASE.md` human homepage from the code-graph |
| `npm run ask -- "where is auth?"` | Ask the codebase (cited, slice-level) |
| `npm run observability-gate -- --staged` | Static logging/exception ratchet |
| `npm run perf-smell -- --staged` | N+1 / sync-in-async / unbounded-load smells |
| `npm run custom-sensors` | Project-defined commit-cadence sensors (`project-manifest.json#custom_sensors`, normalized sensor schema) |
| `npm run loop-health` | Loop-health signals, incl. the **biting meta-sensor** (flags commit gates that never fire / never block) and lead-turn efficiency |
| `npm run readiness-digest` | Weekly ops view of agent-readiness + card freshness |

## Token Usage Optimizer

The lean scaffold ships a scaffold-native token-saving layer, **enforced by
default** in `project-manifest.json#token_governor` (`mode: "enforced"`):

- Living navigation from `/scaffold`: placeholder or fresh `code-graph.json`,
  `symbol-map.md`, and deterministic DeepWiki, kept current as code changes.
- `/context "<question>"`: returns bounded file/line citations before broad
  source reads.
- Compress-Cache-Retrieve (CCR): raw command/search output is stored locally by
  hash under `.claude/state/context-cache/`, while the agent receives compact
  failure/search evidence first.
- `run-compact.js`: runs noisy commands and preserves raw output plus compact
  failure evidence.
- `search-compact.js`: returns grouped search hits while preserving the full raw
  search output.
- `token-advisor.js`: non-blocking `Read|Bash` hook that warns on avoidable
  broad source reads and likely verbose commands.
- `/status`: reports navigation freshness, context-cache savings, and token
  advisor warning counts.

Useful commands:

```bash
node .claude/scripts/context-pack.js "where is session validation handled?"
node .claude/scripts/run-compact.js --kind test -- npm test
node .claude/scripts/search-compact.js --pattern "validateSession" --glob "src/*.ts"
node .claude/scripts/context-retrieve.js <hash> --query "auth token"
node .claude/scripts/pipeline-status.js status
```

The optimizer is **enforced by default**: a broad repo search or source read
without a recent context pack is blocked (not merely warned), and the
`security-reviewer` is diff-scoped so a review no longer greps the whole
codebase. `token-advisor.js` still warns rather than blocks on softer signals.
Dial back to advisory with `token_governor.mode: "advisory"` in
`project-manifest.json`. See [docs/token-governor.md](docs/token-governor.md) and
[docs/token-usage-optimizer-design.md](docs/token-usage-optimizer-design.md).

## Optional Power-Ups

| Power-up | How to enable | Details |
|---|---|---|
| Telemetry dashboards | `/scaffold --telemetry` | [docs/telemetry.md](docs/telemetry.md) |
| Token Usage Optimizer / living DeepWiki / CCR | On by default | [docs/token-governor.md](docs/token-governor.md) |
| Framework skill packs | Select during scaffold, then install manually | [docs/extras.md](docs/extras.md) |
| Tracker orchestration | Configure Linear/Jira/Azure DevOps | [docs/extras.md](docs/extras.md) |
| Drift cadence workflow | Copy `.claude/templates/github-workflows/harness-drift.yml` to `.github/workflows/` | Runs drift, harness coverage, flakes, fixtures, contract drift, and optional SLO checks |
| PR-time E2E re-runs | Copied automatically by /test as .github/workflows/e2e.yml | Re-runs the generated Playwright suite on every PR |
| Unattended backlog-to-merge | Run `symphony_clone/` separately | `symphony_clone/README.md` |
| Artifact-only docs/mockups/research | Use `harness-lite` (not the same as `/build --lite` — see CLAUDE.md's Disposable Artifacts table for which one applies) | `harness-lite/README.md` |

## Testing This Harness

```bash
npm test                 # fast unit/contract suite, no live Claude
node --test test/token-compression-e2e.test.js  # local token optimizer e2e, no live Claude
npm run test:e2e:fast    # e2e contracts + safe helper tests
npm run test:routes      # scaffold + lite-auto + full-auto + gated + feature routes (live Claude)
npm run test:e2e:live    # all live route/smoke checks (live Claude, costs tokens)
npm run test:e2e:cert    # certification stack
npm run test:e2e:all     # fast -> live -> cert
```

E2E logs land in `test/e2e/results/logs/`; summary JSON lands at `test/e2e/results/e2e-pack-summary.json`. Details: [docs/testing.md](docs/testing.md).

## Deep Links

| Topic | Where |
|---|---|
| **Comprehensive field guide (HTML)** | [docs/harness-guide.html](docs/harness-guide.html) |
| **Agentic engineering white paper** | [docs/agentic-engineering-whitepaper.html](docs/agentic-engineering-whitepaper.html) · [`.md`](docs/agentic-engineering-whitepaper.md) |
| Bun-inspired adversarial / mechanical loops | [docs/proposals/bun-adversarial-mechanical-loops.md](docs/proposals/bun-adversarial-mechanical-loops.md) |
| Phase C out of core (fuzz, cgroups) | [docs/proposals/bun-phase-c-out-of-core.md](docs/proposals/bun-phase-c-out-of-core.md) |
| Control-system registry | [HARNESS.md](HARNESS.md) · [harness-manifest.json](harness-manifest.json) |
| PRD format | [docs/prd-format.md](docs/prd-format.md) |
| Model/cost posture | [docs/model-allocation.md](docs/model-allocation.md) |
| Turning the security-compliance gates ON (org-admin) | [docs/operator-apply-runbook.md](docs/operator-apply-runbook.md) |
| Remediating a leaked credential (rotate → scrub → prevent) | [docs/credential-remediation-runbook.md](docs/credential-remediation-runbook.md) |
| Enterprise token cost | [docs/token-cost-playbook.md](docs/token-cost-playbook.md) |
| Behavior preservation | [docs/behavior-preservation.md](docs/behavior-preservation.md) |
| Sensor arbitration | [docs/sensor-arbitration.md](docs/sensor-arbitration.md) |
| Native command boundaries | [docs/native-command-integration.md](docs/native-command-integration.md) |
| Prompt standards | [docs/prompting-standards.md](docs/prompting-standards.md) |
| Harness architecture | [design.md](design.md) |
| Full skill instructions | `.claude/skills/<name>/SKILL.md` |
