'use strict';

// Merge-provenance ledger — the cumulative STOCK of merged code and whether a
// human ever read it. Every maintainability sensor measures a per-diff FLOW
// property (this change's cycles, coupling, length…); nothing measured the
// growing pile of merged-but-unread code (Horthy's "dark factory" gap). This
// ledger is the raw material for that STOCK measurement.
//
// EMISSION FIRST: this writer ships and is proven to append BEFORE the
// sensor that reads it exists, so it cannot repeat the sensor-outcomes.jsonl
// trap (a reader wired to a source nothing ever wrote, silent for months).
//
// Single honest emitter: enableAutoMerge() (.claude/scripts/auto-merge.js)
// appends one human_reviewed:false row per auto-merge. `gh pr merge --auto`
// only QUEUES the merge (CI may still reject it) and the sha is the local
// branch tip, not the eventual squash commit — so the row records
// event:'auto_merge_queued', not a claim that the code already landed. A
// queued auto-merge is still "unread code entering main", which is exactly the
// signal the comprehension-debt sensor wants.
//
// Row shape: { sha, ts, lane, event, human_reviewed, loc_added, files }

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const MERGE_PROVENANCE_REL = path.join('.claude', 'state', 'merge-provenance.jsonl');

// Merge-base of HEAD against the default branch. Inlined (not imported from
// impact-scope) so this lib carries no pack dependency of its own. Best-effort;
// returns null when git or the default branch is unavailable.
function resolveBaseRef(exec) {
  try {
    const ref = exec('git', ['symbolic-ref', 'refs/remotes/origin/HEAD']).trim();
    const m = ref.match(/^refs\/remotes\/(.+)$/);
    if (m) return exec('git', ['merge-base', 'HEAD', m[1]]).trim();
  } catch (_) { /* fall through to candidates */ }
  for (const candidate of ['origin/main', 'origin/master']) {
    try {
      exec('git', ['rev-parse', '--verify', candidate]);
      return exec('git', ['merge-base', 'HEAD', candidate]).trim();
    } catch (_) { /* try next */ }
  }
  return null;
}

// Low-level append. Best-effort is intrinsic here, not the caller's job:
// provenance emission hangs off the merge hot path, so the write is wrapped and
// returns null on failure — a missing row degrades to thinner sensor data, never
// a broken merge. Callers may still wrap defensively; this makes the guarantee
// hold even if one forgets.
function recordMerge(projectDir, { sha, lane, event, human_reviewed, loc_added, files } = {}) {
  const file = path.join(projectDir, MERGE_PROVENANCE_REL);
  const row = {
    sha: String(sha || ''),
    ts: Date.now(),
    lane: String(lane || 'unknown'),
    event: String(event || ''),
    human_reviewed: !!human_reviewed,
    loc_added: Number.isFinite(loc_added) ? loc_added : 0,
    files: Array.isArray(files) ? files.map(String) : [],
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(row) + '\n');
  } catch (_) {
    return null;
  }
  return row;
}

function readProvenance(projectDir) {
  try {
    const raw = fs.readFileSync(path.join(projectDir, MERGE_PROVENANCE_REL), 'utf8').trim();
    if (!raw) return [];
    return raw.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch (_) {
    return [];
  }
}

// Best-effort HEAD-vs-merge-base stats. Never throws: an emission point that
// isn't in a git repo (or where git is unavailable) records what it can (an
// empty sha/files row still marks that an unread merge happened).
function collectGitStats(exec) {
  const stats = { sha: '', loc_added: 0, files: [] };
  try { stats.sha = exec('git', ['rev-parse', 'HEAD']).trim(); } catch (_) { /* no sha */ }
  try {
    const base = resolveBaseRef(exec);
    if (base) {
      const out = exec('git', ['diff', '--numstat', base]);
      for (const line of String(out).split('\n')) {
        const m = line.trim().match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
        if (!m) continue;
        stats.loc_added += m[1] === '-' ? 0 : parseInt(m[1], 10);
        stats.files.push(m[3]);
      }
    }
  } catch (_) { /* best-effort stats */ }
  return stats;
}

function boundExec(projectDir) {
  return (cmd, args) => execFileSync(cmd, args, { cwd: projectDir, encoding: 'utf8' });
}

// human_reviewed:false — an auto-merge is merged-but-unread by construction.
// event:'auto_merge_queued' — the merge is queued at enable time, not confirmed
// landed, so the row does not overclaim that the code is already on main.
function recordAutoMerge(projectDir, opts = {}) {
  const exec = opts.exec || boundExec(projectDir);
  const stats = collectGitStats(exec);
  return recordMerge(projectDir, {
    ...stats, lane: opts.lane || 'auto-merge', event: 'auto_merge_queued', human_reviewed: false,
  });
}

module.exports = {
  MERGE_PROVENANCE_REL,
  recordMerge,
  readProvenance,
  collectGitStats,
  recordAutoMerge,
};
