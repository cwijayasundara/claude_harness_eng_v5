#!/usr/bin/env node

'use strict';

// CLI: node .claude/scripts/validate-harness-manifest.js [manifest.json]
// Validates harness-manifest.json — the guides/sensors registry that HARNESS.md
// renders. Enforces the honesty invariant stated in HARNESS.md: every active or
// partial entry must point at a real wired_at file, so the registry cannot
// silently drift from reality. Also checks the controlled vocabularies (axis,
// type, cadence, status), id uniqueness, and gap_ref shape.
// Run manually, and via test/harness-manifest.test.js in `npm test`.
// Exit 0 = valid, 1 = invalid, 2 = usage/IO error.

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_MANIFEST = path.join(REPO_ROOT, 'harness-manifest.json');

const AXES = new Set(['maintainability', 'architecture', 'behaviour', 'traceability']);
const SENSOR_TYPES = new Set(['computational', 'inferential', 'hybrid']);
const CADENCES = new Set(['planning', 'session', 'commit', 'integration', 'drift']);
const STATUSES = new Set(['active', 'partial', 'planned']);
const SCOPES = new Set(['universal', 'test-covered', 'layer-roots', 'contexts', 'runtime', 'dependencies', 'artifacts', 'repo', 'portfolio']);
const GAP_RE = /^G\d+$/;

// A wired_at may carry a JSON-pointer-ish fragment (file.json#path); the file is
// what must exist on disk.
function resolveWiredAt(wiredAt) {
  return path.join(REPO_ROOT, String(wiredAt).split('#')[0]);
}

// The honesty invariant: anything not purely `planned` must resolve on disk;
// a `planned` entry must instead name the gap it tracks.
function checkWiring(e, where, errors) {
  const status = e.status || 'active'; // active is the default when omitted
  if (status === 'planned') {
    if (!('gap_ref' in e)) errors.push(`${where} ${e.id}: planned entry must declare a gap_ref`);
  } else if (!e.wired_at) {
    errors.push(`${where} ${e.id}: status "${status}" requires a wired_at`);
  } else if (!fs.existsSync(resolveWiredAt(e.wired_at))) {
    errors.push(`${where} ${e.id}: wired_at does not exist -> ${e.wired_at}`);
  }
}

function checkEntry(e, where, seen, errors) {
  if (!e.id) { errors.push(`${where}: entry missing id`); return; }
  if (seen.has(e.id)) errors.push(`${where}: duplicate id "${e.id}" (also in ${seen.get(e.id)})`);
  else seen.set(e.id, where);

  if (!AXES.has(e.axis)) errors.push(`${where} ${e.id}: invalid axis "${e.axis}"`);
  if (!STATUSES.has(e.status || 'active')) errors.push(`${where} ${e.id}: invalid status "${e.status}"`);
  if ('gap_ref' in e && !GAP_RE.test(e.gap_ref)) {
    errors.push(`${where} ${e.id}: gap_ref "${e.gap_ref}" must match /^G\\d+$/`);
  }
  checkWiring(e, where, errors);
}

function checkTopLevel(manifest, errors) {
  for (const key of ['version', 'guides', 'sensors']) {
    if (!(key in manifest)) errors.push(`missing top-level key: ${key}`);
  }
  if (!Array.isArray(manifest.guides)) errors.push('guides must be an array');
  if (!Array.isArray(manifest.sensors)) errors.push('sensors must be an array');
}

function validate(manifest) {
  const errors = [];
  const seen = new Map();
  checkTopLevel(manifest, errors);

  const guides = Array.isArray(manifest.guides) ? manifest.guides : [];
  const sensors = Array.isArray(manifest.sensors) ? manifest.sensors : [];

  for (const g of guides) {
    checkEntry(g, 'guide', seen, errors);
    if (g.kind && g.kind !== 'feedforward') errors.push(`guide ${g.id}: kind must be "feedforward"`);
  }
  for (const s of sensors) {
    checkEntry(s, 'sensor', seen, errors);
    if (!SENSOR_TYPES.has(s.type)) errors.push(`sensor ${s.id}: invalid type "${s.type}"`);
    if (!CADENCES.has(s.cadence)) errors.push(`sensor ${s.id}: invalid cadence "${s.cadence}"`);
    if ((s.status || 'active') !== 'planned' && !SCOPES.has(s.scope)) {
      errors.push(`sensor ${s.id}: active/partial sensor needs a scope in {${[...SCOPES].join(', ')}}`);
    }
  }

  return { errors, counts: { guides: guides.length, sensors: sensors.length } };
}

