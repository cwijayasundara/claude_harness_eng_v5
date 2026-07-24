'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  MERGE_PROVENANCE_REL,
  recordMerge,
  readProvenance,
  collectGitStats,
  recordAutoMerge,
} = require('../.claude/hooks/lib/merge-provenance');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'merge-prov-'));
}

test('recordMerge appends a well-shaped row and readProvenance round-trips it', () => {
  const dir = tmp();
  const row = recordMerge(dir, {
    sha: 'abc123', lane: 'auto-merge', event: 'auto_merge_queued', human_reviewed: false, loc_added: 40, files: ['a.js', 'b.js'],
  });
  assert.strictEqual(row.sha, 'abc123');
  assert.strictEqual(row.event, 'auto_merge_queued');
  assert.strictEqual(row.human_reviewed, false);
  assert.strictEqual(row.loc_added, 40);
  assert.deepStrictEqual(row.files, ['a.js', 'b.js']);
  assert.ok(typeof row.ts === 'number');
  const rows = readProvenance(dir);
  assert.strictEqual(rows.length, 1);
  assert.deepStrictEqual(rows[0], row);
});

test('recordMerge coerces missing/odd fields to safe defaults', () => {
  const dir = tmp();
  const row = recordMerge(dir, {});
  assert.strictEqual(row.sha, '');
  assert.strictEqual(row.lane, 'unknown');
  assert.strictEqual(row.event, '');
  assert.strictEqual(row.human_reviewed, false);
  assert.strictEqual(row.loc_added, 0);
  assert.deepStrictEqual(row.files, []);
});

test('recordMerge returns null instead of throwing when the write fails', () => {
  // A path whose parent is a file, not a directory, makes mkdirSync/appendFileSync
  // throw — recordMerge must swallow it and return null (best-effort is intrinsic).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-prov-'));
  fs.writeFileSync(path.join(dir, 'blocker'), 'x');
  const row = recordMerge(path.join(dir, 'blocker'), { sha: 'z', human_reviewed: false });
  assert.strictEqual(row, null);
});

test('readProvenance on a missing ledger returns []', () => {
  assert.deepStrictEqual(readProvenance(tmp()), []);
});

test('recordAutoMerge stamps human_reviewed:false and lane auto-merge', () => {
  const dir = tmp();
  // Injected exec stands in for git — returns HEAD sha then a numstat block.
  const exec = (cmd, args) => {
    if (args[0] === 'rev-parse') return 'deadbeef\n';
    if (args[0] === 'symbolic-ref') return 'refs/remotes/origin/main\n';
    if (args[0] === 'merge-base') return 'basebase\n';
    if (args[0] === 'diff') return '10\t2\tsrc/a.js\n5\t0\tsrc/b.js\n';
    return '';
  };
  const row = recordAutoMerge(dir, { exec });
  assert.strictEqual(row.human_reviewed, false);
  assert.strictEqual(row.lane, 'auto-merge');
  assert.strictEqual(row.event, 'auto_merge_queued');
  assert.strictEqual(row.sha, 'deadbeef');
  assert.strictEqual(row.loc_added, 15);
  assert.deepStrictEqual(row.files, ['src/a.js', 'src/b.js']);
});

test('collectGitStats never throws when git is unavailable', () => {
  const exec = () => { throw new Error('git: not found'); };
  const stats = collectGitStats(exec);
  assert.deepStrictEqual(stats, { sha: '', loc_added: 0, files: [] });
});

test('the ledger rel path is under .claude/state', () => {
  assert.match(MERGE_PROVENANCE_REL, /\.claude[\\/]state[\\/]merge-provenance\.jsonl$/);
});
