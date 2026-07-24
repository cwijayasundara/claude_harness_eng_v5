'use strict';

// Append-only sensor outcome ledger — the "bite ledger".
//
// Every control records whether it RAN, whether it BLOCKED, and how long it took.
// That is what makes the control set subtractable: a sensor that never fires, or
// fires constantly without ever catching a defect, is visible instead of assumed
// useful. Read by sensor-value-report and loop-health.
//
// It records from every cadence, not just commit. That distinction is load-bearing:
// gate-registry (commit) was the only caller for three months, and the commit hook is
// deliberately not installed in the harness's own repo (see check-git-hooks.js), so
// the ledger stayed empty and the value meter could never produce a cut list. The
// session-cadence gates are the ones that actually fire — and the ones that produce
// false blocks — so they must record too.
//
// Best-effort: every write is wrapped so a logging failure can NEVER change control
// flow. A sensor must not fail because its telemetry failed.

const fs = require('fs');
const path = require('path');

const OUTCOMES_REL = path.join('.claude', 'state', 'sensor-outcomes.jsonl');

// surface: which cadence recorded this — 'commit' | 'session' | 'integration'.
// elapsedMs: cost, so a control that is correct but slow is still visible.
// errored: the control CRASHED. Distinct from both "ran clean" and "blocked" —
// an inert control must not read as dormant (the meter would recommend retiring
// it) nor as biting (its apparent value would go up).
function recordOutcome(projectDir, { sensor, ran, blocked, surface, elapsedMs, target, errored }) {
  try {
    const file = path.join(projectDir, OUTCOMES_REL);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const row = { sensor: String(sensor), ran: !!ran, blocked: !!blocked, ts: Date.now() };
    if (errored) row.errored = true;
    if (surface) row.surface = String(surface);
    if (Number.isFinite(elapsedMs)) row.elapsed_ms = Math.round(elapsedMs);
    if (target) row.target = String(target);
    fs.appendFileSync(file, JSON.stringify(row) + '\n');
  } catch (_) {
    /* best-effort: logging must not affect the gate */
  }
}

// Time a check and record it in one step. Returns whatever fn returns; a throw is
// recorded as ERRORED and re-thrown unchanged.
//
// A throw is a crash, not a block. Recording it as blocked (as this used to) makes
// a control that is broken look like a control that is working — the one reading
// of the ledger that is worse than no reading at all. A deliberate block exits the
// process from block(), which never unwinds to here.
function timeOutcome(projectDir, { sensor, surface, target }, fn) {
  const started = Date.now();
  try {
    const out = fn();
    recordOutcome(projectDir, { sensor, ran: true, blocked: false, surface, target, elapsedMs: Date.now() - started });
    return out;
  } catch (err) {
    recordOutcome(projectDir, {
      sensor, ran: true, blocked: false, errored: true, surface, target, elapsedMs: Date.now() - started,
    });
    throw err;
  }
}

function readOutcomes(projectDir) {
  try {
    const raw = fs.readFileSync(path.join(projectDir, OUTCOMES_REL), 'utf8').trim();
    if (!raw) return [];
    return raw.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch (_) {
    return [];
  }
}

module.exports = { OUTCOMES_REL, recordOutcome, readOutcomes, timeOutcome };
