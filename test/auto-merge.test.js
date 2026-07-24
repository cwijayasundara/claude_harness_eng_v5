'use strict';

const assert = require('assert');
const { test } = require('node:test');

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  isAutoMergeEnabled, resolveMethod, enableAutoMerge,
  isRealPrUrl, repoSlugFromGitUrl, repoSlugFromPrUrl,
} = require('../.claude/scripts/auto-merge.js');
const { readProvenance } = require('../.claude/hooks/lib/merge-provenance.js');

test('isAutoMergeEnabled: flag, env, neither, both', () => {
  assert.strictEqual(isAutoMergeEnabled(['--auto-merge'], {}), true);
  assert.strictEqual(isAutoMergeEnabled([], { AUTO_MERGE: 'true' }), true);
  assert.strictEqual(isAutoMergeEnabled(['--auto-merge'], { AUTO_MERGE: 'true' }), true);
  assert.strictEqual(isAutoMergeEnabled([], {}), false);
  assert.strictEqual(isAutoMergeEnabled([], { AUTO_MERGE: 'false' }), false);
});

test('resolveMethod: default merge, valid values, invalid throws', () => {
  assert.strictEqual(resolveMethod({}), 'merge');
  assert.strictEqual(resolveMethod({ MERGE_METHOD: 'squash' }), 'squash');
  assert.strictEqual(resolveMethod({ MERGE_METHOD: 'REBASE' }), 'rebase');
  assert.throws(() => resolveMethod({ MERGE_METHOD: 'fast-forward' }), /merge, squash, rebase/);
});

test('repo slug helpers (scp + https)', () => {
  assert.strictEqual(repoSlugFromGitUrl('git@github.com:Owner/Repo.git'), 'github.com/owner/repo');
  assert.strictEqual(repoSlugFromGitUrl('https://github.com/Owner/Repo'), 'github.com/owner/repo');
  assert.strictEqual(repoSlugFromPrUrl('https://github.com/owner/repo/pull/7'), 'github.com/owner/repo');
});

test('enableAutoMerge: non-PR url is not enabled and makes no gh call', () => {
  const calls = [];
  const r = enableAutoMerge('not-a-pr', { runner: (c, a) => { calls.push(a); } });
  assert.strictEqual(r.enabled, false);
  assert.strictEqual(calls.length, 0);
});

test('enableAutoMerge: slug mismatch refuses, no gh call', () => {
  const calls = [];
  const r = enableAutoMerge('https://github.com/owner/other/pull/3', {
    runner: (c, a) => { calls.push(a); }, expectedSlug: 'github.com/owner/repo',
  });
  assert.strictEqual(r.enabled, false);
  assert.match(r.reason, /does not match/);
  assert.strictEqual(calls.length, 0);
});

test('enableAutoMerge: happy path calls gh pr merge --auto --<method>', () => {
  const calls = [];
  // recordProvenance is stubbed so the happy path does not write into the real
  // repo's state and stays a pure gh-call assertion.
  const r = enableAutoMerge('https://github.com/owner/repo/pull/9', {
    runner: (c, a) => { calls.push([c, a]); return ''; },
    expectedSlug: 'github.com/owner/repo', method: 'squash',
    recordProvenance: () => {},
  });
  assert.strictEqual(r.enabled, true);
  assert.deepStrictEqual(calls[0], ['gh', ['pr', 'merge', '--auto', '--squash', '--', 'https://github.com/owner/repo/pull/9']]);
});

test('enableAutoMerge: writes a REAL human_reviewed:false / auto_merge_queued row', () => {
  // Round-trip the real ledger (no recorder stub): the runner returns '' for
  // both the gh call and the best-effort git stats, so the row lands with empty
  // stats but the honest event + review flag we care about.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-prov-'));
  const r = enableAutoMerge('https://github.com/owner/repo/pull/9', {
    runner: () => '',
    expectedSlug: 'github.com/owner/repo',
    projectDir: dir,
  });
  assert.strictEqual(r.enabled, true);
  const rows = readProvenance(dir);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].human_reviewed, false);
  assert.strictEqual(rows[0].event, 'auto_merge_queued');
  assert.strictEqual(rows[0].lane, 'auto-merge');
});

test('enableAutoMerge: a provenance write failure does not undo the merge', () => {
  const r = enableAutoMerge('https://github.com/owner/repo/pull/9', {
    runner: () => '',
    expectedSlug: 'github.com/owner/repo',
    recordProvenance: () => { throw new Error('disk full'); },
  });
  assert.strictEqual(r.enabled, true);
});

test('enableAutoMerge: runner error falls back to not-enabled (no throw)', () => {
  const r = enableAutoMerge('https://github.com/owner/repo/pull/9', {
    runner: () => { throw new Error('auto-merge not allowed on this repo'); },
    expectedSlug: 'github.com/owner/repo',
  });
  assert.strictEqual(r.enabled, false);
  assert.match(r.reason, /not allowed/);
});

test('isRealPrUrl recognizes canonical PR URLs only', () => {
  assert.strictEqual(isRealPrUrl('https://github.com/owner/repo/pull/7'), true);
  assert.strictEqual(isRealPrUrl('https://github.com/owner/repo'), false);
  assert.strictEqual(isRealPrUrl('not-a-url'), false);
});

test('enableAutoMerge refuses an unparseable PR slug when expectedSlug is set (no gh call)', () => {
  const calls = [];
  const r = enableAutoMerge('https://h:x/o/r/pull/1', { runner: (c, a) => { calls.push(a); }, expectedSlug: 'h/o/r' });
  assert.strictEqual(r.enabled, false);
  assert.strictEqual(calls.length, 0);
});
