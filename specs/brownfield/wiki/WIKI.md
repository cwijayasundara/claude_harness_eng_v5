# Codebase Wiki

> Deterministic, always-current map rendered from `code-graph.json`. No LLM — re-rendered on graph change.

- Producer: `vendored-ast`  ·  Language: `mixed`
- Modules: 447  ·  Edges: 2050  ·  Clusters: 50

## Hubs (most-depended-on)

| Module | fan-in | fan-out |
|---|---|---|
| `js:test/helpers/hook-fixture.js` | 25 | 5 |
| `js:test/helpers/skill-corpus.js` | 22 | 2 |
| `js:test/e2e/helpers/claude-runner.js` | 17 | 4 |
| `js:test/e2e/helpers/project-suite.js` | 9 | 3 |
| `js:test/helpers/pre-commit-fixtures.js` | 9 | 3 |
| `js:symphony_clone/src/orchestrator/scheduler.js` | 7 | 6 |
| `js:test/helpers/record-run-fixture.js` | 5 | 5 |
| `js:symphony_clone/src/orchestrator/workspace-manager.js` | 5 | 4 |
| `js:test/e2e/helpers/fresh-project.js` | 5 | 3 |
| `js:symphony_clone/src/config.js` | 5 | 2 |

### Entry points (no inbound deps)

- `cs:test/fixtures/code-index/enterprise/web/App.cs`
- `go:test/fixtures/code-index/enterprise/internal/auth/auth.go`
- `go:test/fixtures/code-index/enterprise/main.go`
- `java:test/fixtures/code-index/enterprise/src/main/java/com/acme/App.java`
- `js:eslint.config.js`
- `js:open_wiki/scripts/check-config.mjs`
- `js:open_wiki/scripts/run-openwiki.mjs`
- `js:symphony_clone/scripts/create-group-issue.js`
- `js:symphony_clone/scripts/diagnose-linear.js`
- `js:symphony_clone/src/config.test.js`
- `js:symphony_clone/src/index.test.js`
- `js:symphony_clone/src/orchestrator/claude-runner.test.js`
- `js:symphony_clone/src/orchestrator/eligibility.test.js`
- `js:symphony_clone/src/orchestrator/outcomes.test.js`
- `js:symphony_clone/src/orchestrator/planning-prompt.test.js`
- `js:symphony_clone/src/orchestrator/pr.test.js`
- `js:symphony_clone/src/orchestrator/scheduler.test.js`
- `js:symphony_clone/src/tracker/azure.test.js`
- `js:symphony_clone/src/tracker/http.test.js`
- `js:symphony_clone/src/tracker/jira.test.js`
- `js:symphony_clone/src/tracker/linear.test.js`
- `js:symphony_clone/test/config.test.js`
- `js:symphony_clone/test/feature-routing-docs.test.js`
- `js:symphony_clone/test/linear-state.test.js`
- `js:symphony_clone/test/prompt-builder.test.js`

### Cycles

_(none)_

### External dependencies

_(none)_

## Concept pages

- [test/helpers](concepts/test__helpers.md)
- [test/e2e](concepts/test__e2e.md)
- [symphony_clone/src](concepts/symphony_clone__src.md)
- [dsl-packs/private-equity](concepts/dsl-packs__private-equity.md)
- [test/fixtures](concepts/test__fixtures.md)
- [symphony_clone/test](concepts/symphony_clone__test.md)
- [test/evals](concepts/test__evals.md)
- [open_wiki/scripts](concepts/open_wiki__scripts.md)
- [symphony_clone/scripts](concepts/symphony_clone__scripts.md)
- [eslint.config.js](concepts/eslint.config.js.md)
- [test/accessibility-contract.test.js](concepts/test__accessibility-contract.test.js.md)
- [test/adversarial-fixtures-contract.test.js](concepts/test__adversarial-fixtures-contract.test.js.md)
- [test/adversarial-live-e2e-contract.test.js](concepts/test__adversarial-live-e2e-contract.test.js.md)
- [test/agent-readiness-wiring-contract.test.js](concepts/test__agent-readiness-wiring-contract.test.js.md)
- [test/agent-readiness.test.js](concepts/test__agent-readiness.test.js.md)
- [test/amendment-provenance-check.test.js](concepts/test__amendment-provenance-check.test.js.md)
- [test/approve-fixtures.test.js](concepts/test__approve-fixtures.test.js.md)
- [test/approved-fixtures-gate.test.js](concepts/test__approved-fixtures-gate.test.js.md)
- [test/archive-state.test.js](concepts/test__archive-state.test.js.md)
- [test/ask-codebase-readiness-digest.test.js](concepts/test__ask-codebase-readiness-digest.test.js.md)

