#!/usr/bin/env node

'use strict';

// CLI: node .claude/scripts/sensor-value-report.js [--min-runs N] [--json]
//
// The value meter: turns the bite ledger into a ranked cut list. A control set can
// only shrink if there is evidence about which controls earn their place, and the
// two facts that matter are whether a control ever FIRES and whether it ever CATCHES
// anything. A third — how long it takes — is what makes "correct but not worth it"
// visible.
//
// It reports every sensor that appears in the ledger, not only the commit-gate
// catalog. That widening is the point: the commit hook is deliberately not installed
// in the harness's own repo (see check-git-hooks.js), so for three months the ledger
// stayed empty and this report could never produce a list. The session-cadence gates
// are the ones that actually fire — and the ones that produce false blocks.
//
// Report-only: never blocks, never exits non-zero on findings.

const path = require('path');
const { readOutcomes } = require('../hooks/lib/sensor-outcomes');
const { readVerdicts, latestBySensor } = require('../hooks/lib/withhold-verdicts');
const { GATE_CATALOG } = require('../hooks/lib/gate-registry');
const { loadSensorTier, isGateEnabled } = require('../hooks/lib/sensor-tier');
const { provenLiveSensors } = require('./sensor-canary');

const REPO = path.resolve(__dirname, '..', '..');
const SLOW_MS = 500;

function tally(outcomes) {
  const stats = new Map();
  for (const o of outcomes) {
    const s = stats.get(o.sensor) || { ran: 0, blocked: 0, totalMs: 0, timed: 0, surfaces: new Set() };
    if (o.ran) s.ran += 1;
    if (o.blocked) s.blocked += 1;
    if (Number.isFinite(o.elapsed_ms)) { s.totalMs += o.elapsed_ms; s.timed += 1; }
    if (o.surface) s.surfaces.add(o.surface);
    stats.set(o.sensor, s);
  }
  return stats;
}

// Union of the commit catalog and everything the ledger has seen, so a sensor that
// never ran is still listed — never-ran is a finding, not an absence.
function sensorIds(stats) {
  const ids = new Set(GATE_CATALOG.map((g) => g.id));
  for (const id of stats.keys()) ids.add(id);
  return [...ids].sort();
}

function toRow(id, stats) {
  const s = stats.get(id) || { ran: 0, blocked: 0, totalMs: 0, timed: 0, surfaces: new Set() };
  return {
    id,
    ran: s.ran,
    blocked: s.blocked,
    avg_ms: s.timed ? Math.round(s.totalMs / s.timed) : null,
    surfaces: [...s.surfaces].sort(),
  };
}

// Partition the never-blocked gates — the only genuinely ambiguous ones — into the
// buckets the operator acts on. "Never blocked" is ambiguous: a working deterrent looks
// identical to shelfware. A LIVE canary (sensor-canary.js) rescues one to proven-live. A
// withhold-and-rerun verdict is stronger still — the only test that proves whether
// removing the control degrades a REAL job — so it reclassifies these candidates to a
// decisive removable / confirmed-valuable. It reclassifies ONLY these candidates: a gate
// the ledger already proves blocks real diffs is not shelfware, and one no-degradation
// job must not relabel it removable — the "instrument says retire a live control" failure
// the meter exists to avoid.
function bucketNeverBlocked(rows, provenLive, verdicts) {
  const neverBlocked = rows.filter((r) => r.ran > 0 && r.blocked === 0).map((r) => r.id);
  const candidates = [...neverBlocked.filter((id) => provenLive.has(id)),
    ...neverBlocked.filter((id) => !provenLive.has(id))];
  const verdict = (id, want) => verdicts.has(id) && verdicts.get(id).degraded === want;
  const removable = candidates.filter((id) => verdict(id, false));
  const confirmedValuable = candidates.filter((id) => verdict(id, true));
  const decided = new Set([...removable, ...confirmedValuable]);
  return {
    removable, confirmedValuable,
    provenLive: neverBlocked.filter((id) => provenLive.has(id) && !decided.has(id)),
    neverBlocked: neverBlocked.filter((id) => !provenLive.has(id) && !decided.has(id)),
  };
}

