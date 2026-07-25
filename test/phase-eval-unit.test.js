const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('node:test');
const { readSkillCorpus } = require('./helpers/skill-corpus');

const ROOT = path.join(__dirname, '..');

// ── 1. Rubrics validation ───────────────────────────────────────────────────

const rubrics = JSON.parse(
  fs.readFileSync(path.join(ROOT, '.claude', 'templates', 'phase-eval-rubrics.json'), 'utf8')
);

test('phase-eval-rubrics.json is valid JSON', () => {
  assert.ok(rubrics, 'rubrics parsed without error');
  assert.strictEqual(typeof rubrics, 'object');
});

test('rubrics contains the 8 planning phases (incl. the test phase)', () => {
  const phases = Object.keys(rubrics.phases);
  assert.deepStrictEqual(phases.sort(), ['brd', 'brownfield', 'deploy', 'design', 'design-delta', 'seam', 'spec', 'test']);
});

test('each phase has exactly 5 criteria', () => {
  const expectedCriteria = ['actionability', 'completeness', 'consistency', 'specificity', 'traceability'];
  for (const [phase, config] of Object.entries(rubrics.phases)) {
    const criteria = Object.keys(config.criteria).sort();
    assert.deepStrictEqual(criteria, expectedCriteria, `phase "${phase}" has wrong criteria`);
  }
});

test('global threshold is 7.0 and per_criterion_minimum is 5', () => {
  assert.strictEqual(rubrics.threshold, 7.0);
  assert.strictEqual(rubrics.per_criterion_minimum, 5);
});

// ── 2. Result schema validation ─────────────────────────────────────────────

const resultSchema = JSON.parse(
  fs.readFileSync(path.join(ROOT, '.claude', 'templates', 'phase-eval-result.schema.json'), 'utf8')
);

test('phase-eval-result.schema.json is valid JSON', () => {
  assert.ok(resultSchema, 'schema parsed without error');
  assert.strictEqual(typeof resultSchema, 'object');
});

test('result schema has required fields', () => {
  const required = resultSchema.required;
  const expectedRequired = [
    'phase', 'iteration', 'timestamp', 'scores', 'weighted_average',
    'threshold', 'per_criterion_minimum', 'verdict', 'failing_criteria',
    'findings', 'traceability_report', 'score_history',
  ];
  for (const field of expectedRequired) {
    assert.ok(required.includes(field), `missing required field: ${field}`);
  }
});

test('phase enum matches the rubric phases (incl. test)', () => {
  const phaseEnum = resultSchema.properties.phase.enum;
  // Must stay in lockstep with phase-eval-rubrics.json — a rubric phase the
  // schema forbids makes that phase's evaluator output fail validation.
  assert.deepStrictEqual(phaseEnum.sort(), Object.keys(rubrics.phases).sort());
});

// ── 3. Evaluator agent — artifact mode (merged from phase-evaluator) ─────────

const agentPath = path.join(ROOT, '.claude', 'agents', 'evaluator.md');
const agentContent = fs.readFileSync(agentPath, 'utf8');

test('evaluator.md exists and is non-empty', () => {
  assert.ok(fs.existsSync(agentPath));
  assert.ok(agentContent.length > 0, 'agent file is empty');
});

test('evaluator.md is pinned to Opus 5 (exact id)', () => {
  assert.match(agentContent, /^---\n[\s\S]*?model:\s*claude-opus-5[\s\S]*?\n---/);
});

test('evaluator.md documents the artifact mode', () => {
  assert.match(agentContent, /# Artifact Mode/);
});

test('evaluator.md artifact mode contains all 7 phase-specific guidance sections', () => {
  const phases = ['BRD', 'Spec', 'Design', 'Design-Delta', 'Brownfield', 'Seam-Finder', 'Deploy'];
  for (const phase of phases) {
    assert.match(agentContent, new RegExp(`\\*\\*${phase}\\*\\*`), `missing guidance for ${phase}`);
  }
});

test('phase-evaluator.md no longer exists (merged into evaluator)', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, '.claude', 'agents', 'phase-evaluator.md')));
});

// ── 4. Hook limit values ────────────────────────────────────────────────────

const lengthLib = fs.readFileSync(
  path.join(ROOT, '.claude', 'hooks', 'lib', 'length.js'), 'utf8'
);
const settingsJson = fs.readFileSync(
  path.join(ROOT, '.claude', 'settings.json'), 'utf8'
);

test('length lib enforces the single 300-line file limit', () => {
  assert.match(lengthLib, /FILE_HARD_LIMIT\s*=\s*300/);
});

test('length lib enforces the 30-line function limit', () => {
  assert.match(lengthLib, /FUNC_HARD_LIMIT\s*=\s*30/);
});

// ── 5. Settings.json consistency — lane-independent enforcement hooks ────────
// These hooks are deliberately wired into every edit/turn so that ad-hoc edits
// (outside /build, /auto, /brownfield, /vibe) still enforce quality gates. See
// commit "fix(hooks): make ad-hoc edits enforce quality gates".

