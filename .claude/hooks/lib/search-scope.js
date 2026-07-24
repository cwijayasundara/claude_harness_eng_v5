'use strict';

// Decide whether a shell command contains a genuinely repo-wide search.
//
// The rule is narrow on purpose: a search is "unconstrained" only when an
// invocation has no path operand narrowing it (or one of its operands IS the
// repo root). Everything else is allowed. Ambiguity fails open — a missed sweep
// costs some tokens, a false block teaches the agent to ignore the gate.
//
// Properties that are load-bearing, each of which was a real defect at some point:
//   1. Quote awareness — `rg "auth|login" src/` must not split on the quoted |.
//   2. Per-tool flag tables — `-r` is --replace (value-taking) in ripgrep but
//      plain --recursive in grep; sharing one table let `grep -r secret .`
//      swallow its own pattern and pass as if it read stdin.
//   3. Pipeline position — `git status | rg foo` reads STDIN. Treating a
//      path-less rg as a sweep regardless of position hard-blocks an idiom
//      this repo uses constantly.
//   4. Bundled clusters — `-re` must resolve to `-e` for BOTH the value-consume
//      and the pattern-source lookup, or the value is eaten while the operand
//      is still sliced off as if it were the pattern.

const path = require('path');
const { lex } = require('./shell-lex');

const GREP_FAMILY = new Set(['grep', 'egrep', 'fgrep']);
const RECURSIVE_BY_DEFAULT = new Set(['rg', 'ag', 'ack']);
const SEARCH_TOOLS = new Set([...GREP_FAMILY, ...RECURSIVE_BY_DEFAULT, 'find']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash']);
const WRAPPERS = new Set([
  'sudo', 'command', 'time', 'timeout', 'nice', 'ionice', 'nohup', 'stdbuf', 'xargs', 'env',
]);

// `.*` expands to `.` and `..` plus every dotfile — broader than `.`, not narrower.
const REPO_ROOTS = new Set(['.', '/', '~', '*', '**', '..', '.*']);

const COMMON_VALUE = ['-e', '-f', '-m', '-A', '-B', '-C', '-D', '-d',
  '--regexp', '--file', '--max-count', '--after-context', '--before-context', '--context'];
const GREP_VALUE = new Set([...COMMON_VALUE, '--include', '--exclude', '--exclude-dir',
  '--binary-files', '--devices', '--directories', '--label']);
const RG_VALUE = new Set([...COMMON_VALUE, '-g', '-t', '-T', '-r', '-E', '-M', '--glob',
  '--iglob', '--type', '--type-not', '--replace', '--max-depth', '--sort', '--sortr',
  '--colors', '--engine', '--encoding', '--pre', '--ignore-file', '--max-columns']);
const AG_VALUE = new Set(COMMON_VALUE);

const PATTERN_FLAGS = new Set(['-e', '-f', '--regexp', '--file']);
// `--files` walks the tree but takes no pattern, so every operand is a path.
const NO_PATTERN_FLAGS = new Set(['--files']);
// Output that never touches the filesystem: not a search at all.
const HELP_FLAGS = new Set(['--help', '-h', '--version', '-V', '--type-list', '--list-file-types']);

/** Resolve a bundled short cluster (-re) to its last-letter flag (-e). */
function shortOf(tok) {
  return /^-[A-Za-z]{2,}$/.test(tok) ? `-${tok[tok.length - 1]}` : tok;
}

/** Locate the search tool in a segment, skipping env assignments and wrappers. */
function findTool(tokens) {
  let viaGit = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t) || WRAPPERS.has(t)) continue;
    if (t.startsWith('-') || /^\d+$/.test(t)) continue;
    const base = t.split('/').pop();
    if (base === 'git') { viaGit = true; continue; }
    if (SEARCH_TOOLS.has(base)) return { name: base, rest: tokens.slice(i + 1), viaGit };
    if (SHELLS.has(base)) return { shell: tokens.slice(i + 1).find((x) => !x.startsWith('-')) || '' };
    return null;
  }
  return null;
}

function valueSet(name) {
  if (GREP_FAMILY.has(name)) return GREP_VALUE;
  if (name === 'rg') return RG_VALUE;
  return AG_VALUE;
}

function takesValue(tok, vals) {
  return vals.has(tok) || vals.has(shortOf(tok));
}

function noteFlag(t, seen) {
  const head = t.includes('=') ? t.slice(0, t.indexOf('=')) : t;
  if (HELP_FLAGS.has(head)) seen.help = true;
  if (PATTERN_FLAGS.has(head) || PATTERN_FLAGS.has(shortOf(head))) seen.pattern = true;
  if (NO_PATTERN_FLAGS.has(head)) seen.pattern = true;
  if (head === '--recursive' || (/^-[A-Za-z]+$/.test(t) && /[rR]/.test(t.slice(1)))) {
    seen.recursive = true;
  }
  return head;
}

/** Bare operands, with flags and their values removed. */
function operands(tokens, vals) {
  const args = []; const seen = { pattern: false, recursive: false, help: false };
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t === '--') return { args: args.concat(tokens.slice(i + 1)), seen };
    if (t.startsWith('-') && t.length > 1) {
      noteFlag(t, seen);
      if (!t.includes('=') && takesValue(t, vals)) i += 1;
      continue;
    }
    args.push(t);
  }
  return { args, seen };
}

