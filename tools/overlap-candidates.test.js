'use strict';

// Tests for the SAME-INVARIANT OVERLAP pre-pass — the deterministic clusterer that
// feeds the de-dup audit a ranked candidate list instead of a full per-axis scan.
// The load-bearing property under test is RANK-not-FILTER: a pair with no signal is
// never emitted, but its members must still surface in the residual bucket so
// "not clustered" can never be mistaken for "certified overlap-free".

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { clusterOverlaps, pairSignals, jaccard, tokens, loadControls,
  buildMarker, auditedIds, staleControls } = require('./overlap-candidates');

const prep = (c) => ({
  id: c.id, axis: c.axis, file: (c.wired_at || '').split('#')[0],
  gap_ref: c.gap_ref || null, tokens: tokens(`${c.description || ''} ${c.signal || ''}`),
});

test('tokens drops stopwords and short tokens, keeps significant terms', () => {
  const t = tokens('the invariant grounding trace of net');
  assert.ok(t.has('invariant') && t.has('grounding') && t.has('trace'));
  assert.ok(!t.has('the'), 'stopword dropped');
  assert.ok(!t.has('net'), 'a 3-char token is below the length floor');
});

test('jaccard is intersection over union', () => {
  assert.strictEqual(jaccard(new Set(['x', 'y', 'z']), new Set(['y', 'z', 'w'])), 0.5);
  assert.strictEqual(jaccard(new Set(), new Set(['a'])), 0, 'empty side is 0, never NaN');
});

test('pairSignals fires on a shared gap_ref', () => {
  const sig = pairSignals(prep({ id: 'a', gap_ref: 'G32' }), prep({ id: 'b', gap_ref: 'G32' }));
  assert.deepStrictEqual(sig, [{ kind: 'gap_ref', evidence: 'G32' }]);
});

test('pairSignals fires on the same wired_at file, fragment stripped', () => {
  const sig = pairSignals(
    prep({ id: 'a', wired_at: 'harness-manifest.json#x' }),
    prep({ id: 'b', wired_at: 'harness-manifest.json#y' }));
  assert.deepStrictEqual(sig, [{ kind: 'wired_at', evidence: 'harness-manifest.json' }]);
});

test('pairSignals fires on high description overlap alone', () => {
  const a = prep({ id: 'a', description: 'deterministic grounding invariant linkage across planning trace chain' });
  const b = prep({ id: 'b', description: 'deterministic grounding invariant linkage planning trace chain owner' });
  const sig = pairSignals(a, b);
  assert.strictEqual(sig.length, 1);
  assert.strictEqual(sig[0].kind, 'description');
});

test('a multi-signal pair outranks a description-only pair', () => {
  const controls = [
    { id: 'canary-a', axis: 'behaviour', gap_ref: 'G32', wired_at: 'x.js', description: 'canary first rollout feature discipline' },
    { id: 'canary-b', axis: 'behaviour', gap_ref: 'G32', wired_at: 'x.js', description: 'canary first rollout feature discipline' },
    { id: 'attest-a', axis: 'traceability', description: 'portfolio attestation rollup integrity hashed evidence record' },
    { id: 'attest-b', axis: 'traceability', description: 'portfolio attestation rollup integrity hashed evidence record' },
  ];
  const { pairs } = clusterOverlaps(controls);
  assert.strictEqual(pairs[0].a, 'canary-a');
  assert.strictEqual(pairs[0].b, 'canary-b');
  assert.strictEqual(pairs[0].score, 2.2, 'gap_ref 1.0 + wired_at 0.7 + description 0.5');
  assert.ok(pairs[pairs.length - 1].score < pairs[0].score);
});

test('RANK-not-FILTER: an unsignalled control is not paired but IS in residual', () => {
  const controls = [
    { id: 'a', axis: 'maintainability', gap_ref: 'G6', description: 'coupling hub duplication candidate pack' },
    { id: 'b', axis: 'maintainability', gap_ref: 'G6', description: 'coupling hub duplication candidate pack' },
    { id: 'loner', axis: 'architecture', description: 'wholly unrelated performance latency budget ratchet' },
  ];
  const { pairs, residual } = clusterOverlaps(controls);
  assert.ok(pairs.every((p) => p.a !== 'loner' && p.b !== 'loner'), 'no signal → not paired');
  assert.ok(residual.includes('loner'), 'but it must still be visible for the full-scan backstop');
});

