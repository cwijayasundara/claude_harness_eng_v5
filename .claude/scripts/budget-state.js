'use strict';

// Per-task budget accounting for autonomous runs (S4). Mirrors
// build-chain-state.js / plan-confidence.js: the math is pure (takes
// already-read spend + config, returns a banded budget) so it unit-tests
// without I/O. The thin gatherSpend layer tallies receipts; the CLI reads real
// state and prints the current budget line.
//
// The harness makes no direct Anthropic API calls, so an exact running token
// count is not observable in-loop. The ENFORCEABLE units are therefore
// wall-clock and agent-spawn count (both directly observable); est_cost_usd is
// a SURFACED ESTIMATE (Σ receipts × rate), upgraded to measured cost only when
// a receipt carries real token fields. See docs/proposals/s4-budget-caps.md.

const DEFAULT_WARN_PCT = 80;
const MS = Object.freeze({ ms: 1, s: 1000, m: 60000, min: 60000, h: 3600000 });

// Rough per-subagent-spawn cost estimate (USD) by tier and agent bucket. These
// are deliberately approximate seeds for the *estimate* — refine from telemetry.
const RATE_USD = Object.freeze({
  cost: { gen: 0.04, judge: 0.10, default: 0.07 },
  balanced: { gen: 0.10, judge: 0.12, default: 0.11 },
  'max-quality': { gen: 0.16, judge: 0.16, default: 0.16 },
  default: { gen: 0.10, judge: 0.12, default: 0.11 },
});

// Approximate USD per token [input, output] when a receipt carries real counts.
// Cache read ≈ 10% of input rate; cache creation ≈ full input rate (Anthropic).
// The whole Opus tier (5, 4.8, 4.7) is $5/$25 per MTok; Sonnet 5 is listed at
// its $3/$15 sticker, not the lower intro rate. Retired pins (opus-4-8/4-7,
// sonnet-4-6) stay so historical receipts price correctly; fable-5 is reserved.
const MODEL_PRICE = Object.freeze({
  'claude-opus-5': [5e-6, 25e-6],
  'claude-opus-4-8': [5e-6, 25e-6],
  'claude-opus-4-7': [5e-6, 25e-6],
  'claude-sonnet-5': [3e-6, 15e-6],
  'claude-sonnet-4-6': [3e-6, 15e-6],
  'claude-haiku-4-5': [1e-6, 5e-6],
  'claude-fable-5': [10e-6, 50e-6],
  default: [5e-6, 25e-6],
});

const CACHE_READ_FRACTION = 0.1;

// Default caps per model tier (burn rate scales with tier).
const TIER_DEFAULTS = Object.freeze({
  cost: { wall_clock_ms: 30 * 60000, agents: 80, est_cost_usd: 8 },
  balanced: { wall_clock_ms: 90 * 60000, agents: 200, est_cost_usd: 25 },
  'max-quality': { wall_clock_ms: 180 * 60000, agents: 400, est_cost_usd: 60 },
});

// Roles treated as high-volume workers for model-mix "worker %" reporting.
const WORKER_AGENTS = new Set(['generator', 'codebase-explorer']);

const round2 = (n) => Math.round(n * 100) / 100;
const round4 = (n) => Math.round(n * 10000) / 10000;
const toMs = (n, unit) => n * (MS[unit] || 1);
const agentBucket = (agent) => (agent === 'generator' ? 'gen' : 'judge');

function hasTokenFields(r) {
  return r && (r.output_tokens != null || r.input_tokens != null
    || r.cache_read_tokens != null || r.cache_creation_tokens != null);
}

function receiptCost(r, tier) {
  if (hasTokenFields(r)) {
    const price = MODEL_PRICE[r.model] || MODEL_PRICE.default;
    const input = (r.input_tokens || 0) * price[0];
    const output = (r.output_tokens || 0) * price[1];
    const cacheRead = (r.cache_read_tokens || 0) * price[0] * CACHE_READ_FRACTION;
    const cacheCreate = (r.cache_creation_tokens || 0) * price[0];
    return input + output + cacheRead + cacheCreate;
  }
  const rates = RATE_USD[tier] || RATE_USD.default;
  const r2 = rates[agentBucket(r.agent)];
  return r2 != null ? r2 : rates.default;
}

// Estimated cost of every subagent dispatch in `receipts`.
function estimateCost(receipts, tier) {
  return (receipts || [])
    .filter((r) => r.kind === 'subagent')
    .reduce((sum, r) => sum + receiptCost(r, tier), 0);
}