_(Hash-cached concept pages from `nav-concepts.js`.)_

## Pages

- [`test/` — 298 module(s)](pages/01-test.md) — 298 module(s)
- [`test/e2e/` — 18 module(s)](pages/02-test-e2e.md) — 18 module(s)
- [`symphony_clone/src/orchestrator/` — 16 module(s)](pages/03-symphony_clone-src-orchestrator.md) — 16 module(s)
- [`test/e2e/helpers/` — 14 module(s)](pages/04-test-e2e-helpers.md) — 14 module(s)
- [`symphony_clone/test/` — 13 module(s)](pages/05-symphony_clone-test.md) — 13 module(s)
- [`tools/` — 9 module(s)](pages/06-tools.md) — 9 module(s)
- [`symphony_clone/src/tracker/` — 8 module(s)](pages/07-symphony_clone-src-tracker.md) — 8 module(s)
- [`test/helpers/` — 6 module(s)](pages/08-test-helpers.md) — 6 module(s)
- [`open_wiki/scripts/` — 4 module(s)](pages/09-open_wiki-scripts.md) — 4 module(s)
- [`symphony_clone/src/` — 4 module(s)](pages/10-symphony_clone-src.md) — 4 module(s)
- [`dsl-packs/private-equity/waterfall/` — 3 module(s)](pages/11-dsl-packs-private-equity-waterfall.md) — 3 module(s)
- [`test/e2e/full-auto-output/src/` — 3 module(s)](pages/12-test-e2e-full-auto-output-src.md) — 3 module(s)
- [`test/e2e/full-auto-output/tests/` — 3 module(s)](pages/13-test-e2e-full-auto-output-tests.md) — 3 module(s)
- [`test/evals/fixtures/calc-app/` — 3 module(s)](pages/14-test-evals-fixtures-calc-app.md) — 3 module(s)
- [`symphony_clone/scripts/` — 2 module(s)](pages/15-symphony_clone-scripts.md) — 2 module(s)
- [`symphony_clone/src/observability/` — 2 module(s)](pages/16-symphony_clone-src-observability.md) — 2 module(s)
- [`test/e2e/auto-output/` — 2 module(s)](pages/17-test-e2e-auto-output.md) — 2 module(s)
- [`test/e2e/brownfield-run-output/` — 2 module(s)](pages/18-test-e2e-brownfield-run-output.md) — 2 module(s)
- [`test/e2e/fixtures/adversarial/brownfield/legacy-expressish/src/` — 2 module(s)](pages/19-test-e2e-fixtures-adversarial-brownfield-legacy-expressish-src.md) — 2 module(s)
- [`test/e2e/full-auto-output/specs/test_artefacts/acceptance/` — 2 module(s)](pages/20-test-e2e-full-auto-output-specs-test_artefacts-acceptance.md) — 2 module(s)

## Agent navigation

- Context pack: `node .claude/scripts/nav-query.js pack --budget 1600 "<question>"`
- Refresh secondary indexes: `node .claude/scripts/nav-query.js refresh`

_+ 30 smaller cluster(s) not paged (raise --max-pages)._