test('every control is accounted for: clustered ∪ residual = all units (nothing dropped)', () => {
  const controls = [
    { id: 'a', axis: 'x', gap_ref: 'G1', description: 'alpha beta gamma delta' },
    { id: 'b', axis: 'x', gap_ref: 'G1', description: 'alpha beta gamma delta' },
    { id: 'c', axis: 'y', description: 'nothing shared here whatsoever unique' },
  ];
  const { pairs, residual, units } = clusterOverlaps(controls);
  const clustered = new Set(pairs.flatMap((p) => [p.a, p.b]));
  assert.strictEqual(clustered.size + residual.length, units);
});

test('a cross-axis pair is labelled with both axes and sameAxis:false', () => {
  const controls = [
    { id: 'a', axis: 'maintainability', wired_at: 'shared.js', description: 'x' },
    { id: 'b', axis: 'traceability', wired_at: 'shared.js', description: 'x' },
  ];
  const { pairs } = clusterOverlaps(controls);
  assert.strictEqual(pairs[0].sameAxis, false);
  assert.deepStrictEqual(pairs[0].axes, ['maintainability', 'traceability']);
});

test('clusterOverlaps fails loudly on empty input rather than passing vacuously', () => {
  assert.throws(() => clusterOverlaps([]), /no controls/i,
    'an empty control set must error, not report "no overlaps found"');
});

test('loadControls counts real guides+sensors and excludes planned entries', () => {
  const manifest = {
    guides: [{ id: 'g1', axis: 'a', status: 'active' }, { id: 'g2', axis: 'a', status: 'planned' }],
    sensors: [{ id: 's1', axis: 'b' }],
  };
  const ids = loadControls(manifest).map((c) => c.id);
  assert.deepStrictEqual(ids, ['g1', 's1'], 'planned is aspirational, not a live control');
});

// Round-trip the REAL manifest through the REAL loader — the discipline from
// CLAUDE.md #5: a hand-built fixture can pass while the tool is inert against the
// actual artifact shape. This proves the pre-pass runs end-to-end on today's manifest.
test('round-trips the real harness-manifest.json without dropping any control', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'harness-manifest.json'), 'utf8'));
  const controls = loadControls(manifest);
  assert.ok(controls.length > 100, 'the live manifest carries a real control inventory');
  const { pairs, residual, units } = clusterOverlaps(controls);
  assert.strictEqual(units, controls.length);
  const ids = new Set(controls.map((c) => c.id));
  for (const p of pairs) {
    assert.ok(ids.has(p.a) && ids.has(p.b), 'every pair names real control ids');
  }
  const clustered = new Set(pairs.flatMap((p) => [p.a, p.b]));
  assert.strictEqual(clustered.size + residual.length, units, 'no control is silently dropped');
});

// --- Staleness backstop: the cheap pre-pass can only narrow recall, so a periodic
// FULL scan (agents reading source) must still sweep the residual. The marker records
// which controls the last full audit covered; staleControls names what has been added
// since, so the backstop can never silently fall behind the growing inventory.

test('buildMarker records every control id, sorted, with the timestamp', () => {
  const m = buildMarker([{ id: 'c' }, { id: 'a' }, { id: 'b' }], '2026-07-24T00:00:00Z');
  assert.deepStrictEqual(m, { timestamp: '2026-07-24T00:00:00Z', controlIds: ['a', 'b', 'c'] });
});

test('auditedIds is an empty set when no marker exists', () => {
  assert.strictEqual(auditedIds(null).size, 0);
  assert.strictEqual(auditedIds({ controlIds: ['x'] }).has('x'), true);
});

test('no marker means EVERY control is stale (first run is a signal, not a silent pass)', () => {
  const stale = staleControls([{ id: 'a' }, { id: 'b' }], null);
  assert.deepStrictEqual(stale, ['a', 'b']);
});

test('staleControls names only controls added since the last full audit, sorted', () => {
  const marker = buildMarker([{ id: 'a' }, { id: 'b' }], '2026-07-24T00:00:00Z');
  const stale = staleControls([{ id: 'b' }, { id: 'a' }, { id: 'd' }, { id: 'c' }], marker);
  assert.deepStrictEqual(stale, ['c', 'd'], 'a and b were already audited; c and d are new');
});

test('a marker covering the whole current inventory leaves nothing stale', () => {
  const controls = [{ id: 'a' }, { id: 'b' }];
  assert.deepStrictEqual(staleControls(controls, buildMarker(controls, 't')), []);
});