function hookCommands(event) {
  const settings = JSON.parse(settingsJson);
  return (settings.hooks[event] || []).flatMap((entry) =>
    (entry.hooks || []).map((h) => h.command || '')
  );
}

test('pre-write-gate.js is wired into PreToolUse hooks', () => {
  assert.ok(
    hookCommands('PreToolUse').some((cmd) => cmd.includes('pre-write-gate.js')),
    'pre-write-gate.js should be in PreToolUse hooks'
  );
});

test('verify-on-save.js is wired into PostToolUse hooks', () => {
  assert.ok(
    hookCommands('PostToolUse').some((cmd) => cmd.includes('verify-on-save.js')),
    'verify-on-save.js should be in PostToolUse hooks'
  );
});

test('review-on-stop.js is wired into Stop hooks', () => {
  assert.ok(
    hookCommands('Stop').some((cmd) => cmd.includes('review-on-stop.js')),
    'review-on-stop.js should be in Stop hooks'
  );
});

test('record-run.js is wired per-edit (receipt-append-only) and on Stop', () => {
  // Per-edit/Bash matchers carry record-run for harness_tool_events_total
  // (Tool Activity dashboard panels). The hot-path guarantee — tool events
  // append a receipt but never rebuild the ledger or push — is pinned in
  // record-run-tool-events.test.js.
  const settings = JSON.parse(settingsJson);
  const perEditMatchers = (settings.hooks.PostToolUse || []).filter(
    (entry) =>
      /Edit|Write|Bash/.test(entry.matcher || '') &&
      (entry.hooks || []).some((h) => (h.command || '').includes('record-run.js'))
  );
  assert.equal(
    perEditMatchers.length, 1,
    'record-run.js must run on the Write|Edit|MultiEdit|Bash matcher (tool-event telemetry)'
  );
  assert.ok(
    hookCommands('Stop').some((cmd) => cmd.includes('record-run.js')),
    'record-run.js should still run on Stop'
  );
});

// ── 6. Telemetry phase eval module ──────────────────────────────────────────

const phaseEvalScriptPath = path.join(ROOT, '.claude', 'scripts', 'telemetry-phase-eval.js');

test('telemetry-phase-eval.js exists', () => {
  assert.ok(fs.existsSync(phaseEvalScriptPath));
});

test('telemetry-phase-eval.js exports processPhaseEval', () => {
  const content = fs.readFileSync(phaseEvalScriptPath, 'utf8');
  assert.match(content, /processPhaseEval/);
  assert.match(content, /harness_phase_eval_score/);
});

test('telemetry-memory.js requires phase eval module', () => {
  const memoryContent = fs.readFileSync(
    path.join(ROOT, '.claude', 'scripts', 'telemetry-memory.js'), 'utf8'
  );
  assert.match(memoryContent, /require\(.*telemetry-phase-eval.*\)/);
});

// ── 7. Skill modifications — evaluator (artifact mode) references ────────────

const skillNames = ['brd', 'spec', 'design', 'brownfield', 'seam-finder', 'deploy'];

// Progressive-loaded skills: scan full corpus (entry SKILL.md + references/).
function skillBody(skill) {
  if (skill === 'design' || skill === 'auto' || skill === 'build') return readSkillCorpus(skill);
  return fs.readFileSync(path.join(ROOT, '.claude', 'skills', skill, 'SKILL.md'), 'utf8');
}

for (const skill of skillNames) {
  test(`${skill}/SKILL.md spawns evaluator in artifact mode (not the removed phase-evaluator)`, () => {
    const content = skillBody(skill);
    assert.doesNotMatch(content, /phase-evaluator/, 'phase-evaluator was merged into evaluator');
    assert.match(content, /evaluator/);
    assert.match(content, /artifact mode/i);
  });
}

for (const skill of skillNames) {
  test(`${skill}/SKILL.md contains Phase Evaluation Gate or Ratchet text`, () => {
    const content = skillBody(skill);
    assert.ok(
      /Phase Evaluation Gate/i.test(content) || /Ratchet/i.test(content),
      `${skill}/SKILL.md should reference Phase Evaluation Gate or Ratchet`
    );
  });
}

// ── 8. Cross-phase traceability references ──────────────────────────────────

test('spec/SKILL.md references specs/brd/brd.md as upstream', () => {
  const content = fs.readFileSync(
    path.join(ROOT, '.claude', 'skills', 'spec', 'SKILL.md'), 'utf8'
  );
  assert.match(content, /specs\/brd\/brd\.md/);
});

test('design/SKILL.md references specs/stories/ as upstream', () => {
  const content = readSkillCorpus('design');
  assert.match(content, /specs\/stories\//);
});

test('brownfield/SKILL.md references actual codebase or verify against for upstream validation', () => {
  const content = fs.readFileSync(
    path.join(ROOT, '.claude', 'skills', 'brownfield', 'SKILL.md'), 'utf8'
  );
  assert.ok(
    /actual codebase/i.test(content) || /verify against/i.test(content),
    'brownfield/SKILL.md should reference actual codebase or verify against'
  );
});
