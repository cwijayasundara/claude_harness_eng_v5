'use strict';

// A hook that CRASHES must never block work — but it must not look healthy either.
//
// Before this, a throw inside a hook unwound to runHook's catch, appended one line
// to hook-errors.log, and exited 0. Three things went wrong at once:
//   - the sensor ledger got NO row, so the value meter saw ran=0 and classified the
//     inert control as "NEVER FIRED — check wiring or retire". A crashed gate was
//     being recommended for deletion.
//   - timeOutcome recorded a throw as blocked=true, so a crashing control looked
//     like a biting one and its apparent value went UP.
//   - reportFailure resolved the project by walking up from the script, so under a
//     plugin install it logged to the harness repo, not the project being guarded.
//
// The invariant: a crash is recorded as `errored`, is never counted as a block, and
// never disables the checks that follow it.

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const COMMON = path.join(ROOT, '.claude', 'hooks', 'lib', 'common.js');
const { recordOutcome, readOutcomes, timeOutcome } = require('../.claude/hooks/lib/sensor-outcomes');

function tempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-crash-'));
  fs.mkdirSync(path.join(dir, '.claude', 'state'), { recursive: true });
  return dir;
}

test('recordOutcome persists an errored outcome distinctly from a block', () => {
  const dir = tempProject();
  try {
    recordOutcome(dir, { sensor: 'demo', ran: true, blocked: false, errored: true, surface: 'session' });
    const rows = readOutcomes(dir);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].errored, true);
    assert.strictEqual(rows[0].blocked, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('timeOutcome records a throw as errored, NOT as a block', () => {
  const dir = tempProject();
  try {
    assert.throws(() => timeOutcome(dir, { sensor: 'boom', surface: 'commit' }, () => {
      throw new Error('kaboom');
    }));
    const row = readOutcomes(dir)[0];
    assert.strictEqual(row.errored, true, 'a crash must be recorded as errored');
    assert.strictEqual(row.blocked, false, 'a crash is not a block — that inflates apparent value');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('timeOutcome still records a clean run as ran/not-blocked/not-errored', () => {
  const dir = tempProject();
  try {
    assert.strictEqual(timeOutcome(dir, { sensor: 'ok', surface: 'commit' }, () => 42), 42);
    const row = readOutcomes(dir)[0];
    assert.strictEqual(row.ran, true);
    assert.strictEqual(row.blocked, false);
    assert.strictEqual(row.errored, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- end-to-end: a crashing hook, run the way Claude Code runs it -------------

function crashingHook(dir) {
  const file = path.join(dir, 'crasher.js');
  fs.writeFileSync(file, `
    const { runHook } = require(${JSON.stringify(COMMON)});
    runHook('crasher', () => { throw new Error('deliberate test crash'); });
  `);
  return file;
}

function runHookScript(file, dir) {
  return execFileSync(process.execPath, [file], {
    input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'x.js' } }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

test('a crashing hook still exits 0 — a broken gate must never block work', () => {
  const dir = tempProject();
  try {
    assert.doesNotThrow(() => runHookScript(crashingHook(dir), dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a crashing hook records an errored outcome, so it cannot look dormant', () => {
  const dir = tempProject();
  try {
    runHookScript(crashingHook(dir), dir);
    const rows = readOutcomes(dir).filter((r) => r.sensor === 'crasher');
    assert.strictEqual(rows.length, 1, 'the crash must leave a ledger row');
    assert.strictEqual(rows[0].errored, true);
    assert.strictEqual(rows[0].blocked, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a crashing hook logs to the PROJECT being guarded, not the harness repo', () => {
  const dir = tempProject();
  try {
    runHookScript(crashingHook(dir), dir);
    const log = path.join(dir, '.claude', 'state', 'hook-errors.log');
    assert.ok(fs.existsSync(log), 'hook-errors.log must land under CLAUDE_PROJECT_DIR');
    assert.match(fs.readFileSync(log, 'utf8'), /crasher: deliberate test crash/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an EMPTY stdin is not a control outcome — a fixture must not forge an ERRORED row', () => {
  // Every full test run invokes hooks with no event. If that counted as a crash,
  // the ERRORED bucket would never be empty and the operator would learn to ignore
  // it — the same "loud signal that is always on" failure this work exists to fix.
  const dir = tempProject();
  const file = path.join(dir, 'noop.js');
  fs.writeFileSync(file, `
    const { runHook } = require(${JSON.stringify(COMMON)});
    runHook('fixture-run', () => {});
  `);
  try {
    const proc = require('child_process').spawnSync(process.execPath, [file], {
      input: '', env: { ...process.env, CLAUDE_PROJECT_DIR: dir }, encoding: 'utf8',
    });
    assert.strictEqual(proc.status, 0);
    assert.deepStrictEqual(readOutcomes(dir), [], 'no event means no control outcome');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a MALFORMED but non-empty event is a real crash and IS recorded', () => {
  const dir = tempProject();
  const file = path.join(dir, 'noop.js');
  fs.writeFileSync(file, `
    const { runHook } = require(${JSON.stringify(COMMON)});
    runHook('truncated-event', () => {});
  `);
  try {
    require('child_process').spawnSync(process.execPath, [file], {
      input: '{"tool_name":', env: { ...process.env, CLAUDE_PROJECT_DIR: dir }, encoding: 'utf8',
    });
    const rows = readOutcomes(dir).filter((r) => r.sensor === 'truncated-event');
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].errored, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- the value meter must not mistake a crashing control for a quiet one -----

const { tally, classify, render } = require('../.claude/scripts/sensor-value-report');

function classified(outcomes) {
  return classify(tally(outcomes));
}

test('an errored sensor is reported as ERRORED, not as candidate shelfware', () => {
  const c = classified([
    { sensor: 'broken', ran: true, blocked: false, errored: true },
    { sensor: 'broken', ran: true, blocked: false, errored: true },
  ]);
  assert.deepStrictEqual(c.errored, ['broken (2)']);
  assert.ok(!c.neverBlocked.includes('broken'), 'a crashing control cannot be judged shelfware');
  assert.ok(!c.removable.includes('broken'), 'and must never be proposed for removal');
});

test('an errored sensor is not reported as NEVER FIRED', () => {
  // The old ledger recorded nothing on a crash, so ran=0 made the meter say
  // "check wiring or retire" — it recommended deleting the gate that just broke.
  const c = classified([{ sensor: 'broken', ran: true, blocked: false, errored: true }]);
  assert.ok(!c.neverRan.includes('broken'));
});

test('a healthy sensor is unaffected by the errored bucket', () => {
  const c = classified([
    { sensor: 'fine', ran: true, blocked: false },
    { sensor: 'fine', ran: true, blocked: true },
  ]);
  assert.deepStrictEqual(c.errored, []);
  assert.ok(!c.neverBlocked.includes('fine'));
});

test('render surfaces the ERRORED bucket', () => {
  const out = render([{ sensor: 'broken', ran: true, blocked: false, errored: true }], 1);
  assert.match(out, /ERRORED/);
  assert.match(out, /broken/);
});

test('a crashing hook announces itself on stderr rather than dying mute', () => {
  const dir = tempProject();
  const file = crashingHook(dir);
  try {
    const proc = require('child_process').spawnSync(process.execPath, [file], {
      input: JSON.stringify({ tool_name: 'Write' }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
      encoding: 'utf8',
    });
    assert.strictEqual(proc.status, 0);
    assert.match(proc.stderr, /crasher/, 'the crashed hook must name itself');
    assert.match(proc.stderr, /failed open/i, 'and say the control did not run');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
