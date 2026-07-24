#!/usr/bin/env node

'use strict';

// PreToolUse(Read|Bash) token optimizer.
// mode=advisory (default): warn + jsonl; never blocks.
// mode=enforced: same predicates → decision=block + exit 2 when a deterministic
// alternative exists. Fail open when graph/ranges are missing.

const fs = require('fs');
const path = require('path');
const { resolveProjectDir, runHook, countLines } = require('./lib/common');
const { verboseCommandWarning } = require('./lib/verbose-command');
const { searchScope } = require('./lib/search-scope');

const RECEIPT_NAME = 'context-pack-last.json';
const DEFAULT_RECEIPT_MAX_AGE_MS = 4 * 60 * 60 * 1000; // 4 hours

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function relPath(projectDir, filePath) {
  const rel = path.relative(projectDir, path.resolve(filePath)).split(path.sep).join('/');
  return rel.startsWith('..') ? filePath.split(path.sep).join('/') : rel;
}

function tokenConfig(projectDir) {
  const manifest = readJson(path.join(projectDir, 'project-manifest.json'), {});
  return {
    enabled: true,
    mode: 'advisory',
    max_source_read_lines: 300,
    compress_tool_output: false,
    context_search_required: false,
    context_pack_receipt_max_age_ms: DEFAULT_RECEIPT_MAX_AGE_MS,
    ...((manifest && manifest.token_governor) || {}),
  };
}

function graphMeta(projectDir) {
  const graph = readJson(path.join(projectDir, 'specs', 'brownfield', 'code-graph.json'), null);
  if (!graph) return { exists: false, real: false, hasRanges: false, graph };
  const empty = (graph.meta && graph.meta.status === 'empty')
    || ((graph.nodes || []).length === 0 && (graph.files || []).length === 0);
  const hasRanges = (graph.files || []).some((f) =>
    (f.symbols || []).some((s) => Number.isFinite(s.start || s.line) && Number.isFinite(s.end || s.start || s.line)));
  return { exists: true, real: !empty, hasRanges, graph };
}

function graphHasRange(projectDir, rel) {
  const { graph } = graphMeta(projectDir);
  if (!graph) return false;
  return (graph.files || []).some((f) =>
    f.path === rel && (f.symbols || []).some((s) => Number.isFinite(s.start || s.line) && Number.isFinite(s.end || s.start || s.line))
  );
}