// Spend across the three units since the run started.
function gatherSpend(receipts, startedAtMs, nowMs, tier) {
  const since = (receipts || []).filter((r) => !startedAtMs || (r.ts || 0) >= startedAtMs);
  return {
    wall_clock_ms: Math.max(0, (nowMs || 0) - (startedAtMs || nowMs || 0)),
    agents: since.filter((r) => r.kind === 'subagent').length,
    est_cost_usd: round2(estimateCost(since, tier)),
  };
}

// Per-model breakdown for /status and cost-report.
function modelMix(receipts, tier) {
  const out = {};
  for (const r of receipts || []) {
    if (r.kind !== 'subagent') continue;
    const model = r.model || 'unknown';
    if (!out[model]) {
      out[model] = {
        agents: 0,
        est_cost_usd: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
      };
    }
    const row = out[model];
    row.agents += 1;
    row.est_cost_usd = round4(row.est_cost_usd + receiptCost(r, tier));
    row.input_tokens += r.input_tokens || 0;
    row.output_tokens += r.output_tokens || 0;
    row.cache_read_tokens += r.cache_read_tokens || 0;
    row.cache_creation_tokens += r.cache_creation_tokens || 0;
  }
  for (const row of Object.values(out)) {
    row.est_cost_usd = round2(row.est_cost_usd);
  }
  return out;
}

// How est_cost was derived across subagent receipts in the window.
function costSource(receipts) {
  const subs = (receipts || []).filter((r) => r.kind === 'subagent');
  if (!subs.length) return 'estimate';
  let withTok = 0;
  for (const r of subs) if (hasTokenFields(r)) withTok += 1;
  if (withTok === 0) return 'estimate';
  if (withTok === subs.length) return 'receipts';
  return 'mixed';
}

function workerShare(receipts, tier) {
  const subs = (receipts || []).filter((r) => r.kind === 'subagent');
  if (!subs.length) return null;
  let total = 0;
  let worker = 0;
  for (const r of subs) {
    const c = receiptCost(r, tier);
    total += c;
    if (WORKER_AGENTS.has(r.agent)) worker += c;
  }
  if (!(total > 0)) return null;
  return Math.round((worker / total) * 100);
}

// Compact summary for /status (since budget-start when provided).
function costSummary(receipts, startedAtMs, nowMs, tier) {
  const since = (receipts || []).filter((r) => !startedAtMs || (r.ts || 0) >= startedAtMs);
  const spent = gatherSpend(since, startedAtMs, nowMs, tier);
  const mix = modelMix(since, tier);
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  for (const r of since.filter((x) => x.kind === 'subagent')) {
    input += r.input_tokens || 0;
    output += r.output_tokens || 0;
    cacheRead += r.cache_read_tokens || 0;
  }
  const tokenTotal = input + output + cacheRead;
  return {
    est_cost_usd: spent.est_cost_usd,
    agents: spent.agents,
    source: costSource(since),
    worker_pct: workerShare(since, tier),
    model_mix: mix,
    input_tokens: input || null,
    output_tokens: output || null,
    cache_read_tokens: cacheRead || null,
    cache_read_share_pct: tokenTotal > 0 ? Math.round((cacheRead / tokenTotal) * 100) : null,
  };
}

function fmtCost(summary) {
  if (!summary) return null;
  const parts = [`~$${summary.est_cost_usd}`, `source=${summary.source}`];
  if (summary.worker_pct != null) parts.push(`worker ${summary.worker_pct}%`);
  const mix = summary.model_mix || {};
  const models = Object.keys(mix).sort();
  if (models.length) {
    parts.push(`models: ${models.map((m) => {
      const short = m.replace(/^claude-/, '');
      return `${short}=${mix[m].agents}`;
    }).join(' ')}`);
  }
  if (summary.cache_read_share_pct != null) {
    parts.push(`cache-read ${summary.cache_read_share_pct}%`);
  }
  return `Cost:      ${parts.join(' · ')}`;
}

function dimensionStatus(dim, spent, warnPct) {
  const used = spent[dim.unit] || 0;
  const limit = dim.limit;
  const base = { unit: dim.unit, limit, spent: used, estimated: !!dim.estimated };
  if (!(limit > 0)) return { ...base, pctUsed: 0, band: 'ok' }; // 0/negative => no cap
  const pctUsed = Math.round((used / limit) * 100);
  const band = used >= limit ? 'exhausted' : pctUsed >= warnPct ? 'warn' : 'ok';
  return { ...base, pctUsed, band };
}

