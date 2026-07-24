# Codebase map (human homepage)

> Living orientation document. Deterministically rendered from the code-graph + CONTEXT.
> Prefer this page + concept wiki over opening the whole tree.

## What this system is

A Claude Code plugin for building and changing software with a generator/evaluator loop, ratcheting quality gates, and explicit human review before merge.

_Source: `README.md`_

## At a glance

| Metric | Value |
|---|---|
| Indexed files | 447 |
| Graph edges | 2050 |
| Concept pages | 20 |
| Wiki cluster pages | 20 |

## How to run / test / gate

```bash
# project-specific — see README / init.sh
./init.sh                 # or docker compose up
npm test                 # or pytest / vitest
/gate                    # pre-merge quality gate
npm run quality-card     # trust receipt
npm run ask -- "..."     # ask the codebase
```

## Architecture (hub modules)

| Module | fan-in | fan-out |
|---|---|---|
| `test/helpers/hook-fixture.js` | 25 | 0 |
| `test/helpers/skill-corpus.js` | 22 | 0 |
| `test/e2e/helpers/claude-runner.js` | 17 | 0 |
| `test/e2e/helpers/project-suite.js` | 9 | 0 |
| `test/helpers/pre-commit-fixtures.js` | 9 | 0 |
| `symphony_clone/src/orchestrator/scheduler.js` | 7 | 6 |
| `symphony_clone/src/config.js` | 5 | 0 |
| `symphony_clone/src/orchestrator/workspace-manager.js` | 5 | 0 |
| `test/e2e/helpers/fresh-project.js` | 5 | 0 |
| `test/helpers/pack-membership.js` | 5 | 0 |
| `test/helpers/record-run-fixture.js` | 5 | 0 |
| `test/e2e/full-auto-output/src/server.js` | 4 | 1 |

## Entry points

- `test/e2e/brownfield-run-output/main.js`
- `test/evals/fixtures/clean-app/app.js`
- `test/fixtures/code-index/enterprise/main.go`
- `test/fixtures/code-index/sample/api/users.py`

## Concept pages (clusters)

- [test/helpers](specs/brownfield/wiki/concepts/test__helpers.md)
- [test/e2e](specs/brownfield/wiki/concepts/test__e2e.md)
- [symphony_clone/src](specs/brownfield/wiki/concepts/symphony_clone__src.md)
- [dsl-packs/private-equity](specs/brownfield/wiki/concepts/dsl-packs__private-equity.md)
- [test/fixtures](specs/brownfield/wiki/concepts/test__fixtures.md)
- [symphony_clone/test](specs/brownfield/wiki/concepts/symphony_clone__test.md)
- [test/evals](specs/brownfield/wiki/concepts/test__evals.md)
- [open_wiki/scripts](specs/brownfield/wiki/concepts/open_wiki__scripts.md)
- [symphony_clone/scripts](specs/brownfield/wiki/concepts/symphony_clone__scripts.md)
- [eslint.config.js](specs/brownfield/wiki/concepts/eslint.config.js.md)
- [test/accessibility-contract.test.js](specs/brownfield/wiki/concepts/test__accessibility-contract.test.js.md)
- [test/adversarial-fixtures-contract.test.js](specs/brownfield/wiki/concepts/test__adversarial-fixtures-contract.test.js.md)
- [test/adversarial-live-e2e-contract.test.js](specs/brownfield/wiki/concepts/test__adversarial-live-e2e-contract.test.js.md)
- [test/agent-readiness-wiring-contract.test.js](specs/brownfield/wiki/concepts/test__agent-readiness-wiring-contract.test.js.md)
- [test/agent-readiness.test.js](specs/brownfield/wiki/concepts/test__agent-readiness.test.js.md)
- [test/amendment-provenance-check.test.js](specs/brownfield/wiki/concepts/test__amendment-provenance-check.test.js.md)
- [test/approve-fixtures.test.js](specs/brownfield/wiki/concepts/test__approve-fixtures.test.js.md)
- [test/approved-fixtures-gate.test.js](specs/brownfield/wiki/concepts/test__approved-fixtures-gate.test.js.md)
- [test/archive-state.test.js](specs/brownfield/wiki/concepts/test__archive-state.test.js.md)
- [test/ask-codebase-readiness-digest.test.js](specs/brownfield/wiki/concepts/test__ask-codebase-readiness-digest.test.js.md)

