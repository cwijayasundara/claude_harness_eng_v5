'use strict';

// stripNonCode blanks strings, template literals and comments before counting
// braces, but NOT regex literals — a documented residue that turned out to be a
// live, unactionable block. A regex containing a backtick opened a phantom
// template-literal state and swallowed the rest of the file; a regex containing
// an unbalanced brace shifted every subsequent depth reading. The author sees
// "Function X would be 31 lines" for a five-line function and has nothing to act
// on: the reported function is not the one at fault.
//
// Reproducer from the field: `if (target.includes('$') || /[$`]/.test(target))`.

const assert = require('assert');
const { test } = require('node:test');

const { oversizedFunctions } = require('../.claude/hooks/lib/length');

const short = (name, body) => `function ${name}() {\n${body}\n}\n`;

// The corruption is a state leak ACROSS lines: a stray backtick opens a phantom
// template literal, an unbalanced brace shifts depth, and everything after is
// mis-attributed. It only surfaces as a block once the swallowed span passes the
// 30-line cap — which is why it reads as a phantom length on an innocent function.
const TAIL = Array.from({ length: 40 }, (_, i) => short(`t${i}`, `  return ${i};`)).join('');

test('a regex containing a backtick does not corrupt the brace scan', () => {
  const src = short('hasShell', "  return /[$`]/.test(x);") + TAIL;
  assert.deepStrictEqual(oversizedFunctions(src, '.js'), []);
});

test('a regex containing an unbalanced brace does not shift depth', () => {
  const src = short('grouping', "  return /^[({]+/.test(x);") + TAIL;
  assert.deepStrictEqual(oversizedFunctions(src, '.js'), []);
});

test('a regex containing a quote does not open a phantom string', () => {
  const src = short('quoted', `  return /['"]/.test(x);`) + TAIL;
  assert.deepStrictEqual(oversizedFunctions(src, '.js'), []);
});

test('a regex containing // does not read as a line comment', () => {
  const src = short('proto', '  return /https?:\\/\\//.test(x);') + TAIL;
  assert.deepStrictEqual(oversizedFunctions(src, '.js'), []);
});

test('division is not mistaken for a regex literal', () => {
  // If `a / b ... / c` were treated as a regex, the code between would be blanked
  // and a real oversized function could slip through unmeasured.
  const body = Array.from({ length: 34 }, (_, i) => `  const v${i} = total / count;`).join('\n');
  const fns = oversizedFunctions(short('ratios', body), '.js');
  assert.strictEqual(fns.length, 1, 'a genuinely oversized function must still be caught');
  assert.strictEqual(fns[0].name, 'ratios');
});

test('an oversized function is still measured when it contains a regex', () => {
  const body = [`  const re = /[$\`{]/;`]
    .concat(Array.from({ length: 33 }, (_, i) => `  const v${i} = ${i};`)).join('\n');
  const fns = oversizedFunctions(short('big', body), '.js');
  assert.strictEqual(fns.length, 1);
  assert.strictEqual(fns[0].name, 'big');
});

test('the real-world reproducer measures at its true length', () => {
  const src = [
    'function cdScopes(target, projectDir) {',
    "  if (!target || target === '-' || target.includes('..')) return false;",
    "  if (/[$`]/.test(target)) return false;",
    '  return !isRoot(target, projectDir);',
    '}',
    '',
  ].join('\n') + TAIL;
  assert.deepStrictEqual(oversizedFunctions(src, '.js'), []);
});