// Pure: spend map + resolved config -> banded budget, or null when disabled.
function computeBudget(spent, config) {
  if (!config || config === 'off' || !Array.isArray(config.dimensions) || !config.dimensions.length) {
    return null;
  }
  const warnPct = config.warn_at_pct || DEFAULT_WARN_PCT;
  const dimensions = config.dimensions.map((d) => dimensionStatus(d, spent || {}, warnPct));
  const exhausted = dimensions.some((d) => d.band === 'exhausted');
  const warn = !exhausted && dimensions.some((d) => d.band === 'warn');
  const remaining = {};
  for (const d of dimensions) remaining[d.unit] = Math.max(0, d.limit - d.spent);
  return { dimensions, band: exhausted ? 'exhausted' : warn ? 'warn' : 'ok', exhausted, warn, remaining };
}

// "2h" / "90m" / "150agents" / "$20" / "off" -> one dimension, null (disabled),
// or undefined (unparseable — caller falls back to defaults).
function parseBudgetSpec(spec) {
  if (spec == null) return undefined;
  const s = String(spec).trim().toLowerCase();
  if (s === 'off' || s === 'none') return null;
  if (/^\$|usd$/.test(s)) {
    const n = parseFloat(s.replace(/[^\d.]/g, ''));
    return Number.isFinite(n) ? { unit: 'est_cost_usd', limit: n, estimated: true } : undefined;
  }
  const agents = s.match(/^(\d+)\s*agents?$/);
  if (agents) return { unit: 'agents', limit: parseInt(agents[1], 10) };
  const time = s.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|min|h)$/);
  if (time) return { unit: 'wall_clock_ms', limit: toMs(parseFloat(time[1]), time[2]) };
  return undefined;
}

// Resolved per-tier default budget config.
function defaultBudget(tier) {
  const d = TIER_DEFAULTS[tier] || TIER_DEFAULTS.balanced;
  return {
    warn_at_pct: DEFAULT_WARN_PCT,
    dimensions: [
      { unit: 'wall_clock_ms', limit: d.wall_clock_ms },
      { unit: 'agents', limit: d.agents },
      { unit: 'est_cost_usd', limit: d.est_cost_usd, estimated: true },
    ],
  };
}

// One-line render shared by the CLI and the /status snapshot.
function fmtBudget(b) {
  const parts = b.dimensions.map((d) => {
    if (d.unit === 'wall_clock_ms') return `${Math.round(d.spent / 60000)}m/${Math.round(d.limit / 60000)}m wall (${d.pctUsed}%)`;
    if (d.unit === 'agents') return `${d.spent}/${d.limit} agents`;
    return `~$${d.spent}/$${d.limit} est`;
  });
  return `Budget:    ${parts.join(' · ')}  [${b.band}]`;
}

module.exports = {
  DEFAULT_WARN_PCT,
  RATE_USD,
  MODEL_PRICE,
  TIER_DEFAULTS,
  WORKER_AGENTS,
  CACHE_READ_FRACTION,
  estimateCost,
  gatherSpend,
  computeBudget,
  parseBudgetSpec,
  defaultBudget,
  fmtBudget,
  receiptCost,
  hasTokenFields,
  modelMix,
  costSource,
  workerShare,
  costSummary,
  fmtCost,
};

// ---- CLI ----------------------------------------------------------------

function readReceipts(root) {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(root, '.claude', 'runs');
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
  } catch (_) {
    return [];
  }
  return files.flatMap((f) =>
    fs.readFileSync(path.join(dir, f), 'utf8')
      .split(/\n+/)
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch (_) { return null; } })
      .filter(Boolean));
}

if (require.main === module) {
  const fs = require('fs');
  const path = require('path');
  const root = process.argv[2] || '.';
  const read = (rel) => { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch (_) { return null; } };

  let manifest = {};
  try { manifest = JSON.parse(read('project-manifest.json') || '{}'); } catch (_) { /* defaults */ }
  const exec = manifest.execution || {};
  const tier = exec.model_tier || 'balanced';
  const config = exec.budget || defaultBudget(tier);

  const startRaw = (read('.claude/state/budget-start') || '').trim();
  const started = parseInt(startRaw, 10) || null;
  const spent = gatherSpend(readReceipts(root), started, Date.now(), tier);
  const budget = computeBudget(spent, config);
  process.stdout.write(budget ? `${fmtBudget(budget)}\n` : 'Budget:    (none configured)\n');
}
