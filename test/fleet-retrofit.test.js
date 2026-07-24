'use strict';

// Fleet-retrofit runner — integration over the REAL Inc 2/3 provisioners with an
// injected gh stub (design tests 3, 6, 7, 8) + manifest/control-budget registration
// (design test 9). fleet-retrofit calls provision-protection / provision-environments
// run() per repo; the stub answers their real gh api calls so they return real exit
// codes. No hand-built provisioner double.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const H = require('./fleet-retrofit-helpers');
const { tmp, defaultGithub, operatorCwd, writeFleet, makeGh, capture, readReport, REPO_ROOT, SCRIPTS, NOW } = H;
const { run } = require(path.join(SCRIPTS, 'fleet-retrofit'));

function runFleet(cwd, fleet, extraArgs, gh) {
  const outFile = path.join(cwd, 'fleet-retrofit.json');
  const args = ['--fleet', fleet, '--out', outFile, ...(extraArgs || [])];
  const res = capture(() => run(args, { cwd, gh, now: () => NOW }));
  return { res, report: fs.existsSync(outFile) ? readReport(outFile) : null, outFile };
}

// ===================== 3 + 8. isolation + real per-repo round-trip ===========

test('3: a mid-fleet failure is isolated — repos after it still run, all reported', () => {
  const github = defaultGithub();
  const cwd = operatorCwd(github);
  const fleet = writeFleet(cwd, [
    { owner: 'acme', repo: 'alpha' }, { owner: 'acme', repo: 'ghost' }, { owner: 'acme', repo: 'gamma' },
  ]);
  const calls = [];
  const gh = makeGh(github, { 'acme/alpha': 'gated', 'acme/ghost': 'throw', 'acme/gamma': 'gated' }, calls);
  const { res, report } = runFleet(cwd, fleet, [], gh);

  assert.strictEqual(report.summary.total, 3);
  assert.strictEqual(report.repos.find((r) => r.repo === 'acme/alpha').status, 'gated');
  assert.strictEqual(report.repos.find((r) => r.repo === 'acme/ghost').status, 'failed');
  assert.strictEqual(report.repos.find((r) => r.repo === 'acme/gamma').status, 'gated', 'gamma ran despite ghost failing before it');
  // Real round-trip proof: the provisioner translated --repo acme/gamma into a
  // repos/acme/gamma/... gh path, issued AFTER ghost's failing calls.
  assert.ok(calls.some((c) => c.includes('repos/acme/gamma/rulesets')), 'gamma provisioner actually ran');
  assert.strictEqual(report.fleet_gated, false);
  assert.strictEqual(res.code, 1, 'any non-gated repo => exit 1');
});

// ===================== 5/6. all-gated => exit 0 ==============================

test('6: an all-gated fleet => fleet_gated:true, exit 0, report at --out and default', () => {
  const github = defaultGithub();
  const cwd = operatorCwd(github);
  const fleet = writeFleet(cwd, [{ owner: 'acme', repo: 'alpha' }, { owner: 'acme', repo: 'beta' }]);
  const gh = makeGh(github, { 'acme/alpha': 'gated', 'acme/beta': 'gated' });
  const { res, report } = runFleet(cwd, fleet, [], gh);
  assert.strictEqual(res.code, 0, res.stderr);
  assert.strictEqual(report.fleet_gated, true);
  assert.strictEqual(report.summary.gated, 2);
  // the default --out path is asserted for real in test 6b below.
});

test('6b: default --out is specs/reviews/fleet-retrofit.json', () => {
  const github = defaultGithub();
  const cwd = operatorCwd(github);
  const fleet = writeFleet(cwd, [{ owner: 'acme', repo: 'alpha' }]);
  const gh = makeGh(github, { 'acme/alpha': 'gated' });
  capture(() => run(['--fleet', fleet], { cwd, gh, now: () => NOW }));
  assert.ok(fs.existsSync(path.join(cwd, 'specs', 'reviews', 'fleet-retrofit.json')));
});

// ===================== 8b. --apply drives real apply argv ====================

test('8b: --apply issues apply (PUT/POST) then verify per repo', () => {
  const github = defaultGithub();
  const cwd = operatorCwd(github);
  const fleet = writeFleet(cwd, [{ owner: 'acme', repo: 'alpha' }]);
  const calls = [];
  const gh = makeGh(github, { 'acme/alpha': 'gated' }, calls);
  const { res, report } = runFleet(cwd, fleet, ['--apply'], gh);
  assert.strictEqual(res.code, 0, res.stderr);
  assert.strictEqual(report.mode, 'apply');
  assert.ok(calls.some((c) => c.includes('--method PUT') && c.includes('repos/acme/alpha/rulesets')), 'ruleset applied');
  assert.ok(calls.some((c) => c.includes('--method PUT') && c.includes('repos/acme/alpha/environments/production')), 'environment applied');
});

