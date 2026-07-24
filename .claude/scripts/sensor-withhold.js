#!/usr/bin/env node

'use strict';

// CLI: node .claude/scripts/sensor-withhold.js record --sensor <id> --degraded <true|false> [--job "..."] [--evidence "..."]
//      node .claude/scripts/sensor-withhold.js            # list recorded verdicts
//
// Records a withhold-and-rerun experiment: remove one control, run a real
// representative job, and record whether the accepted outcome degraded. This is the
// real-job evidence sensor-value-report needs to promote a candidate-shelfware or
// proven-live gate to a decisive REMOVABLE / CONFIRMED-VALUABLE verdict — the test the
// canary (mechanical liveness only) cannot supply. See docs/harness-engineering.md.

const path = require('path');
const { recordVerdict, readVerdicts, latestBySensor } = require('../hooks/lib/withhold-verdicts');

const REPO = path.resolve(__dirname, '..', '..');

function flag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function disposition(degraded) {
  return degraded ? 'CONFIRMED-VALUABLE (withheld → job degraded)' : 'REMOVABLE (withheld → job unchanged)';
}

function doRecord(argv) {
  const sensor = flag(argv, '--sensor');
  const degradedRaw = flag(argv, '--degraded');
  if (!sensor || degradedRaw === undefined) {
    process.stderr.write('sensor-withhold: record needs --sensor <id> and --degraded <true|false>\n');
    return 1;
  }
  if (degradedRaw !== 'true' && degradedRaw !== 'false') {
    process.stderr.write(`sensor-withhold: --degraded must be true or false, got "${degradedRaw}"\n`);
    return 1;
  }
  const row = recordVerdict(REPO, {
    sensor, degraded: degradedRaw === 'true', job: flag(argv, '--job'), evidence: flag(argv, '--evidence'),
  });
  process.stdout.write(`sensor-withhold: recorded ${row.sensor} — ${disposition(row.degraded)}\n`);
  return 0;
}

function doList() {
  const latest = latestBySensor(readVerdicts(REPO));
  if (latest.size === 0) {
    process.stdout.write('sensor-withhold: no withhold-and-rerun verdicts recorded yet.\n');
    return 0;
  }
  process.stdout.write(`sensor-withhold: ${latest.size} control(s) with a subtractive verdict\n`);
  for (const [sensor, v] of latest) {
    const tag = v.degraded ? 'CONFIRMED-VALUABLE' : 'REMOVABLE';
    process.stdout.write(`  ${tag.padEnd(18)} ${sensor}${v.job ? ` job="${v.job}"` : ''}\n`);
  }
  return 0;
}

function main(argv) {
  return argv[0] === 'record' ? doRecord(argv.slice(1)) : doList();
}

module.exports = { main, disposition };

if (require.main === module) process.exit(main(process.argv.slice(2)));
