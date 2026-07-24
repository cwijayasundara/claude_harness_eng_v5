#!/usr/bin/env node

'use strict';

// PreToolUse(Write|Edit|MultiEdit) — the single pre-write gate.
// Consolidates scope, env protection, secret scan, custom security patterns,
// file/function length, and the TDD test-first check into one process. Every
// check runs BEFORE anything lands on disk; the first failure blocks (exit 2).
// Secret/pattern scans see only the content this tool call introduces, so
// pre-existing on-disk strings can never block an unrelated edit.
// Escape hatches: HARNESS_TDD_GATE=off, HARNESS_PATTERN_BLOCK=off.

const path = require('path');
const { TRACKED_EXTS, resolveProjectDir, runHook, isSkippedPath, countLines, realResolve, isWriteInScope, optionalRequire, reportFailure } =
  require('./lib/common');
const { finalContent, insertedContent, originalContent } = require('./lib/simulate');
const { scanSecrets, secretScanExempt, isProtectedEnvFile } = require('./lib/secrets');
const { blockingHits } = require('./lib/security-patterns');
const { FUNC_HARD_LIMIT, fileLimitFor, newlyOversized, newlyOverFileLimit } = require('./lib/length');
const { missingTest } = require('./lib/tdd');
const { isHarnessRepo, machineryViolation } = require('./lib/trust-boundary');
const { prefixCacheViolation, prefixCacheBlockMessage } = require('./lib/prefix-cache');
const { recordOutcome } = require('./lib/sensor-outcomes');
// legacy-discipline pack: absent = that discipline is not configured here.
const coveragePreflightMod = optionalRequire(path.join(__dirname, 'lib', 'coverage-preflight.js'));

// Which check is running, so block() can attribute the block to it. block() exits
// the process rather than throwing, so the outcome has to be written on the way out —
// a try/catch around the check would never see it.
let current = { sensor: null, projectDir: null, target: null, started: 0 };

// Run one named check with bite-ledger instrumentation. Every session-cadence check
// records ran/blocked/elapsed, which is what makes the control set subtractable: a
// check that never fires, or fires constantly without catching anything, becomes
// visible rather than assumed useful.
// A check that THROWS is recorded as errored and the gate carries on. Letting the
// throw unwind would take every LATER check in this hook down with it — one broken
// check would silently disable the whole gate, and the ledger would show the
// survivors as never having run.
function runCheck(sensor, projectDir, target, fn) {
  current = { sensor, projectDir, target, started: Date.now() };
  let errored = false;
  try {
    fn();
  } catch (err) {
    errored = true;
    reportFailure(`pre-write-gate:${sensor}`, err, { record: false });
  }
  recordOutcome(projectDir, {
    sensor, ran: true, blocked: false, errored, surface: 'session', target,
    elapsedMs: Date.now() - current.started,
  });
  current = { sensor: null, projectDir: null, target: null, started: 0 };
}

function block(message) {
  if (current.sensor) {
    recordOutcome(current.projectDir, {
      sensor: current.sensor, ran: true, blocked: true, surface: 'session',
      target: current.target, elapsedMs: Date.now() - current.started,
    });
  }
  process.stdout.write(message);
  process.stderr.write(message); // exit-2 feedback channel for Claude Code
  process.exit(2);
}

function checkScope(projectDir, filePath) {
  // Symlinks are resolved on both sides (and on /tmp) inside isWriteInScope —
  // a bare startsWith('/tmp') would treat siblings like /tmpevil as inside and
  // would let /tmp/link -> /etc escape. The same rule guards the Bash gate.
  const resolved = realResolve(filePath);
  if (isWriteInScope(projectDir, resolved)) return;
  block(`BLOCKED: Write outside project directory: ${resolved}\nFix: Move the file to a location within the project directory or use .claude/ for scaffold files.\n`);
}

function checkTrustBoundary(projectDir, filePath) {
  if ((process.env.HARNESS_PROTECT || '').toLowerCase() === 'off') return;
  const rel = machineryViolation(projectDir, filePath);
  if (!rel) return;
  if (isHarnessRepo(projectDir)) return; // harness self-development edits its own hooks
  block(
    `BLOCKED: ${rel} is harness machinery — a quality gate, its wiring, or its state.\n` +
    `Agents may not modify the gates that verify their own work.\n` +
    `Fix: if this change is genuinely intended, a human applies it (HARNESS_PROTECT=off) or it lands in the harness repo and is re-scaffolded.\n`
  );
}

function checkPrefixCache(projectDir, filePath) {
  const rel = prefixCacheViolation(projectDir, filePath);
  if (!rel) return;
  block(prefixCacheBlockMessage(rel));
}

function checkSecrets(filePath, inserted, projectDir) {
  if (secretScanExempt(filePath, projectDir)) return;
  const findings = scanSecrets(inserted);
  if (findings.length === 0) return;
  const lines = [`BLOCKED: Potential secrets detected in ${filePath}:`];
  for (const { label, value } of findings) lines.push(`  - ${label}: ${value}`);
  lines.push('Fix: Move secrets to .env and reference via os.environ.get(). Never hardcode credentials.');
  block(lines.join('\n') + '\n');
}

