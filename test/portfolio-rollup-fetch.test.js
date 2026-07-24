'use strict';

// Increment 4b — --fetch (via ghStub), harness-version stamping, generate-attestation
// manifest-preference, and manifest/control-budget registration (design tests 7-10).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const H = require('./portfolio-rollup-helpers');
const { run } = require(path.join(H.SCRIPTS, 'portfolio-rollup'));
const secBaseline = require(path.join(H.SCRIPTS, 'scaffold-security-baseline'));
const { validate } = require(path.join(H.SCRIPTS, 'validate-harness-manifest'));
const { controlIds, budgetDecision, justifiedIds } = require(path.join(H.REPO_ROOT, '.claude', 'hooks', 'lib', 'control-budget'));
const { tmp, attestRoot, gitRunner, capture, readReport, contentsResponse, fetchRoutesFor, ghStub, generateAttestation, REPO_ROOT, SCRIPTS, NOW } = H;

// Named throw-stubs (an inline `() => { throw }` arrow trips the length parser).
function absentGh() { throw new Error('spawnSync gh ENOENT'); }
function forbiddenGh() { throw new Error('gh must not be called on a traversal entry'); }

// A gh stub that records every call and answers only the index.json route with a
// caller-supplied (possibly malicious) index — so a test can assert the follow-up
// contents call for a rejected entry path is never issued. Named (not an inline
// arrow) to keep the length parser happy.
function recordingIndexGh(calls, indexObj) {
  return function gh(args) {
    calls.push(args.join(' '));
    if (args.join(' ').includes('/contents/.claude/attestations/index.json')) {
      return JSON.stringify(contentsResponse(JSON.stringify(indexObj)));
    }
    throw new Error('unexpected gh call: ' + args.join(' '));
  };
}

// ============================ 7. --fetch via ghStub ==========================

test('7a: --fetch pulls fleet->index->base64 attestation into the collection dir', () => {
  const dir = tmp('pr-fetch-');
  const fleet = path.join(dir, 'fleet.json');
  fs.writeFileSync(fleet, JSON.stringify({ org: 'acme', repos: [{ owner: 'acme', repo: 'alpha' }, { owner: 'acme', repo: 'beta' }] }));
  const routes = [...fetchRoutesFor('acme', 'alpha', 'a'.repeat(40)), ...fetchRoutesFor('acme', 'beta', 'b'.repeat(40))];
  const outFile = path.join(dir, 'rollup.json');
  const res = capture(() => run([dir, '--fetch', '--fleet', fleet, '--target-version', '2.5.0', '--out', outFile], { cwd: dir, gh: ghStub(routes), now: () => NOW }));
  assert.strictEqual(res.code, 0, res.stderr);
  assert.ok(fs.existsSync(path.join(dir, 'acme__alpha.json')), 'fetched attestation written to the collection dir');
  const report = readReport(outFile);
  assert.strictEqual(report.summary.total, 2);
  assert.strictEqual(report.portfolio_compliant, true);
});

test('7b: a 404 repo is skipped and surfaces as not-attested', () => {
  const dir = tmp('pr-fetch-404-');
  const fleet = path.join(dir, 'fleet.json');
  fs.writeFileSync(fleet, JSON.stringify({ repos: [{ owner: 'acme', repo: 'alpha' }, { owner: 'acme', repo: 'ghost' }] }));
  const routes = [
    ...fetchRoutesFor('acme', 'alpha', 'a'.repeat(40)),
    ['repos/acme/ghost/contents/.claude/attestations/index.json', { __throw: 'gh: Not Found (HTTP 404)' }],
  ];
  const outFile = path.join(dir, 'rollup.json');
  const res = capture(() => run([dir, '--fetch', '--fleet', fleet, '--target-version', '2.5.0', '--out', outFile], { cwd: dir, gh: ghStub(routes), now: () => NOW }));
  assert.strictEqual(res.code, 0, res.stderr);
  const report = readReport(outFile);
  assert.strictEqual(report.summary.not_attested, 1);
  assert.ok(report.repos.find((r) => r.repo === 'acme/ghost' && r.status === 'not-attested'));
});

