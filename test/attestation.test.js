'use strict';

// Increment 4a — per-repo durable compliance attestation with a corruption-detecting
// sha256 checksum (NOT tamper-proofing: the hash lives inside the file it covers, so
// an editor who rehashes verifies clean — see the "rehashed edit" test below).
// These tests round-trip the REAL harness-manifest.json (not a hand-built
// fixture) so the control_inventory totals and per-control clause resolution are
// proven against the shipped registry, and drive generate-attestation.js through
// an injected git runner + clock into a tmp attestation dir (no real
// <sha>.json/index.json is committed).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPTS = path.join(REPO_ROOT, '.claude', 'scripts');
const { generateAttestation, verifyAttestation } = require(path.join(SCRIPTS, 'generate-attestation'));
const { validate } = require(path.join(SCRIPTS, 'validate-harness-manifest'));
const { contentHash } = require(path.join(SCRIPTS, 'canonical-json'));
const { controlIds, budgetDecision, justifiedIds } = require(path.join(REPO_ROOT, '.claude', 'hooks', 'lib', 'control-budget'));

const NOW = '2026-07-19T00:00:00.000Z';
const SHA = 'deadbeefcafe0001';
const runner = (_cmd, args) => {
  if (args[0] === 'rev-parse') return `${SHA}\n`;
  if (args[1] === 'get-url') return 'git@github.com:acme/widgets.git\n';
  throw new Error(`unexpected git ${args.join(' ')}`);
};
const shaRunner = (sha) => (_cmd, args) => (args[0] === 'rev-parse' ? `${sha}\n` : 'git@github.com:acme/widgets.git\n');

// (The deep key-reorder canonicalization guard lives in attestation-hardening.test.js.)

// A tmp root carrying the REAL manifest + package.json + the default standard
// map; each test drops in only the optional inputs it exercises.
function makeRoot(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attest-'));
  fs.mkdirSync(path.join(root, '.claude', 'state'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude', 'templates'), { recursive: true });
  fs.mkdirSync(path.join(root, 'specs', 'reviews'), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, 'harness-manifest.json'), path.join(root, 'harness-manifest.json'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '2.5.0' }));
  const stdMap = opts.standardMap || readTemplateStandardMap();
  fs.writeFileSync(path.join(root, '.claude', 'templates', 'standard-map.json'), JSON.stringify(stdMap));
  for (const [name, body] of Object.entries(opts.reviews || {})) {
    fs.writeFileSync(path.join(root, 'specs', 'reviews', name), JSON.stringify(body));
  }
  for (const [name, body] of Object.entries(opts.state || {})) {
    const val = typeof body === 'string' ? body : JSON.stringify(body);
    fs.writeFileSync(path.join(root, '.claude', 'state', name), val);
  }
  return root;
}

function readTemplateStandardMap() {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, '.claude', 'templates', 'standard-map.json'), 'utf8'));
}

function gen(root, extra = {}) {
  return generateAttestation({ root, attestDir: path.join(root, '.claude', 'attestations'), runner, now: () => NOW, ...extra });
}

test('control_inventory round-trips the REAL manifest: total == guides+sensors == 130', () => {
  const root = makeRoot();
  const { bundle } = gen(root);
  const inv = bundle.control_inventory;
  assert.strictEqual(inv.total, 130);
  assert.strictEqual(inv.total, inv.guides + inv.sensors);
  assert.strictEqual(inv.guides, 43);
  assert.strictEqual(inv.sensors, 87);
  const axisSum = Object.values(inv.by_axis).reduce((a, b) => a + b, 0);
  const statusSum = Object.values(inv.by_status).reduce((a, b) => a + b, 0);
  assert.strictEqual(axisSum, 130);
  assert.strictEqual(statusSum, 130);
  assert.ok(inv.by_status.active > 0, 'expected active controls');
});