## DeepWiki cluster pages

- [01-test](specs/brownfield/wiki/pages/01-test.md)
- [02-test-e2e](specs/brownfield/wiki/pages/02-test-e2e.md)
- [03-symphony_clone-src-orchestrator](specs/brownfield/wiki/pages/03-symphony_clone-src-orchestrator.md)
- [04-test-e2e-helpers](specs/brownfield/wiki/pages/04-test-e2e-helpers.md)
- [05-symphony_clone-test](specs/brownfield/wiki/pages/05-symphony_clone-test.md)
- [06-tools](specs/brownfield/wiki/pages/06-tools.md)
- [07-symphony_clone-src-tracker](specs/brownfield/wiki/pages/07-symphony_clone-src-tracker.md)
- [08-test-helpers](specs/brownfield/wiki/pages/08-test-helpers.md)
- [09-open_wiki-scripts](specs/brownfield/wiki/pages/09-open_wiki-scripts.md)
- [10-symphony_clone-src](specs/brownfield/wiki/pages/10-symphony_clone-src.md)
- [11-dsl-packs-private-equity-waterfall](specs/brownfield/wiki/pages/11-dsl-packs-private-equity-waterfall.md)
- [12-test-e2e-full-auto-output-src](specs/brownfield/wiki/pages/12-test-e2e-full-auto-output-src.md)
- [13-test-e2e-full-auto-output-tests](specs/brownfield/wiki/pages/13-test-e2e-full-auto-output-tests.md)
- [14-test-evals-fixtures-calc-app](specs/brownfield/wiki/pages/14-test-evals-fixtures-calc-app.md)
- [15-symphony_clone-scripts](specs/brownfield/wiki/pages/15-symphony_clone-scripts.md)
- [16-symphony_clone-src-observability](specs/brownfield/wiki/pages/16-symphony_clone-src-observability.md)
- [17-test-e2e-auto-output](specs/brownfield/wiki/pages/17-test-e2e-auto-output.md)
- [18-test-e2e-brownfield-run-output](specs/brownfield/wiki/pages/18-test-e2e-brownfield-run-output.md)
- [19-test-e2e-fixtures-adversarial-brownfield-legacy-expressish-src](specs/brownfield/wiki/pages/19-test-e2e-fixtures-adversarial-brownfield-legacy-expressish-src.md)
- [20-test-e2e-full-auto-output-specs-test_artefacts-acceptance](specs/brownfield/wiki/pages/20-test-e2e-full-auto-output-specs-test_artefacts-acceptance.md)

## Critical paths & debugging

- Metrics path: `/metrics`
- SLO: error_rate_pct≤1 · p95_ms≤500
- Prefer structured logs with `request_id` / `X-Request-ID` correlation.
- Quality receipt after changes: `specs/reviews/quality-card.md`.
- Ask navigation: `npm run ask -- "where is auth validated?"`.

## If X breaks, start here

| Symptom | Start |
|---|---|
| Auth / session failures | concept or entry modules matching `auth` / `session` |
| Slow API | quality-card perf + `/metrics` + N+1 smells (`npm run perf-smell`) |
| Silent failures | structured logs + `request_id`; observability gate |
| Merge confidence | `specs/reviews/quality-card.md` + `walkthrough.md` |
| "Where is X?" | `npm run ask -- "X"` |

## Machine-readable companions

- `specs/brownfield/code-graph.json` — dependency DAG (agents + tools)
- `specs/brownfield/symbol-map.md` — symbols with line ranges
- `specs/brownfield/wiki/WIKI.md` — deterministic DeepWiki index
- `.harness/wiki.json` — steer wiki priorities (Devin `.devin/wiki.json` analogue)
