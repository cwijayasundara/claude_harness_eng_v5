'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');

const SCRIPT = path.join(__dirname, '..', '.claude', 'scripts', 'model-tier.js');
const { modelsForTier, sessionFor, applyTier, PRESETS } = require(SCRIPT);

const OPUS = 'claude-opus-5';
const SONNET5 = 'claude-sonnet-5';
const HAIKU = 'claude-haiku-4-5';
const NAMED_PRESETS = ['cost', 'balanced', 'max-quality', 'fusion'];
const ROLES = [
  'planner',
  'generator',
  'implementer',
  'evaluator',
  'design-critic',
  'security-reviewer',
  'code-reviewer',
  'modularity-reviewer',
  'advisor',
  'codebase-explorer',
];

test('named presets exist: cost, balanced, max-quality (+ enterprise alias)', () => {
  for (const p of NAMED_PRESETS) assert.ok(PRESETS[p], p);
  assert.ok(PRESETS.enterprise);
  assert.deepStrictEqual(modelsForTier('enterprise'), modelsForTier('cost'));
});

test('every named preset assigns a model to all agent roles', () => {
  for (const preset of NAMED_PRESETS) {
    const m = modelsForTier(preset);
    assert.deepStrictEqual(Object.keys(m).sort(), ROLES.slice().sort(), `preset ${preset}`);
  }
});

test('pins are exact model IDs, never bare aliases', () => {
  const valid = new Set([OPUS, SONNET5, HAIKU]);
  for (const preset of NAMED_PRESETS) {
    for (const [role, model] of Object.entries(modelsForTier(preset))) {
      assert.ok(valid.has(model), `${preset}/${role} = "${model}" must be an exact model id`);
    }
  }
});

test('cost: Sonnet generation, Haiku explorer, Opus judgment', () => {
  const m = modelsForTier('cost');
  assert.strictEqual(m.generator, SONNET5);
  assert.strictEqual(m['codebase-explorer'], HAIKU);
  assert.strictEqual(m.planner, OPUS);
  assert.strictEqual(m.evaluator, OPUS);
  assert.strictEqual(m.advisor, OPUS);
  assert.strictEqual(m['modularity-reviewer'], OPUS);
});

test('cost is distinct from balanced via explorer pin', () => {
  const cost = modelsForTier('cost');
  const bal = modelsForTier('balanced');
  assert.strictEqual(cost.generator, bal.generator);
  assert.notStrictEqual(cost['codebase-explorer'], bal['codebase-explorer']);
  assert.strictEqual(bal['codebase-explorer'], SONNET5);
});

test('balanced: Sonnet generation + explorer, Opus judgment', () => {
  const m = modelsForTier('balanced');
  assert.strictEqual(m.generator, SONNET5);
  assert.strictEqual(m['codebase-explorer'], SONNET5);
  assert.strictEqual(m.evaluator, OPUS);
  assert.strictEqual(m.planner, OPUS);
  assert.notStrictEqual(m.generator, modelsForTier('max-quality').generator);
});

test('max-quality: Opus 5 generation; explorer stays Sonnet', () => {
  const m = modelsForTier('max-quality');
  assert.strictEqual(m.planner, OPUS);
  assert.strictEqual(m.generator, OPUS);
  assert.strictEqual(m.evaluator, OPUS);
  assert.strictEqual(m['design-critic'], OPUS);
  assert.strictEqual(m['code-reviewer'], OPUS);
  assert.strictEqual(m['security-reviewer'], OPUS);
  assert.strictEqual(m.advisor, OPUS);
  assert.strictEqual(m['codebase-explorer'], SONNET5);
});

test('implementer (team worker) pins to the same model as the generator (lead) off the fusion path', () => {
  // Introducing the worker role must not change behaviour unless fusion is picked.
  for (const preset of ['cost', 'balanced', 'max-quality']) {
    const m = modelsForTier(preset);
    assert.strictEqual(m.implementer, m.generator, `preset ${preset}: worker must equal lead`);
  }
});

test('fusion: Sonnet lead, Haiku worker, Sonnet explorer, Opus judgment', () => {
  const m = modelsForTier('fusion');
  assert.strictEqual(m.generator, SONNET5, 'lead is Sonnet');
  assert.strictEqual(m.implementer, HAIKU, 'worker is the cheap Haiku tier');
  assert.notStrictEqual(m.implementer, m.generator, 'fusion is the one preset where worker < lead');
  assert.strictEqual(m['codebase-explorer'], SONNET5);
  assert.strictEqual(m.planner, OPUS);
  assert.strictEqual(m.evaluator, OPUS);
  assert.strictEqual(m['code-reviewer'], OPUS);
  assert.strictEqual(m.advisor, OPUS);
});

test('fusion leaves the named cost/balanced/max-quality pins untouched', () => {
  // The new preset is additive: the three original presets are byte-identical.
  assert.deepStrictEqual(modelsForTier('cost'), {
    planner: OPUS, generator: SONNET5, implementer: SONNET5, evaluator: OPUS,
    'design-critic': OPUS, 'security-reviewer': OPUS, 'code-reviewer': OPUS,
    'modularity-reviewer': OPUS, advisor: OPUS, 'codebase-explorer': HAIKU,
  });
});