function checkPatterns(projectDir, file, inserted) {
  if ((process.env.HARNESS_PATTERN_BLOCK || '').toLowerCase() === 'off') return;
  let hits;
  try {
    hits = blockingHits(projectDir, file, inserted);
  } catch (e) {
    // Fail open: a malformed pattern file must not block all edits.
    process.stdout.write(`[pre-write-gate] could not parse security-patterns file (${e.message}); pattern blocking disabled. Use security-patterns.json for reliable parsing.\n`);
    return;
  }
  if (hits.length === 0) return;
  const lines = hits.map((r) =>
    `BLOCKED by security-patterns (${r.rule_name || 'rule'}): ${r.reminder || 'matched a blocking security pattern'}\nFix the flagged pattern, or set block:false to downgrade to an advisory warning.`
  );
  block(lines.join('\n') + '\n');
}

function checkLength(toolName, ti, filePath, ext) {
  if (!TRACKED_EXTS.has(ext) || isSkippedPath(filePath)) return;
  const final = finalContent(toolName, ti, filePath);
  if (final === null) return; // the tool call will fail on its own
  const before = originalContent(filePath);
  const count = countLines(final);
  const beforeCount = before === null ? null : countLines(before);
  // Ratchet BOTH limits: grandfather pre-existing length debt so an unrelated
  // edit to a large legacy file (or one carrying a legacy oversized function) is
  // not held hostage by it; block only a NEW file over the limit, an edit that
  // newly crosses it, or one that GROWS an already-over file/function further.
  const fileLimit = fileLimitFor(filePath);
  if (newlyOverFileLimit(beforeCount, count, fileLimit)) {
    block(`BLOCKED: ${toolName} on ${filePath} would produce ${count} lines (hard limit ${fileLimit}).\nFix: Split the file into modules by responsibility BEFORE writing. One file, one responsibility (SRP).\n`);
  }
  for (const f of newlyOversized(before, final, ext)) {
    block(`BLOCKED: Function ${f.name} in ${filePath}:${f.startLine + 1} would be ${f.length} lines (limit ${FUNC_HARD_LIMIT}).\nFix: Decompose into named sub-functions. Each should be testable in isolation.\n`);
  }
}

function checkTdd(projectDir, filePath) {
  if ((process.env.HARNESS_TDD_GATE || '').toLowerCase() === 'off') return;
  const missing = missingTest(projectDir, filePath.replace(/\\/g, '/'));
  if (!missing) return;
  const shown = missing.slice(0, 4).map((p) => '  - ' + path.relative(projectDir, p)).join('\n');
  block(
    `BLOCKED: test-first gate — no test found for ${filePath}.\n` +
      `Write the failing test FIRST (TDD red), then implement. Looked for e.g.:\n${shown}\n` +
      `(Enforces test existence; pair with tdd-guard for red-green ordering. Bypass for legacy: HARNESS_TDD_GATE=off.)\n`
  );
}

runHook('pre-write-gate', (input) => {
  const toolName = input.tool_name || '';
  const ti = input.tool_input || {};
  const filePath = ti.file_path || '';
  if (typeof filePath !== 'string' || !filePath) process.exit(0);

  const projectDir = resolveProjectDir(path.dirname(path.resolve(__filename)));
  const ext = path.extname(filePath).toLowerCase();
  const inserted = insertedContent(toolName, ti);

  const rel = path.relative(projectDir, path.resolve(filePath));
  runCheck('write-scope', projectDir, rel, () => checkScope(projectDir, path.resolve(filePath)));
  runCheck('trust-boundary', projectDir, rel, () => checkTrustBoundary(realResolve(projectDir), realResolve(filePath)));
  runCheck('prefix-cache', projectDir, rel, () => checkPrefixCache(realResolve(projectDir), realResolve(filePath)));
  runCheck('protected-env-file', projectDir, rel, () => {
    if (isProtectedEnvFile(filePath)) {
      block(`BLOCKED: Cannot modify ${path.basename(filePath)} — environment files contain real secrets. Edit manually.\nFix: Edit .env.example instead for documentation, or edit .env manually outside Claude.\n`);
    }
  });
  if (inserted) {
    runCheck('secret-scan-write', projectDir, rel, () => checkSecrets(filePath, inserted, projectDir));
    runCheck('security-patterns', projectDir, rel, () => checkPatterns(projectDir, filePath.replace(/\\/g, '/'), inserted));
  }
  runCheck('length-caps', projectDir, rel, () => checkLength(toolName, ti, filePath, ext));
  runCheck('tdd-test-first', projectDir, rel, () => checkTdd(projectDir, filePath));
  if (coveragePreflightMod && TRACKED_EXTS.has(ext) && !isSkippedPath(filePath)) {
    runCheck('coverage-preflight', projectDir, rel, () => {
      const pf = coveragePreflightMod.coveragePreflight(projectDir, toolName, ti, path.resolve(filePath));
      if (pf.decision === 'block') block(pf.message);
      if (pf.decision === 'note') process.stdout.write(pf.message);
    });
  }
});
