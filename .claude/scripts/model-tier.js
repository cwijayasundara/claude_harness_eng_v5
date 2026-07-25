#!/usr/bin/env node

'use strict';

// Model-tier presets — map a cost posture to the per-agent model pins.
//
// The harness runs a GAN: generation is the high-volume output bucket, judgment
// is lower-volume but quality-sensitive. Judgment (evaluator + reviewers +
// planner + advisor) is pinned to Opus 5 across every posture.
//
//   cost / enterprise — Sonnet 5 generation, Haiku exploration, Opus judgment.
//                       Enterprise product default (Coinbase: defaults > caps).
//   balanced          — Sonnet 5 generation + exploration, Opus judgment.
//   max-quality       — Opus 5 generation; explorer stays Sonnet 5.
//   fusion            — "cheap worker under a smart lead": Sonnet 5 lead
//                       (generator), Haiku 4.5 worker (implementer), Sonnet 5
//                       exploration, Opus judgment. Only preset where the
//                       teammate worker is cheaper than the lead.
//
// `enterprise` is an alias of `cost` (same pin table; docs-facing name).
//
// The `generator` is the team LEAD; the `implementer` is the per-story WORKER it
// spawns as a teammate. On every preset except fusion the worker pins to the same
// model as the lead, so introducing the role changes no behaviour unless fusion
// is selected. record-run keys a receipt's model off the spawned agent's own
// frontmatter, so a distinct implementer identity is what makes a cheaper-worker
// preset measurable from the per-story receipts.

const fs = require('fs');
const path = require('path');

// Exact model IDs (not bare aliases) — version-pinned and unambiguous.
const OPUS = 'claude-opus-5';       // judgment: evaluator + reviewers + planner + advisor
const SONNET5 = 'claude-sonnet-5';  // generation (cost/balanced) + exploration (balanced+)
const HAIKU = 'claude-haiku-4-5';   // cheap exploration on enterprise/cost

const JUDGMENT = {
  planner: OPUS,
  evaluator: OPUS,
  'design-critic': OPUS,
  'security-reviewer': OPUS,
  'code-reviewer': OPUS,
  'modularity-reviewer': OPUS,
  advisor: OPUS,
};

const PRESETS = {
  cost: {
    ...JUDGMENT,
    generator: SONNET5,
    implementer: SONNET5, // worker == lead: unchanged behaviour off the fusion path
    'codebase-explorer': HAIKU,
  },
  balanced: {
    ...JUDGMENT,
    generator: SONNET5,
    implementer: SONNET5, // worker == lead
    'codebase-explorer': SONNET5,
  },
  'max-quality': {
    ...JUDGMENT,
    generator: OPUS,
    implementer: OPUS, // worker == lead
    'codebase-explorer': SONNET5,
  },
  fusion: {
    ...JUDGMENT,
    generator: SONNET5, // smart lead
    implementer: HAIKU, // cheap worker — the only preset where worker < lead
    'codebase-explorer': SONNET5,
  },
};

// enterprise → same pins as cost (product SKU name).
PRESETS.enterprise = PRESETS.cost;

// Recommended session/orchestrator model per tier (guidance, not an agent pin).
// Keep Opus on /auto conductor for reliability even on cost tier (Haiku only
// on volume explorer).
const SESSION = {
  cost: OPUS,
  enterprise: OPUS,
  balanced: OPUS,
  'max-quality': OPUS,
  fusion: OPUS,
};

function normalizePreset(preset) {
  if (preset === 'enterprise') return 'cost';
  return preset;
}

function modelsForTier(preset) {
  const pins = PRESETS[preset];
  if (!pins) throw new Error(`unknown model tier preset: ${preset}`);
  return { ...pins };
}

function sessionFor(preset) {
  if (!SESSION[preset]) throw new Error(`unknown model tier preset: ${preset}`);
  return SESSION[preset];
}

// Rewrite the `model:` frontmatter line in each agent file to match the preset.
// Returns the list of roles whose model actually changed.
function applyTier(agentsDir, preset) {
  const pins = modelsForTier(preset);
  const changed = [];
  for (const [role, model] of Object.entries(pins)) {
    const file = path.join(agentsDir, `${role}.md`);
    if (!fs.existsSync(file)) continue;
    const before = fs.readFileSync(file, 'utf8');
    const after = before.replace(/^model: .*$/m, `model: ${model}`);
    if (after !== before) {
      fs.writeFileSync(file, after);
      changed.push(role);
    }
  }
  return changed;
}

function printTable(preset) {
  const pins = modelsForTier(preset);
  process.stdout.write(`model tier: ${preset}  (session/orchestrator: ${sessionFor(preset)})\n`);
  for (const [role, model] of Object.entries(pins)) {
    process.stdout.write(`  ${role.padEnd(22)} ${model}\n`);
  }
}

function main() {
  const args = process.argv.slice(2);
  const preset = args.find((a) => !a.startsWith('--')) || 'balanced';
  const applyIdx = args.indexOf('--apply');
  try {
    if (applyIdx !== -1) {
      const dir = args[applyIdx + 1];
      const changed = applyTier(dir, preset);
      process.stdout.write(`applied tier "${preset}" to ${dir} — changed: ${changed.join(', ') || 'none'}\n`);
    } else {
      printTable(preset);
    }
  } catch (err) {
    process.stderr.write(`model-tier: ${err.message}\n`);
    process.exit(2);
  }
}

module.exports = {
  modelsForTier,
  sessionFor,
  applyTier,
  PRESETS,
  normalizePreset,
  OPUS,
  SONNET5,
  HAIKU,
};

if (require.main === module) main();
