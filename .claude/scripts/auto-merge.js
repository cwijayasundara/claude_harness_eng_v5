'use strict';

// In-session AUTO_MERGE: wire `gh pr merge --auto` into /build Phase 11. Ported
// from symphony_clone/src/orchestrator/pr.js#enableAutoMerge (which is not copied
// into target projects). Self-gating: a no-op unless --auto-merge / AUTO_MERGE=true.

const path = require('path');
const { execFileSync } = require('child_process');
const { recordAutoMerge } = require('../hooks/lib/merge-provenance');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const VALID_MERGE_METHODS = ['merge', 'squash', 'rebase'];

function isAutoMergeEnabled(flags, env = process.env) {
  const hasFlag = Array.isArray(flags) ? flags.includes('--auto-merge') : Boolean(flags);
  return hasFlag || env.AUTO_MERGE === 'true';
}

function resolveMethod(env = process.env) {
  const method = String(env.MERGE_METHOD || 'merge').trim().toLowerCase();
  if (!VALID_MERGE_METHODS.includes(method)) {
    throw new Error(`MERGE_METHOD must be one of: ${VALID_MERGE_METHODS.join(', ')}`);
  }
  return method;
}

function isRealPrUrl(prUrl) {
  return typeof prUrl === 'string'
    && /^https?:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+\/pull\/\d+(?:[/?#].*)?$/.test(prUrl.trim());
}

function repoSlugFromGitUrl(url) {
  const s = String(url || '').trim().replace(/\.git\/?$/, '');
  const m = s.match(/^[^@\s/]+@([^:/\s]+):(.+)$/)
    || s.match(/^[a-z][\w+.-]*:\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?\/(.+)$/i);
  if (!m) return null;
  const segs = m[2].split('/').filter(Boolean);
  if (segs.length < 2) return null;
  return `${m[1]}/${segs[segs.length - 2]}/${segs[segs.length - 1]}`.toLowerCase();
}

function repoSlugFromPrUrl(prUrl) {
  const m = String(prUrl || '').match(/^https?:\/\/([^/:\s]+)(?::\d+)?\/([^/\s]+)\/([^/\s]+)\/pull\/\d+/);
  return m ? `${m[1]}/${m[2]}/${m[3]}`.toLowerCase() : null;
}

function defaultRunner(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8' });
}

function enableAutoMerge(prUrl, opts = {}) {
  const {
    runner = defaultRunner, expectedSlug = null, method = 'merge',
    projectDir = REPO_ROOT, recordProvenance = recordAutoMerge,
  } = opts;
  if (!isRealPrUrl(prUrl)) return { enabled: false, reason: 'no PR to merge' };
  const prSlug = repoSlugFromPrUrl(prUrl);
  if (expectedSlug && prSlug !== expectedSlug) {
    return { enabled: false, reason: `PR repo ${prSlug || 'unknown'} does not match ${expectedSlug}` };
  }
  try {
    runner('gh', ['pr', 'merge', '--auto', `--${method}`, '--', prUrl]);
    // Emission first: an auto-merge is merged-but-unread → record it as
    // comprehension debt. Best-effort — never let a ledger write undo a merge.
    try { recordProvenance(projectDir, { exec: runner }); } catch (_) { /* ledger is best-effort */ }
    return { enabled: true };
  } catch (error) {
    return { enabled: false, reason: error.message };
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const prUrl = args.find((a) => !a.startsWith('--')) || '';
  if (!isAutoMergeEnabled(args, process.env)) {
    process.stdout.write('auto-merge not enabled (pass --auto-merge or set AUTO_MERGE=true)\n');
    process.exit(0);
  }
  let method = 'merge';
  try { method = resolveMethod(process.env); }
  catch (e) { process.stderr.write(`${e.message}\n`); process.exit(0); }
  let expectedSlug = null;
  try { expectedSlug = repoSlugFromGitUrl(defaultRunner('git', ['remote', 'get-url', 'origin']).trim()); }
  catch (_) { expectedSlug = null; }
  const result = enableAutoMerge(prUrl, { expectedSlug, method });
  process.stdout.write(result.enabled
    ? `auto-merge enabled for ${prUrl} (--${method})\n`
    : `auto-merge not applied: ${result.reason}\n`);
  process.exit(0);
}

module.exports = {
  isAutoMergeEnabled, resolveMethod, enableAutoMerge,
  isRealPrUrl, repoSlugFromGitUrl, repoSlugFromPrUrl,
};
