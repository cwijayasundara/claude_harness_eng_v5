'use strict';

// Quote-aware shell lexer: splits a command line into independently-executed
// segments of tokens. Knows nothing about searching — see search-scope.js for
// what the segments then mean.
//
// It exists because substring-matching a command string is not good enough to
// make a blocking decision. A quoted `|` inside a pattern (`rg "auth|login"`)
// must not split the command, a `#` inside quotes is not a comment, a heredoc
// body is data rather than commands, and `||`/`&&` are separators while a bare
// `|` genuinely feeds stdin to what follows.

const META = new Set(['|', ';', '&', '\n']);

/** Skip a redirection operator and its target. */
function skipRedirect(s, start) {
  let i = start;
  while (i < s.length && (s[i] === '>' || s[i] === '<' || s[i] === '&')) i += 1;
  while (i < s.length && /\s/.test(s[i])) i += 1;
  while (i < s.length && !/\s/.test(s[i]) && !META.has(s[i])) i += 1;
  return i - 1;
}

/** Skip a heredoc body up to and including its terminator line. */
function skipHeredoc(s, start) {
  let i = start;
  while (i < s.length && (s[i] === '<' || s[i] === '-')) i += 1;
  while (i < s.length && /\s/.test(s[i])) i += 1;
  let delim = '';
  while (i < s.length && !/\s/.test(s[i])) { delim += s[i]; i += 1; }
  delim = delim.replace(/['"]/g, '');
  if (!delim) return i - 1;
  const lines = s.slice(i).split('\n');
  let used = 0;
  for (let k = 0; k < lines.length; k += 1) {
    used += lines[k].length + 1;
    if (k > 0 && lines[k].trim() === delim) break;
  }
  return Math.min(i + used - 1, s.length);
}

function endTok(st) {
  if (st.cur !== '' || st.quoted) st.toks.push(st.cur);
  st.cur = ''; st.quoted = false;
}

function endSeg(st, nextPiped) {
  endTok(st);
  // Only advance the pipe state when a segment actually closed, so `|&` and
  // `| # comment` still mark the NEXT segment as stdin-fed.
  if (!st.toks.length) return;
  st.segs.push({ tokens: st.toks, piped: st.piped || st.stdin });
  st.toks = []; st.piped = nextPiped; st.stdin = false;
}

/** Handle `<`, `<<`, `<<<` and `>` forms. Returns the resume index, or null. */
function stepRedirect(s, i, st) {
  const c = s[i];
  if (c !== '<' && c !== '>') return null;
  // `<<<` is a here-string (a single word), not a heredoc — no terminator line.
  if (c === '<' && s[i + 1] === '<' && s[i + 2] !== '<') {
    st.stdin = true; // the heredoc body IS this command's stdin
    endSeg(st, false); // ...and what follows the terminator is a new command
    return skipHeredoc(s, i);
  }
  if (c === '<') st.stdin = true; // any input redirection feeds stdin
  if (/^\d*$/.test(st.cur)) st.cur = '';
  endTok(st);
  return skipRedirect(s, i);
}

/** Consume one character. Returns the index to continue from. */
function step(s, i, st) {
  const c = s[i];
  if (st.q === '"' && c === '\\') { st.cur += s[i + 1] || ''; return i + 1; }
  if (st.q) { if (c === st.q) st.q = null; else st.cur += c; return i; }
  if (c === '\\') { st.cur += s[i + 1] || ''; return i + 1; }
  if (c === '"' || c === "'") { st.q = c; st.quoted = true; return i; }
  if (c === '#' && st.cur === '') {
    const nl = s.indexOf('\n', i);
    endSeg(st, false);
    return nl === -1 ? s.length : nl;
  }
  const redirected = stepRedirect(s, i, st);
  if (redirected !== null) return redirected;
  if (META.has(c)) {
    const doubled = s[i + 1] === c; // || and && are separators, not pipes
    endSeg(st, c === '|' && !doubled);
    return doubled ? i + 1 : i;
  }
  if (/\s/.test(c)) { endTok(st); return i; }
  st.cur += c;
  return i;
}

/**
 * @param {string} command
 * @returns {{tokens: string[], piped: boolean}[]|null} segments, or null on
 *   unbalanced quotes so the caller can fail open rather than guess.
 */
function lex(command) {
  const s = String(command || '');
  const st = { segs: [], toks: [], cur: '', quoted: false, q: null, piped: false, stdin: false };
  for (let i = 0; i < s.length; i += 1) i = step(s, i, st);
  endSeg(st, false);
  return st.q ? null : st.segs;
}

module.exports = { lex };
