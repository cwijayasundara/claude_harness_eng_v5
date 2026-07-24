'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildReport, scoreRow, renderText } = require('../.claude/scripts/sensor-comprehension-debt');
const { recordMerge } = require('../.claude/hooks/lib/merge-provenance');

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comp-debt-'));
  fs.mkdirSync(path.join(dir, 'specs', 'brownfield'), { recursive: true });
  return dir;
}

// A graph where lib/util.js is depended on (imported) by two other files, so
// editing it has a blast radius of 2.
function writeGraph(dir) {
  const graph = {
    nodes: [
      { id: 'u', path: 'lib/util.js' },
      { id: 'a', path: 'lib/a.js' },
      { id: 'b', path: 'lib/b.js' },
    ],
    edges: [
      { kind: 'imports', source: 'a', target: 'u' },
      { kind: 'imports', source: 'b', target: 'u' },
    ],
  };
  fs.writeFileSync(path.join(dir, 'specs', 'brownfield', 'code-graph.json'), JSON.stringify(graph));
}

test('keeps only human_reviewed:false rows', () => {
  const dir = tmp();
  recordMerge(dir, { sha: 'x1', lane: 'auto-merge', human_reviewed: false, loc_added: 10, files: ['lib/a.js'] });
  recordMerge(dir, { sha: 'x2', lane: 'gate', human_reviewed: true, loc_added: 99, files: ['lib/b.js'] });
  const report = buildReport(dir);
  assert.strictEqual(report.unread_merges, 1);
  assert.strictEqual(report.ranked[0].sha, 'x1');
});

test('blast radius amplifies the score of an unread merge to a hub file', () => {
  const dir = tmp();
  writeGraph(dir);
  // util.js has 2 dependents -> score = loc(10) * (1 + 2) = 30
  recordMerge(dir, { sha: 'hub', lane: 'auto-merge', human_reviewed: false, loc_added: 10, files: ['lib/util.js'] });
  // a leaf with no dependents -> score = loc(10) * (1 + 0) = 10
  recordMerge(dir, { sha: 'leaf', lane: 'auto-merge', human_reviewed: false, loc_added: 10, files: ['lib/a.js'] });
  const report = buildReport(dir);
  assert.strictEqual(report.ranked[0].sha, 'hub');
  assert.strictEqual(report.ranked[0].score, 30);
  assert.strictEqual(report.ranked[0].blast_reach, 2);
  assert.strictEqual(report.total_score, 40);
});

test('a security-boundary file doubles the debt score', () => {
  const dir = tmp();
  const secure = scoreRow({ loc_added: 10, files: ['src/auth/login.js'], human_reviewed: false }, null);
  const plain = scoreRow({ loc_added: 10, files: ['src/widget.js'], human_reviewed: false }, null);
  assert.strictEqual(secure.security_boundary, true);
  assert.strictEqual(plain.security_boundary, false);
  assert.strictEqual(secure.score, plain.score * 2);
});

test('loc falls back to file count then 1 so a thin row still registers', () => {
  const zero = scoreRow({ loc_added: 0, files: ['a.js', 'b.js'], human_reviewed: false }, null);
  assert.strictEqual(zero.loc_added, 2);
  const empty = scoreRow({ loc_added: 0, files: [], human_reviewed: false }, null);
  assert.strictEqual(empty.loc_added, 1);
});

test('empty ledger yields zero debt and a loud note, never a throw', () => {
  const report = buildReport(tmp());
  assert.strictEqual(report.unread_merges, 0);
  assert.strictEqual(report.total_score, 0);
  assert.ok(report.notes.some((n) => /no human_reviewed:false rows/.test(n)));
});

test('missing code-graph notes degraded blast reach', () => {
  const dir = tmp();
  recordMerge(dir, { sha: 'x', lane: 'auto-merge', human_reviewed: false, loc_added: 5, files: ['lib/a.js'] });
  const report = buildReport(dir);
  assert.ok(report.notes.some((n) => /no code-graph/.test(n)));
  assert.strictEqual(report.ranked[0].blast_reach, 0);
});

test('renderText is stable and marks security rows', () => {
  const report = buildReport(tmp());
  const text = renderText(report);
  assert.match(text, /sensor-comprehension-debt: 0 unread merge/);
});