function classify(stats, tier = null, provenLive = new Set(), verdicts = new Map()) {
  const rows = sensorIds(stats).map((id) => toRow(id, stats));
  const neverRanIds = rows.filter((r) => r.ran === 0).map((r) => r.id);
  // A gate registered only at a tier this repo does not run is dormant by design,
  // not dead — "check wiring or retire" would drop a live control that is simply not
  // enabled here (e.g. the strict-tier compliance gates at standard tier). Split it
  // out only when the tier is known; synthetic callers pass none and stay tier-blind.
  const dormantByTier = tier ? neverRanIds.filter((id) => !isGateEnabled(tier, id)) : [];
  const dormant = new Set(dormantByTier);
  const nb = bucketNeverBlocked(rows, provenLive, verdicts);
  return {
    rows,
    neverRan: neverRanIds.filter((id) => !dormant.has(id)),
    dormantByTier,
    removable: nb.removable,
    confirmedValuable: nb.confirmedValuable,
    provenLive: nb.provenLive,
    neverBlocked: nb.neverBlocked,
    slow: rows.filter((r) => r.avg_ms !== null && r.avg_ms >= SLOW_MS).map((r) => `${r.id} (${r.avg_ms}ms)`),
    // A control that blocks on most runs is either catching a real systemic problem
    // or false-blocking. The ledger cannot tell a correct block from a wrong one, so
    // this is surfaced for a human rather than inferred.
    highBlock: rows.filter((r) => r.ran >= 5 && r.blocked / r.ran > 0.5)
      .map((r) => `${r.id} (${r.blocked}/${r.ran})`),
  };
}

function insufficient(totalRuns, minRuns) {
  return `sensor-value-report: INSUFFICIENT DATA — ${totalRuns} recorded outcome(s), need >= ${minRuns}.\n` +
    'Sensors record at every write (pre-write-gate), every /gate check run, and every\n' +
    'commit where the git hook is installed. No cut list yet.\n';
}

function renderRows(rows) {
  return rows.map((r) => {
    const where = r.surfaces.length ? ` [${r.surfaces.join(',')}]` : '';
    const cost = r.avg_ms === null ? '' : ` avg=${r.avg_ms}ms`;
    return `  ${r.id}: ran=${r.ran} blocked=${r.blocked}${cost}${where}`;
  });
}

// Prompt the operator to run the withhold-and-rerun test on any candidate the verdict
// ledger has not yet decided — the ambiguous buckets are a to-do list, not a verdict.
function subtractiveHint(c) {
  if (!c.neverBlocked.length && !c.provenLive.length) return [];
  return ['', 'NEXT: for a candidate above, remove it, rerun a representative job, then record:',
    '  node .claude/scripts/sensor-withhold.js record --sensor <id> --degraded <true|false> --job "<what you reran>"'];
}

function render(outcomes, minRuns, tier = null, provenLive = new Set(), verdicts = new Map()) {
  const totalRuns = outcomes.length;
  const c = classify(tally(outcomes), tier, provenLive, verdicts);
  if (totalRuns < minRuns) return insufficient(totalRuns, minRuns);

  const lines = [`sensor-value-report: ${totalRuns} recorded outcomes across ${c.rows.length} sensors` +
    (tier ? ` (active tier: ${tier}).` : '.')];
  lines.push('', 'REMOVABLE (withhold-and-rerun showed no degradation — safe to cut): ' + (c.removable.join(', ') || 'none'));
  lines.push('CONFIRMED-VALUABLE (withheld → a real job degraded — keep): ' + (c.confirmedValuable.join(', ') || 'none'));
  lines.push('', 'NEVER FIRED (never ran — check wiring or retire): ' + (c.neverRan.join(', ') || 'none'));
  if (tier) {
    lines.push('DORMANT (off at the ' + tier + ' tier — correctly silent, not a finding): ' +
      (c.dormantByTier.join(', ') || 'none'));
  }
  lines.push('PROVEN-LIVE (never blocked, but a canary proves the gate still bites — NOT shelfware): ' + (c.provenLive.join(', ') || 'none'));
  lines.push('NEVER BLOCKED (ran, never caught anything, no canary — candidate shelfware): ' + (c.neverBlocked.join(', ') || 'none'));
  lines.push(`SLOW (>=${SLOW_MS}ms average — correct but costly): ` + (c.slow.join(', ') || 'none'));
  lines.push('BLOCKS OFTEN (>50% of runs — real systemic issue, or false-blocking): ' + (c.highBlock.join(', ') || 'none'));
  lines.push(...subtractiveHint(c), '', ...renderRows(c.rows));
  return lines.join('\n') + '\n';
}

function main() {
  const argv = process.argv.slice(2);
  const minIdx = argv.indexOf('--min-runs');
  const minRuns = minIdx >= 0 ? Number(argv[minIdx + 1]) || 20 : 20;
  const outcomes = readOutcomes(REPO);
  const tier = loadSensorTier(REPO);
  const provenLive = provenLiveSensors();
  const verdicts = latestBySensor(readVerdicts(REPO));
  if (argv.includes('--json')) {
    process.stdout.write(JSON.stringify(classify(tally(outcomes), tier, provenLive, verdicts), null, 2) + '\n');
    return;
  }
  process.stdout.write(render(outcomes, minRuns, tier, provenLive, verdicts));
}

if (require.main === module) main();

module.exports = { tally, classify, render };
