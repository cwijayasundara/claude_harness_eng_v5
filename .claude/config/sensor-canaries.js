'use strict';

// Canaries for PREVENTIVE gates — the missing half of the value meter.
//
// The bite ledger records when a sensor blocked something. A preventive gate that
// blocks 0 is ambiguous: it may be a working deterrent (nothing bad reached it) or
// shelfware (it is inert). The ledger cannot tell them apart — sensor-value-report
// says so explicitly. A canary resolves it: a known-BAD input the gate must catch,
// paired with a known-GOOD input it must ignore. A gate that bites the bad and stays
// quiet on the good is PROVEN-LIVE; one that misses the bad (or fires on the good) is
// broken. This lets "never blocked" split into proven-live vs still-ambiguous, so a
// quarantine sweep can cut with evidence instead of guessing.
//
// Each entry drives the sensor's REAL detection function (never a reimplementation),
// the same round-trip discipline the harness requires of its contract tests. `sensors`
// lists the ledger names this probe proves (one detector can back several gate wirings).
// The registry starts small and honest: gates without a canary are reported as such,
// not silently assumed live. Add a probe when you want a gate's liveness proven.

const fs = require('fs');
const os = require('os');
const path = require('path');
const LIB = path.join(__dirname, '..', 'hooks', 'lib');