test('7c: gh absent/auth error => exit 2, never a vacuous green', () => {
  const dir = tmp('pr-fetch-absent-');
  const fleet = path.join(dir, 'fleet.json');
  fs.writeFileSync(fleet, JSON.stringify({ repos: [{ owner: 'acme', repo: 'alpha' }] }));
  const res = capture(() => run([dir, '--fetch', '--fleet', fleet, '--out', path.join(dir, 'r.json')], { cwd: dir, gh: absentGh, now: () => NOW }));
  assert.strictEqual(res.code, 2);
  assert.match(res.stderr, /gh (must be installed|error)/i);
});

test('7d: a traversal owner/repo is rejected before any gh call (exit 2)', () => {
  const dir = tmp('pr-fetch-trav-');
  const fleet = path.join(dir, 'fleet.json');
  fs.writeFileSync(fleet, JSON.stringify({ repos: [{ owner: '..', repo: 'x' }, { owner: 'acme', repo: 'a/b' }] }));
  const res = capture(() => run([dir, '--fetch', '--fleet', fleet, '--out', path.join(dir, 'r.json')], { cwd: dir, gh: forbiddenGh, now: () => NOW }));
  assert.strictEqual(res.code, 2);
  assert.match(res.stderr, /invalid fleet repo/);
});

test('7e: a MULTI-line gh 404 (real execFileSync shape) is recorded not-attested, not a fatal abort', () => {
  const dir = tmp('pr-fetch-404ml-');
  const fleet = path.join(dir, 'fleet.json');
  fs.writeFileSync(fleet, JSON.stringify({ repos: [{ owner: 'acme', repo: 'alpha' }, { owner: 'acme', repo: 'ghost' }] }));
  const routes = [
    ...fetchRoutesFor('acme', 'alpha', 'a'.repeat(40)),
    ['repos/acme/ghost/contents/.claude/attestations/index.json',
      { __throw: 'Command failed: gh api repos/acme/ghost/contents/.claude/attestations/index.json\ngh: Not Found (HTTP 404)' }],
  ];
  const outFile = path.join(dir, 'rollup.json');
  const res = capture(() => run([dir, '--fetch', '--fleet', fleet, '--target-version', '2.5.0', '--out', outFile], { cwd: dir, gh: ghStub(routes), now: () => NOW }));
  assert.strictEqual(res.code, 0, res.stderr);
  const report = readReport(outFile);
  assert.ok(report.repos.find((r) => r.repo === 'acme/ghost' && r.status === 'not-attested'), 'multi-line 404 => not-attested, not exit 2');
});

test('7f: a remote index entry path escaping .claude/attestations/ is rejected — no contents call — => not-attested', () => {
  const dir = tmp('pr-fetch-relpath-');
  const fleet = path.join(dir, 'fleet.json');
  fs.writeFileSync(fleet, JSON.stringify({ repos: [{ owner: 'acme', repo: 'evil' }] }));
  const evilIndex = { entries: [{ commit_sha: 'e'.repeat(40), generated_at: NOW, path: '../../../../repos/victim/contents/secrets.json' }], integrity: { algo: 'sha256', hash: 'x' } };
  const calls = [];
  const outFile = path.join(dir, 'rollup.json');
  const res = capture(() => run([dir, '--fetch', '--fleet', fleet, '--target-version', '2.5.0', '--out', outFile], { cwd: dir, gh: recordingIndexGh(calls, evilIndex), now: () => NOW }));
  assert.strictEqual(res.code, 0, res.stderr);
  assert.ok(!calls.some((c) => c.includes('secrets.json') || c.includes('victim')), 'no gh contents call issued for the traversal path');
  const report = readReport(outFile);
  assert.ok(report.repos.find((r) => r.repo === 'acme/evil' && r.status === 'not-attested'), 'the evil repo surfaces as a not-attested gap');
});

