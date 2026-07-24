#!/usr/bin/env node
'use strict';

// Deterministic pre-pass for the SAME-INVARIANT OVERLAP de-dup audit.
//
// The four read-only audit agents (one per HARNESS axis) hunt for controls that
// guard the same invariant so they can be merged — the one-owner-per-invariant work
// behind the v6 reduction. Full-scanning every control's source to find those pairs
// costs 30-70k tokens per axis. This pre-pass reads harness-manifest.json (cheap,
// structured) and clusters controls into RANKED candidate pairs, so each agent
// adjudicates a short list instead of re-reading the whole axis.
//
// Two rules keep this consistent with the harness's own principles:
//
//   1. It RANKS, it does not FILTER. A deterministic clusterer will miss a
//      same-invariant pair that shares no gap id, no file, and no vocabulary. So
//      every control the signals never touched is emitted in a `residual` bucket —
//      "not clustered" must never read as "certified overlap-free". The periodic
//      full-scan backstop still owns the residual.
//   2. It is TOOLING, not a control. It gates no product change; it is operator
//      support for a periodic harness-maintenance audit (same class as
//      tools/check-partition.js). It is deliberately NOT in harness-manifest.json,
//      so it does not touch the control-budget ratchet — you do not add a control
//      in order to remove controls.
//
//   node tools/overlap-candidates.js          ranked report + residual bucket
//   node tools/overlap-candidates.js --json   machine-readable {pairs, residual}
//
// The output is axis-agnostic: each pair carries its axes, so an axis-scoped agent
// slices with pairs.filter(p => p.axes.includes(axis)).

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST = path.join(ROOT, 'harness-manifest.json');
// Marker for the staleness backstop: which controls the last FULL audit (agents
// reading source, not just this pre-pass) adjudicated. Same "wrap the real run's
// completion into a state file" shape as record-modularity-review.js (gap G19).
const MARKER = path.join(ROOT, '.claude', 'state', 'dedup-audit-marker.json');

// Signal weights. A shared gap id is the strongest tell — two controls filed under
// the same gap are the classic double-registration (the canary pair, the merged
// grounding-check sensor). A shared wired_at file is the same pattern seen from the
// code side. Description overlap is the weakest, semantic-only net that catches a
// same-invariant pair sharing no structural token.
const W = { gap_ref: 1.0, wired_at: 0.7, description: 0.5 };
const DESC_JACCARD_MIN = 0.22;

const STOP = new Set(('the a an of to and or for in on at by is are be it its this that ' +
  'with without via from as not no every each any all only when where which what who ' +
  'run runs ran gate gates sensor sensors control controls harness check checks step ' +
  'file files code repo review reviews').split(' '));

const round2 = (n) => Math.round(n * 100) / 100;
const fileOf = (w) => String(w || '').split('#')[0];

