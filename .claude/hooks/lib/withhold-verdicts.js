'use strict';

// Subtractive-verdict ledger — the withhold-and-rerun result for one control.
//
// The bite ledger (sensor-outcomes.js) records whether a control FIRED and BLOCKED;
// the canary (sensor-canary.js) proves a control's detector still bites a synthetic
// bad input. Neither answers the question that actually authorizes removal: if this
// control were absent, would a REAL representative job degrade? A gate can be
// proven-live yet removable when no real trajectory ever produces the input it
// catches. That judgement comes from a human running the job with the control
// withheld; this ledger records the verdict so the value meter can act on it.
//
// One row per experiment, keyed by the same sensor id as the bite ledger.

const fs = require('fs');
const path = require('path');

const WITHHOLD_REL = path.join('.claude', 'state', 'sensor-withhold.jsonl');

// degraded=true  → withholding the control degraded a real job → it earns its place.
// degraded=false → the job closed unchanged without it → safe to cut.
//
// Not best-effort: unlike the bite ledger (on a gate's hot path), this is invoked
// deliberately by an operator. A silent write failure would let someone believe an
// experiment was captured when it was not, so a failure here must surface.
function recordVerdict(projectDir, { sensor, degraded, job, evidence }) {
  const file = path.join(projectDir, WITHHOLD_REL);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const row = { sensor: String(sensor), degraded: !!degraded, ts: Date.now() };
  if (job) row.job = String(job);
  if (evidence) row.evidence = String(evidence);
  fs.appendFileSync(file, JSON.stringify(row) + '\n');
  return row;
}

function readVerdicts(projectDir) {
  try {
    const raw = fs.readFileSync(path.join(projectDir, WITHHOLD_REL), 'utf8').trim();
    if (!raw) return [];
    return raw.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch (_) {
    return [];
  }
}

// The most recent verdict wins per sensor — a control changes, gets re-tested, and the
// latest experiment is the one that governs. Returns Map<sensor, verdict>.
function latestBySensor(verdicts) {
  const byId = new Map();
  for (const v of verdicts) {
    if (!v || !v.sensor) continue;
    const prev = byId.get(v.sensor);
    if (!prev || (v.ts || 0) >= (prev.ts || 0)) byId.set(v.sensor, v);
  }
  return byId;
}

module.exports = { WITHHOLD_REL, recordVerdict, readVerdicts, latestBySensor };