// --- the ledger <-> registry join ------------------------------------------
//
// A control that emits outcomes under an id the registry does not know is
// invisible to the value meter and absent from HARNESS.md: it runs, but nothing
// can reason about it. These helpers make the join checkable from source alone
// (the ledger itself is gitignored runtime state, so CI cannot read it).

function jsFilesUnder(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) jsFilesUnder(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

// Ids passed as string literals to runCheck(...) or recordOutcome({sensor: ...}).
// Ids the commit registry derives from GATE_CATALOG are added from the catalog.
function emittedSensorIds(repoRoot) {
  const ids = new Set();
  const files = jsFilesUnder(path.join(repoRoot, '.claude', 'hooks'))
    .concat(jsFilesUnder(path.join(repoRoot, '.claude', 'scripts')));
  for (const file of files) {
    let src = '';
    try { src = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
    for (const m of src.matchAll(/runCheck\(\s*['"]([^'"]+)['"]/g)) ids.add(m[1]);
    for (const m of src.matchAll(/sensor:\s*['"]([^'"]+)['"]/g)) ids.add(m[1]);
  }
  try {
    for (const g of require(path.join(repoRoot, '.claude', 'hooks', 'lib', 'gate-registry')).GATE_CATALOG) {
      ids.add(g.id);
    }
  } catch (_) { /* registry absent in a trimmed install */ }
  return [...ids].sort();
}

/** @returns {string|null} the registered control id this ledger id belongs to. */
function resolveSensorId(manifest, emittedId) {
  const sensors = Array.isArray(manifest.sensors) ? manifest.sensors : [];
  if (sensors.some((s) => s.id === emittedId)) return emittedId;
  const owner = sensors.find((s) => (s.records_as || []).includes(emittedId));
  return owner ? owner.id : null;
}

/** Registered sensors that actually emit an outcome, under their id or an alias. */
function instrumentedSensors(manifest, repoRoot) {
  const emitted = new Set(emittedSensorIds(repoRoot));
  return (manifest.sensors || []).filter(
    (s) => emitted.has(s.id) || (s.records_as || []).some((a) => emitted.has(a))
  );
}

module.exports = {
  validate, DEFAULT_MANIFEST, emittedSensorIds, resolveSensorId, instrumentedSensors,
};

if (require.main === module) {
  const manifestPath = process.argv[2] || DEFAULT_MANIFEST;
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    process.stderr.write(`validate-harness-manifest: cannot read ${manifestPath}: ${err.message}\n`);
    process.exit(2);
  }
  const { errors, counts } = validate(manifest);
  const orphans = emittedSensorIds(REPO_ROOT).filter((id) => !resolveSensorId(manifest, id));
  for (const id of orphans) {
    errors.push(`sensor id "${id}" is emitted by a running gate but is in no registry entry ` +
      '(add the control, or list it under records_as on the control that owns it)');
  }
  if (errors.length) {
    process.stderr.write(`harness-manifest INVALID (${errors.length} error(s)):\n`);
    for (const e of errors) process.stderr.write(`  - ${e}\n`);
    process.exit(1);
  }
  const wired = instrumentedSensors(manifest, REPO_ROOT).length;
  process.stdout.write(`harness-manifest OK: ${counts.guides} guides, ${counts.sensors} sensors, ` +
    `all wired_at paths resolve; ${wired}/${counts.sensors} sensors emit to the bite ledger.\n`);
  process.exit(0);
}
