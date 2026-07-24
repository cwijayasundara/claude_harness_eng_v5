'use strict';

// The unconstrained-search predicate shipped with no test coverage, and was
// empirically inverted: it BLOCKED narrow searches (a single named file, a
// path-scoped `tools/`, even `ls | grep` which touches no files) while ALLOWING
// the repo-wide scans it exists to stop, because
//   - the "already scoped" escape was a hardcoded product-dir substring list
//     (`src/`, `backend/`, `packages/`), so a `# src/` COMMENT defeated it;
//   - the `find` branch returned early for the WHOLE command, so appending
//     `; find tools -name x` whitelisted an unrelated repo-wide grep;
//   - it matched `grep` anywhere, including a stdin pipeline;
//   - a 4-hour context-pack receipt bought unlimited unconstrained search.
//
// The rule is now: block only when a search invocation has no path operand
// narrowing it. Fail open on ambiguity — a miss is cheap, a false block trains
// every agent downstream to treat gate output as noise.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');

const { searchScope } = require('../.claude/hooks/lib/search-scope');
const { adviseTokenUsage } = require('../.claude/hooks/token-advisor');

// Narrow or non-filesystem searches. Blocking any of these is a false positive.
const CONSTRAINED = [
  'grep -n foo README.md',
  'grep -n "^| `/" README.md',
  'ls .claude | grep lane',
  'cat notes.txt | grep TODO',
  'grep -rn TODO tools/',
  'grep -rn TODO docs/',
  'grep -rn TODO test/',
  'grep -rl "recordOutcome" .claude/scripts .claude/hooks',
  'grep -rl "recordOutcome" .claude --include=*.js',
  'rg secret src/auth',
  'rg -n pattern packages/core',
  'find tools -name x',
  'find harness-lite -maxdepth 2 -type d',
  'node .claude/scripts/search-compact.js recordOutcome',
  'echo hello',
  // A quoted metacharacter must not split the command and orphan the path.
  'rg "auth|login" src/auth',
  'rg -F "a|b" .claude/hooks',
  'rg "TODO #" .claude/',
  'rg "one;two" src/',
  'grep -n "#define" src/a.c',
  'grep -n "a|b" README.md',
  // Pattern-supplying flags leave every remaining operand a path.
  'grep -e pattern file.txt',
  'grep -f patterns.txt data.txt',
  // Bounded find is cheap, not a sweep.
  'find . -maxdepth 1 -name "*.json"',
  'find . -maxdepth 0',
  'rg pattern ./src',
  // No pattern operand at all: usage, not a search.
  'rg --help',
  'rg --version',
  'rg -h',
  // A redirect alongside a real path operand must not erase the path.
  'rg pattern src/ > out.txt',
  // Escapes and quoting the lexer has to survive.
  'grep -n "a>b" README.md',
  'grep -n "say \\"hi\\"" README.md',
  'grep -rn foo src\\ dir/',
  'grep -rn pattern -- src/',
  'find /etc -name x',
  // Piping INTO a search means it reads stdin, whatever the tool.
  'git status | rg foo',
  'npm run lint 2>&1 | rg FAIL',
  'tail -f log | rg WARN',
  'docker compose logs | rg error',
  'git diff --name-only | xargs grep -rn TODO',
  // A bundled pattern flag consumes its value; the operand is still a path.
  'grep -re pattern src/',
  'rg -ne pattern src/',
  'grep -rf patterns.txt src/',
  'egrep -re pattern tools/',
  // cd scopes the search that follows it.
  'cd src && rg pattern',
  'cd src; rg pattern',
  // Listing modes take no pattern, so the operand is a path.
  'rg --files src/',
  'rg --files -g "*.js" src/',
  // Leading find options precede the path operand.
  'find -L tools -name x',
  'find -H src -name x',
  // A heredoc body is data, not commands.
  "cat > scan.sh <<'EOF'\ngrep -r TODO\nEOF",
  // A here-string feeds stdin, exactly like a pipe.
  'rg pattern <<< "$var"',
  // `-h` is --no-filename in grep; only bare usage means help.
  'rg --help',
  'rg --type-list',
  'rg --list-file-types',
  // After cd, a relative root is that subdirectory.
  'cd src && grep -rn secret .',
  'cd src && rg secret ./',
  'cd src && find . -name x',
  '(cd src && rg pattern)',
  // |& pipes stdout+stderr; still stdin to the search.
  'cat x |& rg secret',
];