test('controls[] carry a resolved standard_ref; the new control maps by axis', () => {
  const root = makeRoot();
  const { bundle } = gen(root);
  const att = bundle.controls.find((c) => c.id === 'compliance-attestation');
  assert.ok(att, 'compliance-attestation control present');
  assert.strictEqual(att.axis, 'traceability');
  assert.strictEqual(att.standard_ref, 'AUD-audit-traceability');
  assert.ok(bundle.controls.every((c) => typeof c.standard_ref === 'string'));
  assert.strictEqual(bundle.standard_ref, 'harness-default/1');
});

test('identity is read at runtime: repo slug, sha, version, injected clock', () => {
  const root = makeRoot();
  const { bundle } = gen(root);
  assert.strictEqual(bundle.repo, 'acme/widgets');
  assert.strictEqual(bundle.commit_sha, SHA);
  assert.strictEqual(bundle.harness_version, '2.5.0');
  assert.strictEqual(bundle.generated_at, NOW);
  assert.strictEqual(bundle.evidence_format_version, 'harness-attestation/1');
  assert.strictEqual(bundle.schema_version, 1);
});

test('integrity hash is stable across re-serialization; untampered --verify exits 0', () => {
  const root = makeRoot();
  const { path: file, bundle } = gen(root);
  assert.strictEqual(bundle.integrity.algo, 'sha256');
  // Re-derive from the on-disk file: reordering keys must not change the hash.
  const res = verifyAttestation(file);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.recomputedHash, bundle.integrity.hash);
});

test('corruption detection: mutating a field without rehashing makes --verify exit non-zero', () => {
  const root = makeRoot();
  const { path: file } = gen(root);
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  (j.predicate || j).harness_version = '0.0.0-tampered'; // a field the envelope does not mirror
  fs.writeFileSync(file, JSON.stringify(j, null, 2));
  const res = verifyAttestation(file);
  assert.strictEqual(res.ok, false);
  assert.match(res.message, /INTEGRITY MISMATCH/);
});

// The checksum is stored inside the file it covers, so it cannot survive an
// adversary who rehashes. This test pins that limit: a --verify PASS must never be
// read as proof of authenticity. If signing lands (GPG/cosign/Sigstore), this test
// should start failing — that is the signal the guarantee genuinely got stronger.
test('a rehashed edit passes --verify: the checksum is not authenticity', () => {
  const root = makeRoot();
  const { path: file } = gen(root);
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  (j.predicate || j).harness_version = '0.0.0-tampered'; // a field the envelope does not mirror
  const body = j.predicate || j;
  delete body.integrity;
  body.integrity = { algo: 'sha256', hash: contentHash(body) }; // recompute, as any editor could
  fs.writeFileSync(file, JSON.stringify(j, null, 2));
  const res = verifyAttestation(file);
  assert.strictEqual(res.ok, true, 'a rehashed edit verifies clean — corruption detection, not tamper-proofing');
});

test('the mismatch message does not overstate what the checksum proves', () => {
  const root = makeRoot();
  const { path: file } = gen(root);
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  (j.predicate || j).harness_version = '0.0.0-tampered'; // a field the envelope does not mirror
  fs.writeFileSync(file, JSON.stringify(j, null, 2));
  const { message } = verifyAttestation(file);
  assert.doesNotMatch(message, /TAMPER DETECTED/, 'must not claim tamper detection');
  assert.match(message, /does NOT prove/i, 'must state the limit of the check');
  assert.match(message, /signing/i, 'must point at what would give authenticity');
});

test('both verify shapes ingested: flat branch-protection + nested deploy-gate', () => {
  const root = makeRoot({
    reviews: {
      'branch-protection-verify.json': { compliant: true, drift: [], ruleset: 'r', target: 'acme/widgets' },
      'deploy-gate-verify.json': { compliant: true, environments: [{ environment: 'prod', repo: 'acme/widgets', compliant: true, drift: [] }] },
    },
  });
  const { bundle } = gen(root);
  assert.strictEqual(bundle.verify.branch_protection.compliant, true);
  assert.deepStrictEqual(bundle.verify.branch_protection.drift, []);
  assert.strictEqual(bundle.verify.deploy_gate.environments[0].environment, 'prod');
  assert.strictEqual(bundle.compliant, true);
});

