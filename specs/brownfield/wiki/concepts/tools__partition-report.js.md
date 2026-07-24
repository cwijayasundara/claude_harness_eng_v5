# Concept: tools/partition-report.js

> Deterministic concept page (hash-cached). Not LLM prose.

## Summary

Cluster `tools/partition-report.js` groups **1** file(s) (hub fan-in hint 2).

## Files

- `tools/partition-report.js` (hash e44b20a89848c5df)

## Symbols

- `installs`
- `computeProfileBreaks`
- `reportCrossPack`
- `reportProfileBreaks`
- `reportViolations`
- `printReport`

## Repo notes (steering)

- Primary harness control plane lives under .claude/ (hooks, scripts, skills). Brownfield navigation artifacts live under specs/brownfield/. Prefer /context or nav-query pack before broad source reads.

## Inbound edges (sample)

- tools/check-partition.js → tools/partition-report.js (imports)
- tools/partition-report.test.js → tools/partition-report.js (imports)

## Citations

Source of truth: `specs/brownfield/code-graph.json`. Prefer `/context` or `nav-query pack` for task-scoped reads.
