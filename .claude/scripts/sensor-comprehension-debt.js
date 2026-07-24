#!/usr/bin/env node

'use strict';

// CLI: node .claude/scripts/sensor-comprehension-debt.js [--json] [--top N]
//
// Report-only DRIFT sensor (exit 0 always). Every maintainability sensor the
// harness ships measures a per-diff FLOW property — this change's cycles,
// coupling, length. None measured the cumulative STOCK of merged-but-unread
// code: the "dark factory" that accretes when auto-merge lands diffs no human
// ever read (Horthy). This sensor reads the merge-provenance ledger, keeps only
// the human_reviewed:false rows, and weights each by how much of the codebase
// now leans on that unread code (computeBlastRadius) and whether it crosses a
// security boundary (touchesSecurityBoundary) — then ranks them so /retro can
// point at the heaviest unread merges first.
//
// Report-only by design: comprehension debt is a judgement input for a human,
// not a merge-blocking gate. Sibling of sensor-value-report.js / sensor-withhold.js.

const fs = require('fs');
const path = require('path');
const { readProvenance } = require('../hooks/lib/merge-provenance');
const { computeBlastRadius } = require('../hooks/lib/impact-scope');
const { touchesSecurityBoundary } = require('../hooks/lib/review-policy');

const REPO = path.resolve(__dirname, '..', '..');
const GRAPH_REL = path.join('specs', 'brownfield', 'code-graph.json');
const SECURITY_MULTIPLIER = 2;

function readGraph(projectDir) {
  try { return JSON.parse(fs.readFileSync(path.join(projectDir, GRAPH_REL), 'utf8')); }
  catch (_) { return null; }
}

// Debt for one unread merge:
//   loc (the raw unread stock)
//   × (1 + blastReach)  (how many dependents now lean on unread code)
//   × security factor   (unread code on a security boundary is worse)
// loc falls back to file count, then 1, so a row with thin git stats still
// registers as debt rather than vanishing to zero.
function scoreRow(row, graph) {
  const files = Array.isArray(row.files) ? row.files : [];
  const blast = computeBlastRadius(graph, files);
  const blastReach = blast.blastRadiusFiles.length;
  const security = files.some((f) => touchesSecurityBoundary(f));
  const loc = Number.isFinite(row.loc_added) && row.loc_added > 0
    ? row.loc_added
    : (files.length || 1);
  const score = loc * (1 + blastReach) * (security ? SECURITY_MULTIPLIER : 1);
  return {
    sha: row.sha || '',
    ts: row.ts || 0,
    lane: row.lane || 'unknown',
    loc_added: loc,
    files,
    blast_reach: blastReach,
    security_boundary: security,
    score,
  };
}

function buildReport(projectDir, { top = 10 } = {}) {
  const graph = readGraph(projectDir);
  const unread = readProvenance(projectDir).filter((r) => r && r.human_reviewed === false);
  const ranked = unread.map((r) => scoreRow(r, graph)).sort((a, b) => b.score - a.score);
  const totalScore = ranked.reduce((sum, r) => sum + r.score, 0);
  const notes = [];
  if (!graph) notes.push('no code-graph.json — blast-radius reach counted as 0 for every row (run /code-map or /brownfield to weight by dependents)');
  if (unread.length === 0) notes.push('no human_reviewed:false rows in merge-provenance.jsonl — no comprehension debt recorded yet');
  return {
    sensor: 'comprehension-debt',
    generated_at: new Date().toISOString(),
    unread_merges: unread.length,
    total_score: totalScore,
    ranked: ranked.slice(0, top),
    notes,
  };
}

function renderText(report) {
  const lines = [`sensor-comprehension-debt: ${report.unread_merges} unread merge(s), total debt score ${report.total_score}`];
  for (const n of report.notes) lines.push(`  note: ${n}`);
  for (const r of report.ranked) {
    const sec = r.security_boundary ? ' [security-boundary]' : '';
    const sha = r.sha ? r.sha.slice(0, 8) : '(no-sha)';
    lines.push(`  ${String(r.score).padStart(6)}  ${sha} lane=${r.lane} loc=${r.loc_added} blast=${r.blast_reach}${sec}`);
  }
  return lines.join('\n') + '\n';
}

function main(argv) {
  const topIdx = argv.indexOf('--top');
  const top = topIdx >= 0 ? Math.max(1, parseInt(argv[topIdx + 1], 10) || 10) : 10;
  const report = buildReport(REPO, { top });
  if (argv.includes('--json')) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  else process.stdout.write(renderText(report));
  return 0;
}

module.exports = { buildReport, scoreRow, renderText };

if (require.main === module) process.exit(main(process.argv.slice(2)));