test('absent verify/gate inputs are recorded null, not omitted', () => {
  const root = makeRoot();
  const { bundle } = gen(root);
  assert.strictEqual(bundle.verify.branch_protection, null);
  assert.strictEqual(bundle.verify.deploy_gate, null);
  assert.strictEqual(bundle.gate.pass, null);
  assert.strictEqual(bundle.gate.quality_card_summary, null);
});

test('compliant logic: a failing verify output forces compliant:false', () => {
  const root = makeRoot({
    reviews: { 'branch-protection-verify.json': { compliant: false, drift: [{ rule: 'ruleset', field: 'presence' }] } },
  });
  const { bundle } = gen(root);
  assert.strictEqual(bundle.verify.branch_protection.compliant, false);
  assert.strictEqual(bundle.compliant, false);
});

test('compliant logic: a failing gate forces compliant:false', () => {
  const root = makeRoot({
    state: { 'gate-receipt.json': { generated_at: NOW, pass: false } },
    reviews: { 'quality-card.json': { summary: { pass: 3, fail: 1, missing: 0, skipped: 0 } } },
  });
  const { bundle } = gen(root);
  assert.strictEqual(bundle.gate.pass, false);
  assert.deepStrictEqual(bundle.gate.quality_card_summary, { pass: 3, fail: 1, missing: 0, skipped: 0 });
  assert.strictEqual(bundle.compliant, false);
});

test('compliant logic: all present + passing => true', () => {
  const root = makeRoot({
    state: { 'gate-receipt.json': { pass: true } },
    reviews: {
      'branch-protection-verify.json': { compliant: true, drift: [] },
      'deploy-gate-verify.json': { compliant: true, environments: [] },
    },
  });
  assert.strictEqual(gen(root).bundle.compliant, true);
});

test('fail-safe: all sources absent => not-evaluated + compliant:false (no vacuous green)', () => {
  const root = makeRoot();
  const { bundle } = gen(root);
  assert.strictEqual(bundle.status, 'not-evaluated');
  assert.strictEqual(bundle.compliant, false);
  assert.strictEqual(bundle.sources_evaluated, 0);
  assert.strictEqual(bundle.verify.branch_protection, null, 'absent is recorded null');
});

test('immutability: a second run on the same SHA is a no-op; --force overwrites', () => {
  const root = makeRoot();
  const first = gen(root);
  assert.strictEqual(first.action, 'written');
  const second = generateAttestation({ root, attestDir: path.join(root, '.claude', 'attestations'), runner, now: () => '2026-07-19T11:11:11.000Z' });
  assert.strictEqual(second.action, 'already-attested');
  assert.strictEqual(second.bundle.generated_at, NOW, 'no-op must not rewrite generated_at');
  const forced = generateAttestation({ root, attestDir: path.join(root, '.claude', 'attestations'), runner, now: () => '2026-07-19T12:00:00.000Z', force: true });
  assert.strictEqual(forced.action, 'written');
  assert.strictEqual(forced.bundle.generated_at, '2026-07-19T12:00:00.000Z');
});

test('index.json appends and dedupes by commit_sha', () => {
  const root = makeRoot();
  const attestDir = path.join(root, '.claude', 'attestations');
  gen(root);
  gen(root, { force: true }); // same SHA again
  const index = JSON.parse(fs.readFileSync(path.join(attestDir, 'index.json'), 'utf8'));
  assert.strictEqual(index.entries.length, 1, 'same SHA must not create a second index entry');
  assert.strictEqual(index.entries[0].commit_sha, SHA);
  assert.strictEqual(index.entries[0].status, 'not-evaluated');
  assert.strictEqual(index.integrity.algo, 'sha256');
  // A different SHA does append.
  generateAttestation({ root, attestDir, runner: shaRunner('feed0002'), now: () => NOW });
  const index2 = JSON.parse(fs.readFileSync(path.join(attestDir, 'index.json'), 'utf8'));
  assert.strictEqual(index2.entries.length, 2);
});