// Genuinely repo-wide sweeps: no path operand, or the operand is the repo root.
const UNCONSTRAINED = [
  'grep -rn secret .',
  'grep -rn secret ./',
  'grep -rn foo /',
  'grep -rn secret . # src/',
  'grep -rn secret . ; find tools -name x',
  'find . -name x',
  'find .',
  'rg secret',
  'rg secret --glob "**"',
  'rg -n --type js pattern',
  'git grep secret',
  // grep's -r/-E are valueless: a shared ripgrep flag table swallowed the
  // pattern and made the most canonical sweep of all look like a stdin read.
  'grep -r secret .',
  'grep -R secret .',
  'grep -E secret .',
  // Recursive grep with no path operand searches the cwd.
  'grep -rn secret',
  'grep -r secret',
  'grep --recursive secret',
  // ag/ack are recursive by default, exactly like rg.
  'ag pattern',
  'ack pattern',
  // A redirection target is not a path operand.
  'rg pattern > out.txt',
  'rg pattern 2>/dev/null',
  // A bundled cluster ending in a value-taking flag still consumes its value.
  'rg -nC 3 pattern',
  // Wrappers and shell indirection are not an escape.
  'timeout 5 rg pattern',
  'xargs rg pattern',
  'sh -c "rg pattern"',
  'cd / && grep -rn x .',
  'grep -rn pattern -- .',
  'grep\t-rn\tsecret\t.',
  'rg pattern >out.txt',
  'find . -maxdepth 5 -name x',
  'grep -rn secret \\.',
  // One root operand is enough — a second path does not tame the sweep.
  'grep -rn secret . src/',
  'rg secret . src/',
  // Globs that resolve to the whole tree.
  'rg pattern **/*.js',
  'grep -rn pattern .*',
  // Broader than the repo root, not narrower.
  'rg secret ..',
  'grep -rn secret ../',
  // A listing mode with no path still walks everything.
  'rg --files',
  // A heredoc must not swallow the command that FOLLOWS it.
  "cat > s.sh <<EOF\necho hi\nEOF\ngrep -rn secret .",
  'cat <<< hello && rg secret',
  // grep's -h is --no-filename, not help: an explicit root still sweeps.
  'grep -r -h secret .',
  'rg secret . -h',
  // cd targets that climb out or cannot be resolved are not narrowing.
  'cd src/.. && rg secret',
  'cd src ; cd ../.. ; rg pattern',
  'cd "$(git rev-parse --show-toplevel)" && rg pattern',
  'cd $HOME && rg secret',
  'cd - && rg secret',
  // `..` climbs back out of the subdirectory a cd just entered.
  'cd src && rg secret ..',
  'cd src && find .. -name x',
  'cd src && grep -rn secret ../..',
  'cd src && cd && rg secret',
];

test('searchScope: narrow and non-filesystem searches are not flagged', () => {
  for (const cmd of CONSTRAINED) {
    assert.strictEqual(searchScope(cmd).unconstrained, false, `false positive: ${cmd}`);
  }
});

test('searchScope: repo-wide sweeps are flagged', () => {
  for (const cmd of UNCONSTRAINED) {
    assert.strictEqual(searchScope(cmd).unconstrained, true, `missed sweep: ${cmd}`);
  }
});

test('searchScope: a comment cannot launder a repo-wide sweep', () => {
  assert.strictEqual(searchScope('grep -rn secret . # src/').unconstrained, true);
  assert.strictEqual(searchScope('grep -rn secret .  #  packages/').unconstrained, true);
});

