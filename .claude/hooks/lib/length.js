'use strict';

const FILE_HARD_LIMIT = 300;
// Test files get a higher cap. The 300-line source cap exists because a long
// source file concentrates change; a test file is read one case at a time and
// grows table-wise, so that argument is weaker. It is a higher cap, not an
// exemption — the ratchet below still applies, and the FUNCTION cap is
// deliberately unchanged, since a 30-line test case is still a smell.
const TEST_FILE_LIMIT = 500;
const FUNC_HARD_LIMIT = 30;

// Directory segments (exact match, so `src/testing/` and `src/latest/` are not
// caught) and filename shapes that mark a file as a test across the stacks the
// scaffold ships to.
const TEST_DIR_SEGMENTS = new Set(['test', 'tests', '__tests__', 'e2e', 'spec']);
const TEST_FILE_RE = /(\.(test|spec)\.[cm]?[jt]sx?|(^|\/)test_[^/]*\.py|_test\.(py|go)|\.spec\.py)$/;

function isTestPath(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/');
  if (normalized.split('/').some((seg) => TEST_DIR_SEGMENTS.has(seg))) return true;
  return TEST_FILE_RE.test(normalized);
}

function fileLimitFor(filePath) {
  return isTestPath(filePath) ? TEST_FILE_LIMIT : FILE_HARD_LIMIT;
}

function indentLen(line) {
  let count = 0;
  for (const ch of line) {
    if (ch === ' ' || ch === '\t') count++;
    else break;
  }
  return count;
}