test('ratchets read from baseline files; empty/missing => null', () => {
  const root = makeRoot({
    state: {
      'coverage-baseline.txt': '80\n',
      'cycle-baseline.txt': '0\n',
      'coupling-baseline.txt': '', // present but empty => null
      'control-budget-baseline.json': { count: 128, ids: [] },
    },
  });
  const { bundle } = gen(root);
  assert.strictEqual(bundle.ratchets.coverage, 80);
  assert.strictEqual(bundle.ratchets.cycle, 0);
  assert.strictEqual(bundle.ratchets.coupling, null);
  assert.strictEqual(bundle.ratchets.duplication, null); // file absent
  assert.strictEqual(bundle.ratchets.security, null);
  assert.strictEqual(bundle.ratchets.control_budget, 128);
});

test('standard-map: by_id overrides by_axis; an unknown axis is recorded unmapped', () => {
  const root = makeRoot({
    standardMap: {
      id: 'custom/9',
      by_axis: { traceability: 'AXIS-TRACE' },
      by_id: { 'compliance-attestation': 'ID-SPECIFIC-9' },
    },
  });
  const { bundle } = gen(root);
  assert.strictEqual(bundle.standard_ref, 'custom/9');
  const att = bundle.controls.find((c) => c.id === 'compliance-attestation');
  assert.strictEqual(att.standard_ref, 'ID-SPECIFIC-9', 'by_id must win over by_axis');
  // maintainability/behaviour/architecture are absent from this map => unmapped.
  const other = bundle.controls.find((c) => c.axis !== 'traceability' && c.id !== 'compliance-attestation');
  assert.strictEqual(other.standard_ref, 'unmapped');
});

test('manifest is valid with the new sensor and the control budget holds at 130', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'harness-manifest.json'), 'utf8'));
  const { errors, counts } = validate(manifest);
  assert.deepStrictEqual(errors, [], errors.join('\n'));
  assert.strictEqual(counts.guides + counts.sensors, 130);
  const ids = controlIds(manifest);
  assert.strictEqual(ids.length, 130);
  assert.ok(ids.includes('compliance-attestation'));
  assert.ok(ids.includes('portfolio-compliance-rollup'));
  const baseline = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, '.claude', 'state', 'control-budget-baseline.json'), 'utf8'));
  const decision = budgetDecision(ids, baseline, justifiedIds(manifest));
  assert.strictEqual(decision.blocked, false, 'control budget must not block at 130');
});

test('scaffold round-trip: generator script, attestation skill, and standard-map ship to a target', () => {
  const { applyScaffold } = require(path.join(SCRIPTS, 'scaffold-apply'));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attest-scaffold-'));
  const target = path.join(workDir, 'project');
  const profilePath = path.join(workDir, 'profile.json');
  fs.writeFileSync(profilePath, JSON.stringify({
    name: 'attest-probe', description: 'Attestation scaffold probe.',
    stack: { backend: null, frontend: null, database: null },
    projectType: 'D', verificationMode: 'C', modelTier: 'balanced',
    tracker: 'A', frameworkPacks: [], lsp: [],
  }));
  applyScaffold({ profile: profilePath, pluginSource: path.join(REPO_ROOT, '.claude'), target, scaffoldProfile: 'full' });
  const dc = path.join(target, '.claude');
  for (const rel of [
    path.join('scripts', 'generate-attestation.js'),
    path.join('scripts', 'attestation-bundle.js'),
    path.join('scripts', 'attestation-io.js'),
    path.join('scripts', 'canonical-json.js'),
    path.join('skills', 'attestation', 'SKILL.md'),
    path.join('templates', 'standard-map.json'),
  ]) {
    assert.ok(fs.existsSync(path.join(dc, rel)), `${rel} must ship to scaffolded targets`);
  }
  const shipped = JSON.parse(fs.readFileSync(path.join(dc, 'templates', 'standard-map.json'), 'utf8'));
  assert.strictEqual(shipped.id, 'harness-default/1');
});
