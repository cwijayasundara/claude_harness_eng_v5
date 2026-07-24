'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const TRACKED_EXTS = new Set([
  '.py', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.vue', '.svelte', '.go', '.rs', '.java', '.kt', '.rb',
]);

// Auto-generated / vendored paths we don't police
const SKIP_DIRS = new Set(['migrations', 'node_modules', 'dist', 'build', '.next']);

function findProjectDir(startDir) {
  let cur = startDir;
  while (true) {
    if (fs.existsSync(path.join(cur, '.claude'))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

// The project being worked on. CLAUDE_PROJECT_DIR (set by Claude Code for hook
// processes) wins: in plugin mode the hook script lives in the harness repo,
// not the project, so walking up from the script location would resolve the
// wrong directory.
function resolveProjectDir(scriptDir) {
  return (
    process.env.CLAUDE_PROJECT_DIR ||
    findProjectDir(process.cwd()) ||
    findProjectDir(scriptDir) ||
    process.cwd()
  );
}

function readHookInput() {
  // Read fd 0 directly, not the '/dev/stdin' path: re-opening stdin by path
  // fails with ENXIO on Linux when stdin is a spawned pipe (which is how Claude
  // Code — and the tests — feed hook events), making every gate fail open. fd 0
  // reads the already-open descriptor and works for pipes on all platforms.
  //
  // WARNING: this is a BLOCKING read — it waits for EOF on fd 0. When the parent
  // holds the pipe open a moment longer than expected (which happens under load
  // on this checkout: iCloud sync + many concurrent hook spawns), the read can
  // outlast the hook's external timeout and Claude Code kills the process
  // mid-read: non-zero exit, no stderr, and the caller's try/catch never runs so
  // nothing is logged ("hook error: No stderr output"). Entry points should use
  // runHook / readHookInputAsync so a slow pipe degrades to a clean fail-open.
  return JSON.parse(fs.readFileSync(0, 'utf8'));
}

function detachStdin(stdin, timer) {
  clearTimeout(timer);
  stdin.removeAllListeners('data');
  stdin.removeAllListeners('end');
  stdin.removeAllListeners('error');
  try { stdin.pause(); } catch (err) { void err; }
}

// Bounded, non-blocking stdin read for hook entry points. Reads the event JSON
// via the stream (event-driven, so the timer fires even while we wait) and
// rejects instead of hanging if EOF never arrives. The timeout sits well under
// the tightest external hook timeout (5s), so a stalled pipe fails open
// in-process rather than being hard-killed with no stderr and no log entry.
function readHookInputAsync(timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    let data = '';
    const fail = (e) => { detachStdin(stdin, timer); reject(e); };
    const timer = setTimeout(() => fail(new Error('readHookInput: stdin read timed out')), timeoutMs);
    stdin.setEncoding('utf8');
    stdin.on('data', (c) => { data += c; });
    stdin.on('end', () => {
      detachStdin(stdin, timer);
      // No event at all means the hook was not invoked by Claude Code (a fixture,
      // a manual run). That is not a control-health signal, so it is tagged and
      // kept out of the sensor ledger — otherwise every test run would leave the
      // ERRORED bucket non-empty and the operator would learn to ignore it.
      if (data.trim() === '') {
        const empty = new Error('readHookInput: no hook event on stdin');
        empty.code = 'EMPTY_HOOK_INPUT';
        reject(empty);
        return;
      }
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    stdin.on('error', fail);
    stdin.resume();
  });
}

// Uniform hook entry point: read the event (bounded) and run the handler with a
// GUARANTEED fail-open — any read timeout, parse error, or handler throw is
// logged and the process still exits 0, because a broken hook must never block
// the tool it guards. A handler that means to BLOCK calls process.exit(2) itself.
function runHook(hookName, handler) {
  readHookInputAsync()
    .then((input) => Promise.resolve(handler(input)))
    .then(() => process.exit(0))
    .catch((err) => {
      reportFailure(hookName, err);
      process.exit(0);
    });
}

function isSkippedPath(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  if (normalized.endsWith('.d.ts')) return true;
  return normalized.split('/').some((p) => SKIP_DIRS.has(p));
}

function countLines(text) {
  if (!text) return 0;
  const lines = text.split('\n');
  return text.endsWith('\n') ? lines.length - 1 : lines.length;
}

// Resolve symlinks via the deepest existing ancestor (the file itself may not
// exist yet). Without this, macOS /var → /private/var mismatches make
// in-project paths look like they are outside the project.
function realResolve(p) {
  let cur = path.resolve(p);
  let suffix = '';
  while (!fs.existsSync(cur)) {
    suffix = suffix ? path.join(path.basename(cur), suffix) : path.basename(cur);
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  try {
    cur = fs.realpathSync(cur);
  } catch (_) {
    /* keep the resolved path */
  }
  return suffix ? path.join(cur, suffix) : cur;
}

// Claude Code's persistent memory for THIS project lives outside the project
// tree (~/.claude/projects/<munged-path>/memory). The munge mirrors Claude
// Code's: every non [a-zA-Z0-9-] character becomes '-'. If the rule ever drifts
// this fails safe — memory writes get blocked, not other directories opened.
function projectMemoryDir(project) {
  const munged = project.replace(/[^a-zA-Z0-9-]/g, '-');
  return path.join(os.homedir(), '.claude', 'projects', munged, 'memory');
}

// True when a (symlink-resolved) path is a legitimate write location for this
// project: inside the project tree, under /tmp, or in the project's Claude
// memory dir. Shared by the Write/Edit gate and the Bash gate so both honor the
// exact same scope rule.
function isWriteInScope(projectDir, resolvedPath) {
  const tmp = realResolve('/tmp');
  if (resolvedPath === tmp || resolvedPath.startsWith(tmp + path.sep)) return true;
  const project = realResolve(projectDir);
  const memory = projectMemoryDir(project);
  if (resolvedPath === memory || resolvedPath.startsWith(memory + path.sep)) return true;
  return resolvedPath === project || resolvedPath.startsWith(project + path.sep);
}

// A hook crash must never block work, but it must not be invisible either.
//
// Three channels, because a log nobody reads is not observability:
//   1. the sensor ledger, as an `errored` outcome — without this the value meter
//      sees ran=0 and reports the inert control as "NEVER FIRED — check wiring or
//      retire", i.e. it recommends deleting the gate that just broke;
//   2. hook-errors.log, under the PROJECT being guarded (resolveProjectDir honours
//      CLAUDE_PROJECT_DIR — walking up from this file logs to the harness repo
//      instead of the project whenever the harness is installed as a plugin);
//   3. stderr, so the crash is visible in-session instead of only post-hoc.
// `record: false` when the caller writes its own, richer ledger row (a per-check
// crash inside a multi-check gate) — otherwise the crash is counted twice, once
// under a sensor id that does not exist.
function warnToStderr(text) {
  try { process.stderr.write(text); } catch (_) { /* stderr closed */ }
}

function persistFailure(hookName, message, record) {
  try {
    const projectDir = resolveProjectDir(path.dirname(__dirname));
    const logDir = path.join(projectDir, '.claude', 'state');
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(
      path.join(logDir, 'hook-errors.log'),
      `${new Date().toISOString()} ${hookName}: ${message}\n`
    );
    // Required late: sensor-outcomes pulls in no hook modules, so there is no
    // cycle, but keeping it lazy means a telemetry bug cannot break hook startup.
    if (record) {
      require('./sensor-outcomes').recordOutcome(projectDir, {
        sensor: hookName, ran: true, blocked: false, errored: true, surface: 'session',
      });
    }
  } catch (_) {
    /* last resort: stay silent rather than brick the session */
  }
}

// No event on stdin means the hook was never invoked by Claude Code — a fixture or
// a manual run. Nothing crashed and there is no control outcome, so it stays out of
// BOTH the ledger and the log: a signal that fires on every test run is a signal the
// operator stops reading. A genuinely mis-wired hook surfaces as never-ran instead.
function reportFailure(hookName, err, { record = true } = {}) {
  if (err && err.code === 'EMPTY_HOOK_INPUT') {
    warnToStderr(`[hook: ${hookName}] no event on stdin — not invoked by Claude Code\n`);
    return;
  }
  const message = err && err.message ? err.message : String(err);
  persistFailure(hookName, message, record);
  warnToStderr(`[hook: ${hookName}] FAILED OPEN — the control did not run: ${message}\n`);
}

// Load a module that belongs to an optional PACK. Returns null when the pack is not
// installed, so the caller can skip that feature instead of the hook throwing.
//
// A hook runs on every tool call: if it throws because a pack is absent, the session
// breaks. An uninstalled pack is a legitimate configuration, not a failure — the same
// stance gate-registry takes. Only a genuine load error (a syntax error in a module
// that IS present) is re-thrown, so a broken pack never masquerades as a missing one.
function optionalRequire(spec) {
  try {
    return require(spec);
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND' && String(err.message).includes(spec)) return null;
    throw err;
  }
}

module.exports = {
  TRACKED_EXTS, SKIP_DIRS, findProjectDir, resolveProjectDir,
  readHookInput, readHookInputAsync, runHook, isSkippedPath, countLines,
  realResolve, reportFailure, projectMemoryDir, isWriteInScope, optionalRequire,
};