test('7g: a >1MB (encoding:"none") contents response is a fetch-miss => not-attested, not a fatal abort', () => {
  const dir = tmp('pr-fetch-enc-');
  const fleet = path.join(dir, 'fleet.json');
  fs.writeFileSync(fleet, JSON.stringify({ repos: [{ owner: 'acme', repo: 'big' }] }));
  const routes = [['repos/acme/big/contents/.claude/attestations/index.json', { content: '', encoding: 'none' }]];
  const outFile = path.join(dir, 'rollup.json');
  const res = capture(() => run([dir, '--fetch', '--fleet', fleet, '--target-version', '2.5.0', '--out', outFile], { cwd: dir, gh: ghStub(routes), now: () => NOW }));
  assert.strictEqual(res.code, 0, res.stderr);
  const report = readReport(outFile);
  assert.ok(report.repos.find((r) => r.repo === 'acme/big' && r.status === 'not-attested'), 'encoding:none => not-attested, not exit 2');
});

// ============================ 8. harness-version stamping =====================

test('8: applyHarnessVersion stamps a fresh manifest and preserves an operator value', () => {
  const fresh = {};
  secBaseline.applyHarnessVersion(fresh, '2.5.0');
  assert.strictEqual(fresh.harness_version, '2.5.0');
  const existing = { harness_version: '9.9.9' };
  secBaseline.applyHarnessVersion(existing, '2.5.0');
  assert.strictEqual(existing.harness_version, '9.9.9', 'an operator-set harness_version is preserved');
});

test('8b: scaffold round-trip stamps harness_version + ships the rollup script/skill', () => {
  const { applyScaffold } = require(path.join(SCRIPTS, 'scaffold-apply'));
  const work = tmp('pr-scaffold-');
  const target = path.join(work, 'project');
  const profilePath = path.join(work, 'profile.json');
  fs.writeFileSync(profilePath, JSON.stringify({
    name: 'rollup-probe', description: 'Rollup scaffold probe.',
    stack: { backend: null, frontend: null, database: null },
    projectType: 'D', verificationMode: 'C', modelTier: 'balanced', tracker: 'A', frameworkPacks: [], lsp: [],
  }));
  applyScaffold({ profile: profilePath, pluginSource: path.join(REPO_ROOT, '.claude'), target, scaffoldProfile: 'full' });
  const manifest = JSON.parse(fs.readFileSync(path.join(target, 'project-manifest.json'), 'utf8'));
  const harnessPkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.strictEqual(manifest.harness_version, harnessPkg.version);
  for (const rel of [
    path.join('scripts', 'portfolio-rollup.js'), path.join('scripts', 'portfolio-rollup-core.js'),
    path.join('skills', 'portfolio-rollup', 'SKILL.md'),
  ]) {
    assert.ok(fs.existsSync(path.join(target, '.claude', rel)), rel + ' must ship to scaffolded targets');
  }
});

// ============================ 9. attestation prefers manifest =================

test('9: generate-attestation prefers project-manifest.json#harness_version over package.json', () => {
  const root = attestRoot('2.5.0', 'notevaluated');
  fs.writeFileSync(path.join(root, 'project-manifest.json'), JSON.stringify({ harness_version: '7.7.7' }));
  const res = generateAttestation({
    root, attestDir: path.join(root, '.claude', 'attestations'),
    runner: gitRunner('acme', 'e', 'e'.repeat(40)), now: () => NOW,
  });
  assert.strictEqual(res.bundle.harness_version, '7.7.7', 'manifest stamp wins over package.json 2.5.0');
});

// ============================ 10. manifest + budget ==========================

test('10: manifest valid; portfolio-compliance-rollup registered; control budget holds at 138', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'harness-manifest.json'), 'utf8'));
  const { errors, counts } = validate(manifest);
  assert.deepStrictEqual(errors, [], errors.join('\n'));
  assert.strictEqual(counts.guides + counts.sensors, 138);
  const ids = controlIds(manifest);
  assert.ok(ids.includes('portfolio-compliance-rollup'));
  const baseline = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, '.claude', 'state', 'control-budget-baseline.json'), 'utf8'));
  assert.strictEqual(baseline.count, 138);
  assert.strictEqual(budgetDecision(ids, baseline, justifiedIds(manifest)).blocked, false);
});
