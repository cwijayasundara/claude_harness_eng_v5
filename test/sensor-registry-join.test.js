'use strict';

// The bite ledger and the control registry have to share a key, or neither can be
// trusted. They did not: 16 of the 31 sensor ids the code emitted matched no
// registered control, and 71 of the 88 registered sensors never emitted anything.
// So "33 of 131 controls are instrumented" was not a measurement — the two sides
// were not joinable at all, and the value meter was reporting on controls the
// registry had never heard of.
//
// Two rules make the join real and keep it real:
//   1. every sensor id the code emits resolves to a registered control (by id or a
//      declared `records_as` alias) — a new gate cannot be orphaned by accident;
//   2. the count of registered sensors that actually emit is a ratchet.

const assert = require('assert');
const path = require('path');
const { test } = require('node:test');

const {
  emittedSensorIds, resolveSensorId, instrumentedSensors,
} = require('../.claude/scripts/validate-harness-manifest');

const ROOT = path.join(__dirname, '..');
const manifest = require('../harness-manifest.json');

test('every sensor id the code emits resolves to a registered control', () => {
  const orphans = emittedSensorIds(ROOT).filter((id) => !resolveSensorId(manifest, id));
  assert.deepStrictEqual(
    orphans, [],
    `these gates run but are in no registry — register them, or declare records_as:\n  ${orphans.join('\n  ')}`
  );
});

test('resolveSensorId maps an alias to its registered control', () => {
  assert.strictEqual(resolveSensorId(manifest, 'coverage-ratchet-js'), 'coverage-ratchet');
  assert.strictEqual(resolveSensorId(manifest, 'secret-scan-write'), 'secret-scan');
  assert.strictEqual(resolveSensorId(manifest, 'at-first-gate'), 'at-first-proof');
});

test('resolveSensorId returns a registered id unchanged', () => {
  assert.strictEqual(resolveSensorId(manifest, 'length-caps'), 'length-caps');
});

test('resolveSensorId returns null for an unknown id', () => {
  assert.strictEqual(resolveSensorId(manifest, 'no-such-sensor'), null);
});

test('an alias may not collide with a registered sensor id', () => {
  const ids = new Set(manifest.sensors.map((s) => s.id));
  for (const s of manifest.sensors) {
    for (const alias of s.records_as || []) {
      assert.ok(!ids.has(alias), `sensor ${s.id}: alias "${alias}" is also a registered id`);
    }
  }
});

test('instrumentation coverage does not regress', () => {
  // A ratchet, not a target: the 88 sensors are not all instrumentable (planning
  // and drift cadences mostly produce reports, not per-run outcomes). What must
  // never happen is coverage going DOWN, or a new gate landing uninstrumented.
  const baseline = require('../.claude/state/instrumentation-baseline.json');
  const now = instrumentedSensors(manifest, ROOT).length;
  assert.ok(
    now >= baseline.instrumented,
    `instrumented sensors dropped from ${baseline.instrumented} to ${now} — a control stopped reporting`
  );
});
