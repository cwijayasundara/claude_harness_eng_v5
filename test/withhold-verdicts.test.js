'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { recordVerdict, readVerdicts, latestBySensor, WITHHOLD_REL } =
  require('../.claude/hooks/lib/withhold-verdicts');

function tmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wv-')); fs.mkdirSync(path.join(d, '.claude/state'), { recursive: true }); return d; }

// The withhold verdict is the real-job evidence the canary (mechanical liveness only)
// cannot supply, so the fields the value meter reads have to survive a round-trip.
test('recordVerdict persists sensor, degraded, job and evidence', () => {
  const d = tmp();
  recordVerdict(d, { sensor: 'secret-scan', degraded: true, job: 'add API client', evidence: 'leaked key merged' });
  const [row] = readVerdicts(d);
  assert.strictEqual(row.sensor, 'secret-scan');
  assert.strictEqual(row.degraded, true);
  assert.strictEqual(row.job, 'add API client');
  assert.strictEqual(row.evidence, 'leaked key merged');
  assert.strictEqual(typeof row.ts, 'number');
});

test('recordVerdict coerces degraded to a real boolean and omits absent optionals', () => {
  const d = tmp();
  recordVerdict(d, { sensor: 'x', degraded: 0 });
  const [row] = readVerdicts(d);
  assert.strictEqual(row.degraded, false);
  assert.ok(!('job' in row) && !('evidence' in row));
});

// Unlike the bite ledger, this is an operator-invoked record — a silent write failure
// would let someone believe an experiment was captured when it was not. It must fail loud.
test('recordVerdict throws when the state dir cannot be written', () => {
  const d = tmp();
  const bad = path.join(d, 'afile');
  fs.writeFileSync(bad, 'x');
  assert.throws(() => recordVerdict(path.join(bad, 'nope'), { sensor: 's', degraded: false }));
});

test('readVerdicts returns [] when the ledger is absent', () => {
  assert.deepStrictEqual(readVerdicts(tmp()), []);
});

test('latestBySensor keeps only the most recent verdict per control', () => {
  // A control changes and is re-tested; the latest experiment is the one that governs.
  const latest = latestBySensor([
    { sensor: 'a', degraded: true, ts: 100 },
    { sensor: 'a', degraded: false, ts: 200 },
    { sensor: 'b', degraded: true, ts: 150 },
  ]);
  assert.strictEqual(latest.get('a').degraded, false, 'newer verdict wins');
  assert.strictEqual(latest.get('b').degraded, true);
  assert.strictEqual(latest.size, 2);
});

test('WITHHOLD_REL is a distinct ledger from the bite ledger', () => {
  assert.ok(WITHHOLD_REL.endsWith(path.join('.claude', 'state', 'sensor-withhold.jsonl')));
});
