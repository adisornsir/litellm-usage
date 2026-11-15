const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { discoverCompanionKeys, readLocalActivity } = require('../out/localLogs');

test('discovers companion Claude and Codex keys from home directory', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'litellm-keys-'));
  try {
    fs.mkdirSync(path.join(tmp, '.claude-corp'), { recursive: true });
    fs.mkdirSync(path.join(tmp, '.codex-corp'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.claude-corp', 'key'), 'sk-claude-1\n');
    fs.writeFileSync(path.join(tmp, '.codex-corp', 'key'), 'sk-codex-2\n');

    assert.deepEqual(discoverCompanionKeys('sk-claude-1', tmp), ['sk-codex-2']);
    assert.deepEqual(discoverCompanionKeys(undefined, tmp), ['sk-claude-1', 'sk-codex-2']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('reads and prices local Claude and Codex JSONL session logs', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'litellm-logs-'));
  try {
    const claudeDir = path.join(tmp, '.claude-corp', 'claude-config', 'projects', 'proj-a');
    const codexDir = path.join(tmp, '.codex-corp', 'codex-config', 'sessions', '2026', '11', '15');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.mkdirSync(codexDir, { recursive: true });

    // Claude session with duplicate streaming message IDs (should count once)
    const claudeLines = [
      JSON.stringify({
        timestamp: '2026-11-15T10:00:00.000Z',
        message: {
          id: 'msg_1',
          model: 'claude-sonnet-5-5',
          usage: { input_tokens: 1000, cache_creation_input_tokens: 2000, cache_read_input_tokens: 3000, output_tokens: 500 },
        },
      }),
      JSON.stringify({
        timestamp: '2026-11-15T10:00:01.000Z',
        message: {
          id: 'msg_1',
          model: 'claude-sonnet-5-5',
          usage: { input_tokens: 1000, cache_creation_input_tokens: 2000, cache_read_input_tokens: 3000, output_tokens: 500 },
        },
      }),
    ];
    fs.writeFileSync(path.join(claudeDir, 'session-1.jsonl'), claudeLines.join('\n') + '\n');

    // Codex rollout with cumulative total_token_usage across two turns
    const codexLines = [
      JSON.stringify({ timestamp: '2026-11-15T11:00:00.000Z', type: 'turn_context', payload: { model: 'gpt-5.3-codex' } }),
      JSON.stringify({
        timestamp: '2026-11-15T11:00:05.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { input_tokens: 10000, cached_input_tokens: 8000, cache_write_input_tokens: 0, output_tokens: 1000 } },
        },
      }),
      JSON.stringify({ timestamp: '2026-11-15T11:05:00.000Z', type: 'turn_context', payload: { model: 'gpt-6.1-sol' } }),
      JSON.stringify({
        timestamp: '2026-11-15T11:05:10.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { input_tokens: 15000, cached_input_tokens: 12000, cache_write_input_tokens: 0, output_tokens: 1500 } },
        },
      }),
    ];
    fs.writeFileSync(path.join(codexDir, 'rollout-1.jsonl'), codexLines.join('\n') + '\n');

    const pricing = {
      'claude-sonnet-5-5': { input: 2e-6, output: 10e-6, cacheRead: 0.1e-6, cacheWrite: 2.5e-6 },
      'gpt-5.3-codex': { input: 1.75e-6, output: 14e-6, cacheRead: 0.175e-6, cacheWrite: 0 },
      'gpt-6.1-sol': { input: 2.4e-6, output: 12e-6, cacheRead: 0.12e-6, cacheWrite: 3e-6 },
    };

    const entries = readLocalActivity('2026-11-15', '2026-11-15', pricing, undefined, tmp);
    assert.equal(entries.length, 1);
    const day = entries[0];
    assert.equal(day.date, '2026-11-15');
    assert.equal(day.metrics.api_requests, 3);
    assert.deepEqual(Object.keys(day.breakdown.models).sort(), ['claude-sonnet-5-5', 'gpt-5.3-codex', 'gpt-6.1-sol']);
    assert.equal(day.breakdown.models['claude-sonnet-5-5'].metrics.total_tokens, 6500);
    assert.equal(day.breakdown.models['gpt-5.3-codex'].metrics.total_tokens, 11000);
    assert.equal(day.breakdown.models['gpt-6.1-sol'].metrics.total_tokens, 5500);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