// ===================== CR-001. unconfigured gate is never a false green =======

test('CR-001: branch-protection compliant but NO environments configured => deploy_gate not-configured, not a green', () => {
  const github = { org: 'acme', ruleset_name: 'secure-baseline', required_checks: ['gitleaks', 'sast'], required_approvals: 1, require_code_owner_review: true }; // no environments key
  const cwd = operatorCwd(github);
  const fleet = writeFleet(cwd, [{ owner: 'acme', repo: 'alpha' }]);
  const { res, report } = runFleet(cwd, fleet, [], makeGh(github, { 'acme/alpha': 'gated' }));
  const row = report.repos.find((r) => r.repo === 'acme/alpha');
  assert.strictEqual(row.branch_protection, 'gated');
  assert.strictEqual(row.deploy_gate, 'not-configured', 'an unconfigured deploy gate must not read as gated');
  assert.strictEqual(row.status, 'not-configured');
  assert.strictEqual(report.summary.not_configured, 1);
  assert.strictEqual(report.fleet_gated, false, 'a repo with an unconfigured gate can never make the fleet green');
  assert.strictEqual(res.code, 1);
});

test('CR-001b: NO github section => both gates not-configured, ZERO gh calls, not a green', () => {
  const cwd = tmp('fr-nogh-');
  fs.writeFileSync(path.join(cwd, 'project-manifest.json'), JSON.stringify({}));
  const fleet = writeFleet(cwd, [{ owner: 'acme', repo: 'alpha' }]);
  const calls = [];
  function noGh(args) { calls.push(args.join(' ')); throw new Error('gh must not be called when nothing is configured'); }
  const { res, report } = runFleet(cwd, fleet, [], noGh);
  const row = report.repos.find((r) => r.repo === 'acme/alpha');
  assert.strictEqual(row.branch_protection, 'not-configured');
  assert.strictEqual(row.deploy_gate, 'not-configured');
  assert.strictEqual(report.fleet_gated, false);
  assert.strictEqual(res.code, 1);
  assert.strictEqual(calls.length, 0, 'no gh calls are made for an unconfigured fleet');
});

// ===================== 7. fleet-file validation =============================

test('7a: a missing/unreadable --fleet file => exit 2 before any repo', () => {
  const cwd = operatorCwd(defaultGithub());
  const res = capture(() => run(['--fleet', path.join(cwd, 'nope.json')], { cwd, gh: () => { throw new Error('gh must not run'); }, now: () => NOW }));
  assert.strictEqual(res.code, 2);
});

test('7b: a traversal owner/repo in the fleet is rejected (exit 2) before any gh call', () => {
  const cwd = operatorCwd(defaultGithub());
  const fleet = writeFleet(cwd, [{ owner: '..', repo: 'x/y' }]);
  const res = capture(() => run(['--fleet', fleet], { cwd, gh: () => { throw new Error('gh must not run on a traversal entry'); }, now: () => NOW }));
  assert.strictEqual(res.code, 2);
});

test('7d: a non-array repos in the fleet => exit 2 (malformed config, not silently empty)', () => {
  const cwd = operatorCwd(defaultGithub());
  const file = path.join(cwd, 'fleet.json');
  fs.writeFileSync(file, JSON.stringify({ org: 'acme', repos: 'not-an-array' }));
  const res = capture(() => run(['--fleet', file], { cwd, gh: () => { throw new Error('gh must not run'); }, now: () => NOW }));
  assert.strictEqual(res.code, 2);
});

test('7c: an empty repos[] is not a vacuous green (total 0, exit 1)', () => {
  const cwd = operatorCwd(defaultGithub());
  const fleet = writeFleet(cwd, []);
  const { res, report } = runFleet(cwd, fleet, [], makeGh(defaultGithub(), {}));
  assert.strictEqual(report.summary.total, 0);
  assert.strictEqual(report.fleet_gated, false);
  assert.strictEqual(res.code, 1);
});

// ===================== 9. registration + control budget =====================

test('9: fleet-gate-retrofit is a registered, honest control; budget = 130', () => {
  const { validate } = require(path.join(SCRIPTS, 'validate-harness-manifest'));
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'harness-manifest.json'), 'utf8'));
  const entry = (manifest.sensors || []).find((s) => s.id === 'fleet-gate-retrofit');
  assert.ok(entry, 'fleet-gate-retrofit registered as a sensor');
  assert.strictEqual(entry.scope, 'portfolio');
  assert.strictEqual(entry.wired_at, '.claude/scripts/fleet-retrofit.js');
  assert.ok(entry.net_add_justification && entry.net_add_justification.length > 0, 'has a net_add_justification');
  const { errors } = validate(manifest);
  assert.strictEqual(errors.length, 0, JSON.stringify(errors));
});