test('unknown preset throws', () => {
  assert.throws(() => modelsForTier('cheapest'), /unknown.*tier|preset/i);
});

test('session model guidance is Opus 5 in every tier', () => {
  assert.strictEqual(sessionFor('cost'), OPUS);
  assert.strictEqual(sessionFor('enterprise'), OPUS);
  assert.strictEqual(sessionFor('balanced'), OPUS);
  assert.strictEqual(sessionFor('max-quality'), OPUS);
  assert.strictEqual(sessionFor('fusion'), OPUS);
});

// --- applyTier: stamps the model: frontmatter line in each agent file ----------

function fakeAgent(dir, role, model) {
  const p = path.join(dir, `${role}.md`);
  fs.writeFileSync(p, `---\nname: ${role}\nmodel: ${model}\ndescription: test\n---\n\nBody.\n`);
  return p;
}

test('applyTier rewrites each agent model: line to the exact id for the preset', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-'));
  for (const role of ROLES) fakeAgent(dir, role, OPUS);
  const changed = applyTier(dir, 'balanced');
  assert.match(fs.readFileSync(path.join(dir, 'planner.md'), 'utf8'), /^model: claude-opus-5$/m);
  assert.match(fs.readFileSync(path.join(dir, 'generator.md'), 'utf8'), /^model: claude-sonnet-5$/m);
  assert.ok(changed.includes('generator')); // OPUS -> Sonnet 5
  assert.ok(changed.includes('codebase-explorer')); // OPUS -> Sonnet 5
  assert.ok(!changed.includes('planner')); // already OPUS, unchanged
  assert.ok(!changed.includes('evaluator')); // already OPUS, unchanged
});

test('applyTier cost pins explorer to Haiku', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-'));
  for (const role of ROLES) fakeAgent(dir, role, OPUS);
  applyTier(dir, 'cost');
  assert.match(fs.readFileSync(path.join(dir, 'codebase-explorer.md'), 'utf8'), /^model: claude-haiku-4-5$/m);
  assert.match(fs.readFileSync(path.join(dir, 'generator.md'), 'utf8'), /^model: claude-sonnet-5$/m);
  assert.match(fs.readFileSync(path.join(dir, 'advisor.md'), 'utf8'), /^model: claude-opus-5$/m);
});

test('applyTier fusion stamps the implementer worker to Haiku and the generator lead to Sonnet', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-'));
  for (const role of ROLES) fakeAgent(dir, role, OPUS);
  const changed = applyTier(dir, 'fusion');
  // The measurability requirement: the worker agent's own frontmatter carries the
  // cheap model, because record-run keys the receipt model off that frontmatter.
  assert.match(fs.readFileSync(path.join(dir, 'implementer.md'), 'utf8'), /^model: claude-haiku-4-5$/m);
  assert.match(fs.readFileSync(path.join(dir, 'generator.md'), 'utf8'), /^model: claude-sonnet-5$/m);
  assert.match(fs.readFileSync(path.join(dir, 'codebase-explorer.md'), 'utf8'), /^model: claude-sonnet-5$/m);
  assert.match(fs.readFileSync(path.join(dir, 'evaluator.md'), 'utf8'), /^model: claude-opus-5$/m);
  assert.ok(changed.includes('implementer')); // OPUS -> Haiku
});

test('applyTier preserves the rest of the frontmatter and body', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-'));
  fakeAgent(dir, 'planner', OPUS);
  applyTier(dir, 'cost');
  const txt = fs.readFileSync(path.join(dir, 'planner.md'), 'utf8');
  assert.match(txt, /^name: planner$/m);
  assert.match(txt, /^description: test$/m);
  assert.match(txt, /Body\./);
  assert.match(txt, /^model: claude-opus-5$/m);
});

// --- the repo's own agents must carry exact ids matching the default tier ------

test('repo agents are stamped with exact model ids (default dogfood tier = balanced)', () => {
  const dir = path.join(__dirname, '..', '.claude', 'agents');
  const expected = modelsForTier('balanced');
  const valid = new Set([OPUS, SONNET5, HAIKU]);
  // Advisor is new; modularity-reviewer may exist — require known roles only.
  for (const role of ['planner', 'generator', 'implementer', 'evaluator', 'design-critic', 'security-reviewer', 'code-reviewer', 'codebase-explorer']) {
    const txt = fs.readFileSync(path.join(dir, `${role}.md`), 'utf8');
    const m = txt.match(/^model: (.+)$/m);
    assert.ok(m, `${role}.md must declare a model`);
    assert.ok(valid.has(m[1]), `${role}.md model "${m[1]}" must be an exact id`);
    assert.strictEqual(m[1], expected[role], `${role}.md should match the balanced preset`);
  }
  // Advisor agent must exist and be Opus
  const adv = fs.readFileSync(path.join(dir, 'advisor.md'), 'utf8');
  assert.match(adv, /^model: claude-opus-5$/m);
});