// Some gates are switched OFF in this repo by configuration — the harness scaffold
// is not a layered web app (`architecture.enabled: false`) and ships no
// security-patterns file. Their detectors must still be proven live, because they
// run in every SCAFFOLDED project. Those probes therefore supply their own enabling
// config rather than reading this repo's, so the canary answers "does the detector
// discriminate" and not "is it turned on here". Without this, a config-disabled gate
// is indistinguishable from shelfware in the cut list.
function withTempPatterns(rules, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-'));
  try {
    fs.mkdirSync(path.join(dir, '.claude'));
    fs.writeFileSync(path.join(dir, '.claude', 'security-patterns.json'), JSON.stringify(rules));
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const CANARIES = [
  {
    probe: 'length-caps',
    sensors: ['length-caps'],
    why: 'a 42-line JS function must be flagged; a 3-line one must not',
    run() {
      const L = require(path.join(LIB, 'length'));
      const bad = 'function f() {\n' + Array(40).fill('  doThing();').join('\n') + '\n}\n';
      const good = 'function g() {\n  return 1;\n}\n';
      return { bit: L.oversizedFunctions(bad, '.js').length > 0, quiet: L.oversizedFunctions(good, '.js').length === 0 };
    },
  },
  {
    probe: 'secret-scan',
    sensors: ['secret-scan', 'secret-scan-write'],
    why: 'an AWS access key must be flagged; an env-var reference must not',
    run() {
      const S = require(path.join(LIB, 'secrets'));
      const bad = 'const k = "AKIA' + 'ABCDEFGHIJKLMNOP";';
      const good = 'const k = process.env.AWS_KEY;';
      return { bit: S.scanSecrets(bad).length > 0, quiet: S.scanSecrets(good).length === 0 };
    },
  },
  {
    probe: 'protected-env-file',
    sensors: ['protected-env-file'],
    why: 'a real .env must be protected; .env.example must not',
    run() {
      const S = require(path.join(LIB, 'secrets'));
      return { bit: S.isProtectedEnvFile('.env.production'), quiet: !S.isProtectedEnvFile('.env.example') };
    },
  },
  {
    probe: 'prefix-cache',
    sensors: ['prefix-cache'],
    why: 'a CLAUDE.md write must be caught; a README.md write must not',
    run() {
      const P = require(path.join(LIB, 'prefix-cache'));
      const root = path.join(__dirname, '..', '..');
      // The gate deliberately stands down under the documented escape hatch, so a
      // canary run with it exported would report DEAD for the wrong reason.
      const prev = process.env.HARNESS_PREFIX_EDIT;
      delete process.env.HARNESS_PREFIX_EDIT;
      try {
        return {
          bit: P.prefixCacheViolation(root, path.join(root, 'CLAUDE.md')) !== null,
          quiet: P.prefixCacheViolation(root, path.join(root, 'README.md')) === null,
        };
      } finally {
        if (prev !== undefined) process.env.HARNESS_PREFIX_EDIT = prev;
      }
    },
  },
  {
    probe: 'trust-boundary',
    sensors: ['trust-boundary'],
    why: 'an edit to the harness machinery must be caught; product source must not',
    run() {
      const T = require(path.join(LIB, 'trust-boundary'));
      const root = path.join(__dirname, '..', '..');
      return {
        bit: T.machineryViolation(root, path.join(root, '.claude/hooks/pre-write-gate.js')) !== null,
        quiet: T.machineryViolation(root, path.join(root, 'src/app.js')) === null,
      };
    },
  },
  {
    probe: 'layer-imports',
    sensors: ['layer-imports'],
    why: 'a service importing the api layer must be caught; api importing service must not',
    run() {
      const L = require(path.join(LIB, 'layers'));
      const cfg = { layers: ['types', 'config', 'repository', 'service', 'api', 'ui'], roots: ['src'] };
      return {
        bit: L.checkContentViolations('src/service/x.py', 'from src.api.routes import r\n', cfg).length > 0,
        quiet: L.checkContentViolations('src/api/routes.py', 'from src.service.x import S\n', cfg).length === 0,
      };
    },
  },
  {
    probe: 'security-patterns',
    sensors: ['security-patterns'],
    why: 'a blocking rule must hit its known-bad content and ignore clean content',
    run() {
      const S = require(path.join(LIB, 'security-patterns'));
      // Fixture data only — 'eval(' is inert text matched by a substring rule and by
      // the known-bad sample below. Nothing here executes it.
      const rules = [{ id: 'canary-no-eval', block: true, substrings: ['eval('], message: 'no eval' }];
      return withTempPatterns(rules, (dir) => ({
        bit: S.blockingHits(dir, 'src/a.js', 'eval(userInput);').length > 0,
        quiet: S.blockingHits(dir, 'src/a.js', 'const x = 1;').length === 0,
      }));
    },
  },
  {
    probe: 'stub-smell-gate',
    sensors: ['stub-smell-gate'],
    why: 'a NotImplementedError stub must be caught; a real return must not',
    run() {
      const S = require(path.join(LIB, 'stub-smell'));
      return {
        bit: S.classifyStubSmells('src/svc.py', 'def f():\n    raise NotImplementedError\n').length > 0,
        quiet: S.classifyStubSmells('src/svc.py', 'def f():\n    return 1\n').length === 0,
      };
    },
  },
  {
    probe: 'write-scope',
    sensors: ['write-scope'],
    why: 'a write outside the project must be caught; one inside must not',
    run() {
      const C = require(path.join(LIB, 'common'));
      const root = path.join(__dirname, '..', '..');
      return {
        bit: C.isWriteInScope(root, '/etc/passwd') === false,
        quiet: C.isWriteInScope(root, path.join(root, 'src/app.js')) === true,
      };
    },
  },
  {
    probe: 'bounded-context-rules',
    sensors: ['bounded-context-rules'],
    why: 'a cross-context import of an internal module must be caught; a public one must not',
    run() {
      const X = require(path.join(LIB, 'contexts'));
      // Supplies its own context config for the same reason as layer-imports above:
      // this repo declares no bounded contexts, so the repo config would prove nothing.
      const cfg = {
        roots: ['src/billing', 'src/catalog'],
        names: ['billing', 'catalog'],
        allow: [],
        public: ['index', 'public', '__init__'],
      };
      return {
        bit: X.checkContextContent('src/billing/charge.py', 'from src.catalog.internal import secret\n', cfg).length > 0,
        quiet: X.checkContextContent('src/billing/charge.py', 'from src.catalog.public import api\n', cfg).length === 0,
      };
    },
  },
  {
    probe: 'refactor-purity',
    sensors: ['refactor-purity'],
    why: 'a refactor commit staging a test file must be caught; source-only must not',
    run() {
      // The gate wrapper signals by process exit, so the canary drives the detector it
      // wraps (already exported for exactly this reason) rather than the whole hook.
      const R = require(path.join(__dirname, '..', 'git-hooks', 'lib', 'refactor-purity'));
      return {
        bit: R.findImpureFiles(['src/a.py', 'tests/test_a.py']).length > 0,
        quiet: R.findImpureFiles(['src/a.py', 'src/b.py']).length === 0,
      };
    },
  },
  {
    probe: 'live-externals',
    sensors: ['live-externals'],
    why: 'an integration test reaching a remote URL must be caught; a localhost one must not',
    run() {
      const { classifyFiles } = require(path.join(LIB, 'live-externals-gate'));
      const at = (content) => [{ file: 'tests/integration/test_api.py', content }];
      return {
        bit: classifyFiles(at('resp = httpx.get("https://api.example.com/v1/users")\n')).length > 0,
        quiet: classifyFiles(at('resp = httpx.get("http://localhost:8000/v1/users")\n')).length === 0,
      };
    },
  },
  {
    probe: 'cycle-detection',
    sensors: ['cycle-detection'],
    why: 'a new import cycle above baseline must block; staying at baseline must not',
    run() {
      const C = require(path.join(LIB, 'cycle-gate'));
      return {
        bit: C.gateDecision(['a>b', 'b>a'], 1).blocked === true,
        quiet: C.gateDecision(['a>b'], 1).blocked === false,
      };
    },
  },
];

module.exports = { CANARIES };
