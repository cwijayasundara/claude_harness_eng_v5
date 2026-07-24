'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { main, disposition } = require('../.claude/scripts/sensor-withhold');

// The disposition string is what the operator reads back to confirm the experiment was
// captured as they intended, so its polarity must not silently invert.
test('disposition maps degraded to keep and not-degraded to cut', () => {
  assert.match(disposition(true), /CONFIRMED-VALUABLE/);
  assert.match(disposition(false), /REMOVABLE/);
});

test('record rejects a missing sensor without writing', () => {
  assert.strictEqual(main(['record', '--degraded', 'true']), 1);
});

test('record rejects a non-boolean --degraded', () => {
  // "maybe" must not be coerced to a verdict — an ambiguous experiment is not a result.
  assert.strictEqual(main(['record', '--sensor', 'x', '--degraded', 'maybe']), 1);
});