test('searchScope: one bad segment in a chain is enough', () => {
  assert.strictEqual(searchScope('find tools -name x ; grep -rn secret .').unconstrained, true);
  assert.strictEqual(searchScope('grep -rn secret . && echo done').unconstrained, true);
});

test('searchScope: a value-taking flag is not mistaken for a path operand', () => {
  // `**` belongs to --glob; rg is then left with no path operand at all.
  assert.strictEqual(searchScope('rg secret --glob "**"').unconstrained, true);
  // `*.js` belongs to --include; `.claude` is the real path operand.
  assert.strictEqual(searchScope('grep -rl foo .claude --include=*.js').unconstrained, false);
});

test('searchScope: NON-recursive grep with no path reads stdin, not the repo', () => {
  assert.strictEqual(searchScope('grep -i warning').unconstrained, false);
  assert.strictEqual(searchScope('journalctl | grep -i error').unconstrained, false);
});

test('searchScope: grep and ripgrep flag tables are not shared', () => {
  // -r is --replace (value-taking) in rg, but plain --recursive in grep.
  assert.strictEqual(searchScope('grep -r secret .').unconstrained, true);
  assert.strictEqual(searchScope('grep -E secret .').unconstrained, true);
  assert.strictEqual(searchScope('rg -r replacement pattern src/').unconstrained, false);
});

test('searchScope: an unbalanced quote fails open rather than blocking', () => {
  assert.strictEqual(searchScope('rg "unterminated src/').unconstrained, false);
});

// --- end-to-end through the hook, in ENFORCED mode -------------------------

function tempProject(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-search-'));
  fs.mkdirSync(path.join(dir, '.claude', 'state'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'specs', 'brownfield'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'project-manifest.json'), JSON.stringify({
    token_governor: { enabled: true, mode: 'enforced', ...extra },
  }));
  fs.writeFileSync(path.join(dir, 'specs', 'brownfield', 'code-graph.json'), JSON.stringify({
    files: [{ path: 'src/auth.js', symbols: [{ name: 'f', kind: 'function', start: 1, end: 9 }] }],
    nodes: [], edges: [],
  }));
  return dir;
}

function decide(dir, command) {
  return adviseTokenUsage({ projectDir: dir, input: { tool_name: 'Bash', tool_input: { command } } })
    .decision;
}

test('enforced mode does not block narrow searches', () => {
  const dir = tempProject();
  try {
    for (const command of CONSTRAINED) {
      assert.strictEqual(decide(dir, command), 'ok', `wrongly blocked: ${command}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('enforced mode blocks a genuine repo-wide sweep', () => {
  const dir = tempProject();
  try {
    const result = adviseTokenUsage({
      projectDir: dir,
      input: { tool_name: 'Bash', tool_input: { command: 'grep -rn secret .' } },
    });
    assert.strictEqual(result.decision, 'block');
    assert.strictEqual(result.warning.kind, 'unconstrained_search');
    assert.match(result.message, /TOKEN GOVERNOR \(enforced\)/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a stale context-pack receipt no longer licenses unconstrained search', () => {
  const dir = tempProject();
  try {
    fs.writeFileSync(
      path.join(dir, '.claude', 'state', 'context-pack-last.json'),
      JSON.stringify({ ts: new Date().toISOString(), status: 'ok' })
    );
    // The receipt used to buy 4 hours of unlimited repo-wide search.
    assert.strictEqual(decide(dir, 'grep -rn secret .'), 'block');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('search guard fails open when the graph has no symbol ranges', () => {
  const dir = tempProject();
  try {
    fs.writeFileSync(path.join(dir, 'specs', 'brownfield', 'code-graph.json'), JSON.stringify({
      nodes: [], edges: [], files: [], meta: { status: 'empty' },
    }));
    assert.strictEqual(decide(dir, 'grep -rn secret .'), 'ok');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