function tokens(text) {
  return new Set(String(text || '').toLowerCase().split(/[^a-z0-9]+/)
    .filter((t) => t.length > 3 && !STOP.has(t)));
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

// Reduce a manifest entry to just the fields the clusterer compares.
function prepare(control) {
  return {
    id: control.id,
    axis: control.axis,
    file: fileOf(control.wired_at),
    gap_ref: control.gap_ref || null,
    tokens: tokens(`${control.description || ''} ${control.signal || ''}`),
  };
}

// The signals that link two controls, each with the evidence that fired it. A pair
// with no signal is not emitted — but both members still land in the residual, so
// nothing is silently dropped.
function pairSignals(a, b) {
  const sig = [];
  if (a.gap_ref && a.gap_ref === b.gap_ref) sig.push({ kind: 'gap_ref', evidence: a.gap_ref });
  if (a.file && a.file === b.file) sig.push({ kind: 'wired_at', evidence: a.file });
  const j = jaccard(a.tokens, b.tokens);
  if (j >= DESC_JACCARD_MIN) sig.push({ kind: 'description', evidence: round2(j) });
  return sig;
}

function makePair(a, b, signals) {
  const score = round2(signals.reduce((s, x) => s + W[x.kind], 0));
  return {
    a: a.id, b: b.id,
    axes: a.axis === b.axis ? [a.axis] : [a.axis, b.axis],
    sameAxis: a.axis === b.axis,
    signals,
    score,
  };
}

// Pure core: cluster a control set into ranked same-invariant candidate PAIRS plus a
// residual bucket of everything no signal touched. Ranking, not filtering.
function clusterOverlaps(controls) {
  if (!controls.length) {
    throw new Error('overlap-candidates: no controls to cluster — refusing a vacuous "no overlap" pass');
  }
  const prepped = controls.map(prepare);
  const pairs = [];
  const clustered = new Set();
  for (let i = 0; i < prepped.length; i++) {
    for (let j = i + 1; j < prepped.length; j++) {
      const signals = pairSignals(prepped[i], prepped[j]);
      if (!signals.length) continue;
      pairs.push(makePair(prepped[i], prepped[j], signals));
      clustered.add(prepped[i].id); clustered.add(prepped[j].id);
    }
  }
  pairs.sort((x, y) => y.score - x.score || (x.a + x.b).localeCompare(y.a + y.b));
  const residual = prepped.filter((c) => !clustered.has(c.id)).map((c) => c.id);
  return { pairs, residual, units: prepped.length };
}

// ---- disk wiring ----

// Only REAL controls count — `planned` entries are aspirational gap-trackers, not yet
// friction, exactly as the control-budget ratchet treats them (hooks/lib/control-budget.js).
function loadControls(manifest) {
  const guides = Array.isArray(manifest.guides) ? manifest.guides : [];
  const sensors = Array.isArray(manifest.sensors) ? manifest.sensors : [];
  return [...guides, ...sensors].filter((e) => e && e.id && (e.status || 'active') !== 'planned');
}

// --- Staleness backstop ---
//
// The pre-pass only RANKS; it can miss a same-invariant pair sharing no signal. So a
// periodic full scan must still sweep the residual. These functions track how far
// behind the full scan has fallen: the marker is the control set the last full audit
// covered; a control present now but absent from it has never been backstopped.

function buildMarker(controls, now) {
  return { timestamp: now, controlIds: controls.map((c) => c.id).sort() };
}

function auditedIds(marker) {
  return new Set((marker && marker.controlIds) || []);
}

// No marker at all = no full audit has ever run = every control is stale. A first run
// is a signal, never a silent pass — the same discipline the control-budget and G19
// baselines apply to their own "no baseline yet" case.
function staleControls(controls, marker) {
  const seen = auditedIds(marker);
  return controls.map((c) => c.id).filter((id) => !seen.has(id)).sort();
}

function readMarker() {
  try { return JSON.parse(fs.readFileSync(MARKER, 'utf8')); } catch (_) { return null; }
}

function printStale(stale, marker) {
  const when = marker ? marker.timestamp : 'never';
  process.stdout.write(`dedup-audit staleness: last full audit ${when}; ${stale.length} control(s) added since.\n`);
  if (!stale.length) return process.stdout.write('  (none — the full-scan backstop is current)\n');
  for (const id of stale) process.stdout.write(`  - ${id}\n`);
  return process.stdout.write('\nRun the full per-axis audit (agents read source) to backstop the pre-pass on\n' +
    'these, then `node tools/overlap-candidates.js --record` to mark it done.\n');
}

function printResidual(residual) {
  if (!residual.length) return;
  process.stdout.write('\nUnclustered (no deterministic signal fired — the periodic full-scan\n' +
    'backstop still owns these; they are NOT certified overlap-free):\n');
  for (const id of residual) process.stdout.write(`  - ${id}\n`);
}

function printReport({ pairs, residual, units }) {
  process.stdout.write(
    `overlap-candidates: ${units} controls, ${pairs.length} candidate pair(s), ${residual.length} unclustered.\n\n`);
  for (const p of pairs) {
    const where = p.sameAxis ? p.axes[0] : p.axes.join(' x ');
    const why = p.signals.map((s) => `${s.kind}=${s.evidence}`).join(', ');
    process.stdout.write(`  [${p.score}] ${p.a}  <>  ${p.b}  (${where})  via ${why}\n`);
  }
  printResidual(residual);
}

function runCluster(controls, asJson) {
  const result = clusterOverlaps(controls);
  if (asJson) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else printReport(result);
  return 0;
}

function runRecord(controls) {
  const marker = buildMarker(controls, new Date().toISOString());
  fs.mkdirSync(path.dirname(MARKER), { recursive: true });
  fs.writeFileSync(MARKER, `${JSON.stringify(marker, null, 2)}\n`);
  process.stdout.write(`dedup-audit marker written: ${marker.controlIds.length} controls at ${marker.timestamp}.\n`);
  return 0;
}

function runStale(controls) {
  const marker = readMarker();
  printStale(staleControls(controls, marker), marker);
  return 0;
}

function main() {
  const controls = loadControls(JSON.parse(fs.readFileSync(MANIFEST, 'utf8')));
  if (process.argv.includes('--record')) return runRecord(controls);
  if (process.argv.includes('--stale')) return runStale(controls);
  return runCluster(controls, process.argv.includes('--json'));
}

if (require.main === module) process.exit(main());

module.exports = {
  clusterOverlaps, pairSignals, jaccard, tokens, loadControls,
  buildMarker, auditedIds, staleControls,
};