function isRoot(p, projectDir) {
  const n = p.replace(/\/+$/, '').replace(/^\.\//, '') || '.';
  if (REPO_ROOTS.has(n) || n.startsWith('**')) return true;
  // `..`, `../..`, `../../..` — every segment climbs out, so this is a superset.
  if (n.split('/').every((seg) => seg === '..')) return true;
  if (/^(\$\{?PWD\}?|\$\(pwd\)|`pwd`)$/.test(n)) return true;
  return Boolean(projectDir) && n.startsWith('/') && path.resolve(n) === path.resolve(projectDir);
}

/** One root-ish operand is enough — a second path does not tame `grep -rn x . src/`. */
function anyRoot(paths, projectDir) {
  return paths.some((p) => isRoot(p, projectDir));
}

/**
 * After `cd src`, a relative root means that subdirectory. An absolute path
 * still sweeps — and so does `..`, which climbs straight back out.
 */
function rootsOf(paths, ctx) {
  if (!ctx.scopedCwd) return paths;
  return paths.filter((p) => /^[/~]|^\$/.test(p) || p.includes('..'));
}

/** `find` takes its paths first; leading -H/-L/-P/-D/-O precede them. */
function findScope(rest, ctx) {
  const d = rest.indexOf('-maxdepth');
  if (d !== -1 && Number(rest[d + 1]) <= 2) return null;
  let i = 0;
  while (i < rest.length && /^-(H|L|P|O\d*)$/.test(rest[i])) i += 1;
  if (rest[i] === '-D') i += 2;
  const paths = [];
  for (const t of rest.slice(i)) {
    if (t.startsWith('-') || t === '!' || t === '(') break;
    paths.push(t);
  }
  if (paths.length === 0) return ctx.scopedCwd ? null : 'find with no path operand (defaults to .)';
  return anyRoot(rootsOf(paths, ctx), ctx.projectDir) ? `find rooted at ${paths.join(' ')}` : null;
}

/** A path-less search only sweeps when it actually reads the tree. */
function sweepReason(tool, ctx, recursive) {
  if (ctx.piped || ctx.scopedCwd) return null; // reads stdin, or already inside a subdir
  const sweeps = RECURSIVE_BY_DEFAULT.has(tool.name) || tool.viaGit
    || (GREP_FAMILY.has(tool.name) && recursive);
  return sweeps ? `${tool.name} with no path operand (defaults to the repo root)` : null;
}

function segmentScope(seg, ctx) {
  const tool = findTool(seg.tokens);
  if (!tool) return null;
  if (tool.shell !== undefined) {
    return ctx.depth < 2 ? scopeOf(tool.shell, { ...ctx, depth: ctx.depth + 1 }) : null;
  }
  if (tool.name === 'find') return findScope(tool.rest, ctx);

  const { args, seen } = operands(tool.rest, valueSet(tool.name));
  // `-h` is --no-filename in grep, so it only means "help" with nothing to search.
  if (seen.help && args.length === 0) return null;
  if (args.length === 0 && !seen.pattern) return null; // no pattern: usage, not a search
  const paths = seen.pattern ? args : args.slice(1);
  if (paths.length === 0) return sweepReason(tool, { ...ctx, piped: seg.piped }, seen.recursive);
  // After `cd src`, a relative root means that subdirectory — only an absolute
  // root still reaches the whole repo.
  const roots = rootsOf(paths, ctx);
  return anyRoot(roots, ctx.projectDir) ? `${tool.name} rooted at ${paths.join(' ')}` : null;
}

const GROUPING = new Set(['(', ')', '{', '}']);

/** `cd src && rg pattern` is scoped; `cd /` is not. Subshell grouping is noise. */
function cdTarget(tokens) {
  const t = tokens.filter((x) => !GROUPING.has(x)).map((x) => x.replace(/^[({]+/, ''));
  if (t[0] !== 'cd' && t[0] !== 'pushd') return null;
  return t.length > 1 ? t[1] : '~'; // bare `cd` goes to $HOME, which is not narrowing
}

// A target that climbs out, resolves elsewhere, or cannot be resolved at all is
// not narrowing — trusting it would silently disarm the path-less branch.
function cdScopes(target, projectDir) {
  if (!target || target === '-' || target.includes('..')) return false;
  if (/[$`]/.test(target)) return false; // $HOME, $(git rev-parse …), backticks
  return !isRoot(target, projectDir);
}

function scopeOf(command, ctx) {
  const segs = lex(command);
  if (!segs) return null; // unbalanced quotes — fail open
  let scopedCwd = ctx.scopedCwd || false;
  for (const seg of segs) {
    const cd = cdTarget(seg.tokens);
    if (cd !== null) { scopedCwd = cdScopes(cd, ctx.projectDir); continue; }
    const reason = segmentScope(seg, { ...ctx, scopedCwd });
    if (reason) return reason;
  }
  return null;
}

/**
 * @param {string} command
 * @param {string} [projectDir] repo root, so an absolute path to it reads as a sweep
 * @returns {{unconstrained: boolean, reason: string|null}}
 */
function searchScope(command, projectDir) {
  const reason = scopeOf(String(command || ''), { depth: 0, projectDir });
  return { unconstrained: Boolean(reason), reason };
}

module.exports = { searchScope };