function appendWarning(projectDir, warning) {
  const stateDir = path.join(projectDir, '.claude', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.appendFileSync(path.join(stateDir, 'token-advisor.jsonl'), `${JSON.stringify({
    ts: new Date().toISOString(),
    ...warning,
  })}\n`);
}

function isSkippableNavPath(rel) {
  const s = String(rel || '');
  return (
    s.startsWith('specs/')
    || s.startsWith('.claude/')
    || s.startsWith('docs/')
    || s.startsWith('node_modules/')
    || s.startsWith('wiki/')
    || /(^|\/)(tests?|__tests__|e2e)(\/|$)/i.test(s)
    || /\.(md|json|yml|yaml|lock)$/i.test(s)
  );
}

function looksLikeSource(rel) {
  const s = String(rel || '');
  if (isSkippableNavPath(s)) return false;
  return (
    /^(src|lib|app|backend|frontend|server|client|packages|services)\//i.test(s)
    || /\.(py|js|jsx|ts|tsx|go|java|cs|rb|rs|php|kt|swift)$/i.test(s)
  );
}

function hasFreshContextPackReceipt(projectDir, maxAgeMs) {
  const receiptPath = path.join(projectDir, '.claude', 'state', RECEIPT_NAME);
  if (!fs.existsSync(receiptPath)) return false;
  try {
    const st = fs.statSync(receiptPath);
    const age = Date.now() - st.mtimeMs;
    if (age > (maxAgeMs || DEFAULT_RECEIPT_MAX_AGE_MS)) return false;
    const receipt = readJson(receiptPath, null);
    if (!receipt) return true; // mtime-only freshness if unreadable JSON
    // Any recent pack run counts — including no_match (agent still used the path)
    return true;
  } catch (_) {
    return false;
  }
}

function broadReadWarning(projectDir, ti, cfg) {
  const filePath = ti.file_path || ti.path || '';
  if (!filePath || typeof filePath !== 'string') return null;
  const abs = path.resolve(filePath);
  const rel = relPath(projectDir, abs);
  // Only guard broad reads of real PRODUCT SOURCE. Reading a test, doc, spec,
  // or config file in full is normal and was never the target — flagging it
  // (as this rule used to) is a false positive that blocks routine work.
  if (!looksLikeSource(rel)) return null;
  let text = '';
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch (_) {
    return null;
  }
  const lines = countLines(text);
  if (lines < (cfg.max_source_read_lines || 300)) return null;
  if (!graphHasRange(projectDir, rel)) return null;
  return {
    kind: 'broad_source_read',
    tool: 'Read',
    path: rel,
    lines,
    message:
      `TOKEN ADVISORY: broad source read of ${rel} (${lines} lines). ` +
      `Use /context "<question>" or specs/brownfield/symbol-map.md to read exact line ranges first.\n`,
  };
}

function contextSearchWarning(projectDir, ti, cfg) {
  if (!cfg.context_search_required) return null;
  const filePath = ti.file_path || ti.path || '';
  if (!filePath || typeof filePath !== 'string') return null;

  const meta = graphMeta(projectDir);
  // Fail open: no graph, placeholder, or no symbol ranges
  if (!meta.real || !meta.hasRanges) return null;

  const abs = path.resolve(filePath);
  const rel = relPath(projectDir, abs);
  if (isSkippableNavPath(rel)) return null;
  if (!looksLikeSource(rel) && !graphHasRange(projectDir, rel)) return null;

  // Slice reads (offset provided) still require a pack once, but are fine after receipt
  if (hasFreshContextPackReceipt(projectDir, cfg.context_pack_receipt_max_age_ms)) return null;

  return {
    kind: 'context_search_skipped',
    tool: 'Read',
    path: rel,
    message:
      `TOKEN ADVISORY: source read of ${rel} without a recent context pack. ` +
      `token_governor.context_search_required is true — run first:\n` +
      `  node .claude/scripts/context-pack.js --diff --budget 1600 "<your question>"\n` +
      `  (or /context "<question>") then Read only the returned line ranges.\n`,
  };
}

/**
 * Repo-wide search when a real graph exists — prefer context-pack.
 *
 * Scoping is decided per search invocation by `searchScope` (a path operand
 * narrows it), NOT by substring-matching the command. A context-pack receipt
 * deliberately does NOT license this: the receipt proves a ritual ran, not
 * that the search was constrained, so honouring it made the gate vacuous.
 */
function unconstrainedSearchWarning(projectDir, command) {
  const trimmed = String(command || '').trim();
  if (!trimmed) return null;
  if (/search-compact\.js|context-pack\.js/.test(trimmed)) return null;

  const { unconstrained, reason } = searchScope(trimmed, projectDir);
  if (!unconstrained) return null;

  const meta = graphMeta(projectDir);
  if (!meta.real || !meta.hasRanges) return null;

  return {
    kind: 'unconstrained_search',
    tool: 'Bash',
    command: trimmed,
    reason,
    message:
      `TOKEN ADVISORY: repo-wide search — ${reason}.\n` +
      `  Prefer: node .claude/scripts/context-pack.js --diff --budget 1600 "<question>"\n` +
      `  Or just scope it to a path (e.g. rg pattern src/auth). Or use search-compact.js.\n`,
  };
}

// Pick the single most-specific warning for this tool call (Read prefers the
// context-search warning over the broad-read one when both apply).
function selectWarning(projectDir, toolName, ti, cfg) {
  if (toolName === 'Read') {
    return contextSearchWarning(projectDir, ti, cfg) || broadReadWarning(projectDir, ti, cfg);
  }
  if (toolName === 'Bash') {
    return unconstrainedSearchWarning(projectDir, ti.command)
      || verboseCommandWarning(ti.command, cfg);
  }
  return null;
}

function emitNavEvent(projectDir, warning) {
  try {
    const { appendNavEvent } = require('../scripts/nav-telemetry');
    appendNavEvent(projectDir, {
      kind: 'token_advisor',
      warning_kind: warning.kind,
      tool: warning.tool,
      path: warning.path || null,
    });
  } catch (_) { /* fail open */ }
}

function decisionFromWarning(warning, cfg) {
  const enforced = cfg.mode === 'enforced' || cfg.mode === 'enforce';
  if (!enforced) return { decision: 'warn', message: warning.message, warning };
  const blockMsg = warning.message
    .replace(/TOKEN ADVISORY:/g, 'TOKEN GOVERNOR (enforced):')
    .replace(/Prefer compact execution:/, 'Blocked — use compact execution:');
  return { decision: 'block', message: blockMsg, warning };
}

function adviseTokenUsage({ projectDir, input }) {
  if (process.env.HARNESS_TOKEN_GOVERNOR === 'off') return { decision: 'ok' };
  const cfg = tokenConfig(projectDir);
  if (!cfg.enabled || cfg.mode === 'off') return { decision: 'ok' };
  const warning = selectWarning(projectDir, input.tool_name || '', input.tool_input || {}, cfg);
  if (!warning) return { decision: 'ok' };
  appendWarning(projectDir, warning);
  emitNavEvent(projectDir, warning);
  return decisionFromWarning(warning, cfg);
}

if (require.main === module) {
  runHook('token-advisor', (input) => {
    const projectDir = resolveProjectDir(path.dirname(path.resolve(__filename)));
    const result = adviseTokenUsage({ projectDir, input });
    if (result.decision === 'block') {
      // Exit-2 feedback MUST go on stderr: Claude Code surfaces a blocking hook's
      // stderr to the model, and reports the bare "hook error: No stderr output"
      // when a hook exits 2 with an empty stderr. Writing the explanation only to
      // stdout (the old behavior) made every enforced block look like a crash.
      process.stderr.write(result.message);
      process.exit(2);
    }
    if (result.decision === 'warn') process.stdout.write(result.message);
  });
}

module.exports = {
  adviseTokenUsage,
  hasFreshContextPackReceipt,
  contextSearchWarning,
  RECEIPT_NAME,
};