const PY_FUNC_RE = /^(\s*)(async\s+)?def\s+(\w+)\s*\(/;
const PY_CLASS_RE = /^(\s*)class\s+\w/;
const NAMED_FUNC_RE = /\bfunction\s+(\w+)\s*[(<]/;
// Arrow functions MUST contain `=>`, otherwise `const x = (a && b)` (a plain
// parenthesised expression) is misread as a function. We track a function only
// once its body brace actually opens (surroundDepth model), so expression-bodied
// arrows and multi-line signatures never over-count.
const ARROW_FUNC_RE = /\bconst\s+(\w+)\s*=\s*(async\s*)?(\([^)]*\)|\w+)\s*=>/;

function netBraces(line) {
  let net = 0;
  for (const ch of line) {
    if (ch === '{') net++;
    else if (ch === '}') net--;
  }
  return net;
}

// Blank out everything that is not executable code — quoted strings, template
// literals, and comments — replacing each with spaces so column positions and line
// count are preserved. Everything downstream (brace depth AND the function-name
// regexes) then sees code only.
//
// Without this the parser reads braces inside literals and prose: a regex such as
// the try-block matcher carries an unmatched opening brace, and a comment holding a
// code example is parsed as a real declaration. Both produce phantom function
// lengths, which is a block the author cannot act on.
//
// Regex literals ARE stripped too (see regexAllowed). Leaving them in was no mere
// residue: a backtick inside one opened a phantom template literal that swallowed the
// file, and an unbalanced brace shifted depth — a phantom length on an innocent function.
function stripNonCode(lines) {
  const state = { inBlockComment: false, inTemplate: false };
  return lines.map((line) => stripLine(line, state));
}

const BLOCK_OPEN = '/*';
const BLOCK_CLOSE = '*/';
const LINE_COMMENT = '//';

// Consume whatever multi-line construct is open; returns the index to resume at,
// or the line length if the construct runs past this line.
function skipOpenConstruct(line, i, state) {
  if (state.inBlockComment) {
    const end = line.indexOf(BLOCK_CLOSE, i);
    if (end === -1) return line.length;
    state.inBlockComment = false;
    return end + BLOCK_CLOSE.length;
  }
  const end = line.indexOf('`', i);
  if (end === -1) return line.length;
  state.inTemplate = false;
  return end + 1;
}

// A `/` starts a regex only in operand position. After an identifier, number,
// `)` or `]` it is division. Getting this wrong in the safe direction (reading a
// regex as division) just restores the old behaviour; the unsafe direction would
// blank real code, so the set is deliberately narrow.
const REGEX_PRECEDERS = new Set(
  ['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '^', '~', '<', '>']
);
const REGEX_KEYWORDS = /\b(return|typeof|instanceof|in|of|case|do|else|yield|await|new|delete|void)$/;

function regexAllowed(emitted) {
  const trimmed = emitted.replace(/\s+$/, '');
  if (trimmed === '') return true;
  if (REGEX_PRECEDERS.has(trimmed[trimmed.length - 1])) return true;
  return REGEX_KEYWORDS.test(trimmed);
}

// Consume a regex literal starting at i. A regex cannot span lines, so an
// unterminated one means this was division after all: return -1 and let the
// caller emit the character normally.
function skipRegex(line, i) {
  let j = i + 1;
  let inClass = false;
  while (j < line.length) {
    const ch = line[j];
    if (ch === '\\') { j += 2; continue; }
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '/' && !inClass) return j + 1;
    j++;
  }
  return -1;
}

// Consume a single-quoted or double-quoted string starting at i (honouring
// backslash escapes); returns the index just past the closing quote.
function skipQuoted(line, i) {
  const quote = line[i];
  let j = i + 1;
  while (j < line.length) {
    if (line[j] === '\\') { j += 2; continue; }
    if (line[j] === quote) return j + 1;
    j++;
  }
  return line.length;
}

function stripLine(line, state) {
  let out = '';
  let i = 0;
  while (i < line.length) {
    if (state.inBlockComment || state.inTemplate) {
      const resume = skipOpenConstruct(line, i, state);
      out += ' '.repeat(resume - i);
      i = resume;
      continue;
    }
    const two = line.slice(i, i + 2);
    if (two === LINE_COMMENT) { out += ' '.repeat(line.length - i); break; }
    if (two === BLOCK_OPEN) { state.inBlockComment = true; out += '  '; i += 2; continue; }
    const ch = line[i];
    if (ch === '/' && regexAllowed(out)) {
      const end = skipRegex(line, i);
      if (end !== -1) { out += ' '.repeat(end - i); i = end; continue; }
    }
    if (ch === '`') { state.inTemplate = true; out += ' '; i += 1; continue; }
    if (ch === '"' || ch === "'") {
      const end = skipQuoted(line, i);
      out += ' '.repeat(end - i);
      i = end;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function flushPython(funcStack, untilIndent, curLine, out, lines) {
  while (funcStack.length > 0 && funcStack[funcStack.length - 1].indent >= untilIndent) {
    const fn = funcStack.pop();
    let end = curLine;
    // Exclude trailing blank lines so a function's measured length is independent
    // of the blank separators that follow it — a last-in-file function and one
    // followed by another then measure the same, which keeps the length-ratchet
    // baseline stable across an append.
    while (end > fn.startLine + 1 && lines[end - 1].trim() === '') end--;
    out.push({ name: fn.name, startLine: fn.startLine, length: end - fn.startLine });
  }
}

function functionsPython(lines) {
  const out = [];
  const funcStack = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(PY_FUNC_RE);
    if (match) {
      const indent = indentLen(lines[i]);
      flushPython(funcStack, indent, i, out, lines);
      funcStack.push({ name: match[3], startLine: i, indent });
    } else if (PY_CLASS_RE.test(lines[i])) {
      // A class at indent I ends any open function at indent >= I (the function
      // is not the class's parent). The class itself is not length-capped —
      // only its methods, which are their own `def` lines. Without this, a
      // module-level function immediately followed by a class is mis-measured
      // as spanning the whole class body to EOF.
      // Heuristic, same string-blindness the `def` scan already has: a
      // `class`-shaped line inside a triple-quoted string or comment reads as a
      // real class, so a function that embeds Python source can be under-counted.
      flushPython(funcStack, indentLen(lines[i]), i, out, lines);
    }
  }
  flushPython(funcStack, 0, lines.length, out, lines);
  return out;
}

// Pop everything the current depth has closed. Two cases, and the second one is
// load-bearing:
//   opened   — a real block-bodied function; record its measured length.
//   !opened  — declared, but it never opened a body deeper than where it was seen,
//              and we are back at that depth. It was not a block-bodied function.
//              The regexes over-match on purpose; an immediately-invoked arrow bound
//              to a const opens and closes its braces on one line, so it is matched
//              but never opens. Discarding it is what stops it poisoning the stack:
//              left in place it blocks every ENCLOSING function from being popped,
//              and those then measure to an arbitrary later brace — which reported a
//              16-line function as 31 purely because of what was appended after it.
function flushBraceStack(funcStack, depth, i, out) {
  while (funcStack.length > 0) {
    const top = funcStack[funcStack.length - 1];
    if (depth > top.surroundDepth) break;
    funcStack.pop();
    if (top.opened) out.push({ name: top.name, startLine: top.startLine, length: i - top.startLine + 1 });
  }
}

function functionsBraceLang(rawLines) {
  const lines = stripNonCode(rawLines);
  const out = [];
  const funcStack = [];
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const named = line.match(NAMED_FUNC_RE);
    const arrow = line.match(ARROW_FUNC_RE);
    const name = (named && named[1]) || (arrow && arrow[1]) || null;
    if (name) funcStack.push({ name, startLine: i, surroundDepth: depth, opened: false });
    depth += netBraces(line);
    for (const fn of funcStack) {
      if (!fn.opened && depth > fn.surroundDepth) fn.opened = true;
    }
    flushBraceStack(funcStack, depth, i, out);
  }
  while (funcStack.length > 0) {
    const fn = funcStack.pop();
    if (fn.opened) out.push({ name: fn.name, startLine: fn.startLine, length: lines.length - fn.startLine });
  }
  return out;
}

// Functions exceeding the hard limit in the given content (block-level only).
function oversizedFunctions(content, ext) {
  const lines = content.split('\n');
  const isPython = ext === '.py';
  const isBraceLang = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext);
  if (!isPython && !isBraceLang) return [];
  const fns = isPython ? functionsPython(lines) : functionsBraceLang(lines);
  return fns.filter((f) => f.length > FUNC_HARD_LIMIT);
}

// Ratchet: the oversized functions in `after` that are NOT grandfathered by
// `before` — a function absent from before's oversized set, or one that grew.
// `before === null` (a brand-new file) grandfathers nothing, so every oversized
// function is returned (no free pass for new code). Same-named functions in one
// file are keyed by name to their max prior length (a rare, deliberately
// permissive edge, disclosed: a grown one may be missed if a larger sibling of
// the same name exists). Mirrors the cycle-gate / coupling-gate ratchets.
function newlyOversized(before, after, ext) {
  const oversizedAfter = oversizedFunctions(after, ext);
  if (oversizedAfter.length === 0) return [];
  const baseline = new Map();
  if (before !== null && before !== undefined) {
    for (const f of oversizedFunctions(before, ext)) {
      const prev = baseline.get(f.name);
      if (prev === undefined || f.length > prev) baseline.set(f.name, f.length);
    }
  }
  return oversizedAfter.filter((f) => {
    const prior = baseline.get(f.name);
    return prior === undefined || f.length > prior;
  });
}

// Ratchet the file-length limit (companion to newlyOversized for functions):
// a file already at/over the limit is grandfathered unless the edit grows it
// further; a new file, or one that newly crosses the limit, is blocked. So an
// unrelated edit to a large legacy file is not held hostage by its size, but
// the debt can never worsen. beforeCount === null means a brand-new file.
function newlyOverFileLimit(beforeCount, afterCount, limit = FILE_HARD_LIMIT) {
  if (afterCount < limit) return false;
  if (beforeCount === null || beforeCount === undefined) return true; // new file over limit
  if (beforeCount < limit) return true; // an edit that newly crosses the limit
  return afterCount > beforeCount; // already over — block only if it grew
}

module.exports = {
  FILE_HARD_LIMIT, TEST_FILE_LIMIT, FUNC_HARD_LIMIT,
  isTestPath, fileLimitFor, oversizedFunctions, newlyOversized, newlyOverFileLimit,
};
