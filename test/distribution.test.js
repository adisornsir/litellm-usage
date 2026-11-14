// Unit tests for the model-family grouping and percentage math behind the usage distribution.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { modelGroup, displayName, distValue } = require('../out/client');

test('dated Claude variants group under their family with a readable name', () => {
  assert.equal(modelGroup('claude-sonnet-4-5-20250929'), 'Claude Sonnet 4.5');
  assert.equal(modelGroup('claude-haiku-4-5-20251001-v1:0'), 'Claude Haiku 4.5');
  assert.equal(modelGroup('claude-opus-4-1-20250805'), 'Claude Opus 4.1');
  assert.equal(modelGroup('claude-3-5-sonnet-20241022'), 'Claude Sonnet 3.5');
  assert.equal(modelGroup('claude_sonnet'), 'Claude Sonnet');
  assert.equal(modelGroup('us.anthropic.claude-opus-4-1-20250805'), 'Claude Opus 4.1');
});

test('all Codex variants collapse into one slice', () => {
  assert.equal(modelGroup('gpt-5.1-codex'), 'Codex');
  assert.equal(modelGroup('gpt-5-codex-mini'), 'Codex');
  assert.equal(modelGroup('codex-mini-latest'), 'Codex');
});

test('other models keep a cleaned-up display name', () => {
  assert.equal(modelGroup('gpt-5'), 'GPT-5');
  assert.equal(modelGroup('gpt-4o'), 'GPT-4o');
  assert.equal(modelGroup('gpt-5-mini'), 'GPT-5 mini');
  assert.equal(modelGroup('gemini-2.5-pro'), 'Gemini 2.5 Pro');
  assert.equal(modelGroup('Unknown'), 'Unknown');
  assert.equal(displayName('my-custom_model'), 'My Custom Model');
});

test('distValue picks the requested metric with token fallback', () => {
  const m = { spend: 2, total_tokens: 0, prompt_tokens: 30, completion_tokens: 70, api_requests: 5 };
  assert.equal(distValue(m, 'spend'), 2);
  assert.equal(distValue(m, 'tokens'), 100);
  assert.equal(distValue(m, 'requests'), 5);
});

// Mirror of the modelGroups math in UsageController.aggregate, kept honest against real data shapes.
const { emptyMetrics, addMetrics } = require('../out/client');
function groupUsage(modelUsage) {
  const byGroup = new Map();
  for (const m of modelUsage) {
    byGroup.set(modelGroup(m.name), addMetrics(byGroup.get(modelGroup(m.name)) ?? emptyMetrics(), m.metrics));
  }
  const sum = kind => Math.max([...byGroup.values()].reduce((a, m) => a + distValue(m, kind), 0), 1e-9);
  const [spendSum, tokensSum, requestsSum] = [sum('spend'), sum('tokens'), sum('requests')];
  return [...byGroup].map(([name, metrics]) => ({
    name, metrics,
    spendPct: distValue(metrics, 'spend') / spendSum * 100,
    tokensPct: distValue(metrics, 'tokens') / tokensSum * 100,
    requestsPct: distValue(metrics, 'requests') / requestsSum * 100,
  })).sort((a, b) => b.spendPct - a.spendPct || b.tokensPct - a.tokensPct);
}

test('claude + codex distribution shares add up to 100%', () => {
  const groups = groupUsage([
    { name: 'claude-sonnet-4-5-20250929', metrics: { spend: 4, prompt_tokens: 3000, completion_tokens: 1000, total_tokens: 4000, api_requests: 10 } },
    { name: 'claude-haiku-4-5-20251001-v1:0', metrics: { spend: 1, prompt_tokens: 1500, completion_tokens: 500, total_tokens: 2000, api_requests: 20 } },
    { name: 'gpt-5.1-codex', metrics: { spend: 3, prompt_tokens: 4500, completion_tokens: 1500, total_tokens: 6000, api_requests: 8 } },
    { name: 'codex-mini-latest', metrics: { spend: 2, prompt_tokens: 3000, completion_tokens: 1000, total_tokens: 4000, api_requests: 12 } },
  ]);
  const byName = Object.fromEntries(groups.map(g => [g.name, g]));
  assert.ok(groups[0].spendPct >= groups[1].spendPct && groups[1].spendPct >= groups[2].spendPct,
    `groups sorted by spend share, got ${groups.map(g => `${g.name}:${g.spendPct.toFixed(1)}%`).join(', ')}`);
  assert.ok(Math.abs(byName['Claude Sonnet 4.5'].spendPct - 40) < 1e-9);
  assert.ok(Math.abs(byName['Codex'].spendPct - 50) < 1e-9);
  assert.ok(Math.abs(byName['Codex'].tokensPct - (10000 / 16000 * 100)) < 1e-9);
  for (const k of ['spendPct', 'tokensPct', 'requestsPct']) {
    assert.ok(Math.abs(groups.reduce((a, g) => a + g[k], 0) - 100) < 1e-9, `${k} sums to 100%`);
  }
});
