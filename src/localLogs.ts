import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { addMetrics, DailyEntry, emptyMetrics, Metrics, ModelPrice } from './client';

interface RawEvent {
  id?: string;
  date: string;
  model: string;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

interface CachedFile {
  mtimeMs: number;
  size: number;
  events: RawEvent[];
}

const fileCache = new Map<string, CachedFile>();

const FALLBACK_PRICING: [RegExp, ModelPrice][] = [
  [/claude-opus-5[-.]5/i, { input: 4e-6, output: 20e-6, cacheRead: 0.2e-6, cacheWrite: 5e-6 }],
  [/claude-opus/i, { input: 5e-6, output: 25e-6, cacheRead: 0.5e-6, cacheWrite: 6.25e-6 }],
  [/claude-sonnet-5[-.]5/i, { input: 2e-6, output: 10e-6, cacheRead: 0.1e-6, cacheWrite: 2.5e-6 }],
  [/claude-sonnet/i, { input: 3e-6, output: 15e-6, cacheRead: 0.3e-6, cacheWrite: 3.75e-6 }],
  [/claude-haiku-5[-.]5/i, { input: 0.1e-6, output: 0.5e-6, cacheRead: 0.01e-6, cacheWrite: 0.125e-6 }],
  [/claude-haiku/i, { input: 1e-6, output: 5e-6, cacheRead: 0.1e-6, cacheWrite: 1.25e-6 }],
  [/gpt-6[-.]1-sol|gpt-6-sol/i, { input: 2.4e-6, output: 12e-6, cacheRead: 0.12e-6, cacheWrite: 3e-6 }],
  [/gpt-6-astra/i, { input: 10e-6, output: 50e-6, cacheRead: 1e-6, cacheWrite: 12.5e-6 }],
  [/gpt-6-luna|codex-auto-review/i, { input: 0.12e-6, output: 0.6e-6, cacheRead: 0.012e-6, cacheWrite: 0.15e-6 }],
  [/gpt-5[-.]6-sol|gpt-5[-.]5/i, { input: 5e-6, output: 30e-6, cacheRead: 0.5e-6, cacheWrite: 5e-6 }],
  [/gpt-5[-.]6-terra/i, { input: 2e-6, output: 12e-6, cacheRead: 0.2e-6, cacheWrite: 2.5e-6 }],
  [/gpt-5[-.]6-luna/i, { input: 0.2e-6, output: 1.2e-6, cacheRead: 0.02e-6, cacheWrite: 0.25e-6 }],
  [/codex/i, { input: 1.75e-6, output: 14e-6, cacheRead: 0.175e-6, cacheWrite: 1.75e-6 }],
  [/glm/i, { input: 2.1e-6, output: 6.6e-6, cacheRead: 0.39e-6, cacheWrite: 2.1e-6 }],
  [/kimi/i, { input: 3e-6, output: 15e-6, cacheRead: 0.3e-6, cacheWrite: 3e-6 }],
  [/gemini/i, { input: 4e-6, output: 20e-6, cacheRead: 0.2e-6, cacheWrite: 4e-6 }],
  [/deepseek/i, { input: 0.38e-6, output: 1.5e-6, cacheRead: 0.01e-6, cacheWrite: 0.38e-6 }],
];

/**
 * Reads companion virtual keys stored on disk by corporate Claude / Codex wrappers
 * (`~/.claude-corp/key`, `~/.codex-corp/key`) so a user with separate Claude and Codex keys
 * sees both sets of models and spend under a single LiteLLM account.
 */
export function discoverCompanionKeys(activeKey?: string, homeDir = os.homedir()): string[] {
  const candidates = [
    path.join(homeDir, '.claude-corp', 'key'),
    path.join(homeDir, '.codex-corp', 'key'),
  ];
  const out: string[] = [];
  for (const file of candidates) {
    try {
      const k = fs.readFileSync(file, 'utf8').trim();
      if (k && k !== activeKey && !out.includes(k)) { out.push(k); }
    } catch { /* file does not exist */ }
  }
  return out;
}

export function priceForModel(model: string, pricing: Record<string, ModelPrice>): ModelPrice {
  const lower = model.toLowerCase();
  if (pricing[lower]) { return pricing[lower]; }
  const stripped = lower.replace(/^(?:fw-|turkcell-|us\.anthropic\.|eu\.anthropic\.|anthropic\.|openai\.)/, '');
  if (pricing[stripped]) { return pricing[stripped]; }
  for (const [re, price] of FALLBACK_PRICING) {
    if (re.test(lower)) { return price; }
  }
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

/**
 * Builds `DailyEntry[]` from local Claude Code (`~/.claude-corp`, `~/.claude`) and Codex CLI
 * (`~/.codex-corp`, `~/.codex`) session JSONL logs when the proxy blocks `/user/daily/activity`.
 */
export function readLocalActivity(
  start: string,
  end: string,
  pricing: Record<string, ModelPrice>,
  allowedModels?: Set<string>,
  homeDir = os.homedir(),
): DailyEntry[] {
  const claudeDirs = [
    path.join(homeDir, '.claude-corp', 'claude-config', 'projects'),
    path.join(homeDir, '.claude', 'projects'),
  ];
  const codexDirs = [
    path.join(homeDir, '.codex-corp', 'codex-config', 'sessions'),
    path.join(homeDir, '.codex', 'sessions'),
  ];

  const claudeFiles = uniqueFiles(claudeDirs.flatMap(d => walkJsonl(d, 3)));
  const codexFiles = uniqueByBasename(codexDirs.flatMap(d => walkJsonl(d, 4)));

  const seenMsgIds = new Set<string>();
  const events: RawEvent[] = [];

  for (const file of claudeFiles) {
    for (const ev of loadFileEvents(file, 'claude')) {
      if (ev.id) {
        if (seenMsgIds.has(ev.id)) { continue; }
        seenMsgIds.add(ev.id);
      }
      events.push(ev);
    }
  }
  for (const file of codexFiles) {
    for (const ev of loadFileEvents(file, 'codex')) {
      events.push(ev);
    }
  }

  const filterSet = allowedModels && allowedModels.size
    ? new Set([...allowedModels].map(m => m.toLowerCase()))
    : undefined;

  const byDay = new Map<string, { metrics: Metrics; models: Record<string, { metrics: Metrics }> }>();

  for (const ev of events) {
    if (ev.date < start || ev.date > end) { continue; }
    if (filterSet && !matchesModelFilter(ev.model.toLowerCase(), filterSet)) { continue; }

    const pr = priceForModel(ev.model, pricing);
    const spend = ev.input * pr.input + ev.cacheRead * pr.cacheRead + ev.cacheWrite * pr.cacheWrite + ev.output * pr.output;
    const promptTokens = ev.input + ev.cacheRead + ev.cacheWrite;
    const completionTokens = ev.output;
    const delta: Partial<Metrics> = {
      spend,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      api_requests: 1,
      successful_requests: 1,
      failed_requests: 0,
    };

    let day = byDay.get(ev.date);
    if (!day) {
      day = { metrics: emptyMetrics(), models: {} };
      byDay.set(ev.date, day);
    }
    day.metrics = addMetrics(day.metrics, delta);
    day.models[ev.model] = {
      metrics: addMetrics(day.models[ev.model]?.metrics ?? emptyMetrics(), delta),
    };
  }

  return [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, v]) => ({ date, metrics: v.metrics, breakdown: { models: v.models } }));
}

function matchesModelFilter(modelLower: string, allowedLower: Set<string>): boolean {
  if (allowedLower.has(modelLower)) { return true; }
  const stripped = modelLower.replace(/^fw-/, '');
  return allowedLower.has(stripped);
}

function walkJsonl(dir: string, maxDepth: number): string[] {
  if (maxDepth < 0) { return []; }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...walkJsonl(full, maxDepth - 1));
    } else if (ent.isFile() && ent.name.endsWith('.jsonl')) {
      out.push(full);
    }
  }
  return out;
}

function uniqueFiles(files: string[]): string[] {
  return [...new Set(files)];
}

function uniqueByBasename(files: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of files) {
    const base = path.basename(f);
    if (seen.has(base)) { continue; }
    seen.add(base);
    out.push(f);
  }
  return out;
}

function loadFileEvents(file: string, kind: 'claude' | 'codex'): RawEvent[] {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return [];
  }
  const cached = fileCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.events;
  }
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const events = kind === 'claude' ? parseClaudeContent(content) : parseCodexContent(content);
  fileCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, events });
  return events;
}

function parseClaudeContent(content: string): RawEvent[] {
  const out: RawEvent[] = [];
  const seenInFile = new Set<string>();
  let pos = 0;
  while (pos < content.length) {
    let next = content.indexOf('\n', pos);
    if (next === -1) { next = content.length; }
    const line = content.slice(pos, next);
    pos = next + 1;
    if (!line.includes('"usage"')) { continue; }
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }
    const msg = obj?.message;
    const usage = msg?.usage;
    const model = typeof msg?.model === 'string' ? msg.model.trim() : '';
    if (!usage || !model || model === '<synthetic>') { continue; }
    const date = typeof obj.timestamp === 'string' ? obj.timestamp.slice(0, 10) : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { continue; }
    const id = typeof msg.id === 'string' && msg.id ? msg.id : undefined;
    if (id) {
      if (seenInFile.has(id)) { continue; }
      seenInFile.add(id);
    }
    const input = Math.max(0, Number(usage.input_tokens) || 0);
    const cacheWrite = Math.max(0, Number(usage.cache_creation_input_tokens) || 0);
    const cacheRead = Math.max(0, Number(usage.cache_read_input_tokens) || 0);
    const output = Math.max(0, Number(usage.output_tokens) || 0);
    if (input + cacheWrite + cacheRead + output <= 0) { continue; }
    out.push({ id, date, model, input, cacheRead, cacheWrite, output });
  }
  return out;
}

function parseCodexContent(content: string): RawEvent[] {
  const out: RawEvent[] = [];
  let currentModel = 'gpt-5.3-codex';
  let prevIn = 0;
  let prevCr = 0;
  let prevCw = 0;
  let prevOut = 0;
  let pos = 0;
  while (pos < content.length) {
    let next = content.indexOf('\n', pos);
    if (next === -1) { next = content.length; }
    const line = content.slice(pos, next);
    pos = next + 1;
    if (!line.includes('"token_count"') && !line.includes('"turn_context"')) { continue; }
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }
    const type = obj?.type;
    const payload = obj?.payload;
    if (type === 'turn_context' && typeof payload?.model === 'string' && payload.model.trim()) {
      currentModel = payload.model.trim();
      continue;
    }
    if (type === 'event_msg' && payload?.type === 'token_count') {
      const tot = payload?.info?.total_token_usage;
      if (!tot) { continue; }
      const totalIn = Math.max(0, Number(tot.input_tokens) || 0);
      const totalCr = Math.max(0, Number(tot.cached_input_tokens) || 0);
      const totalCw = Math.max(0, Number(tot.cache_write_input_tokens) || 0);
      const totalOut = Math.max(0, Number(tot.output_tokens) || 0);
      const dIn = Math.max(0, totalIn - prevIn);
      const dCr = Math.max(0, totalCr - prevCr);
      const dCw = Math.max(0, totalCw - prevCw);
      const dOut = Math.max(0, totalOut - prevOut);
      if (dIn <= 0 && dOut <= 0) { continue; }
      prevIn = totalIn;
      prevCr = totalCr;
      prevCw = totalCw;
      prevOut = totalOut;
      const date = typeof obj.timestamp === 'string' ? obj.timestamp.slice(0, 10) : '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { continue; }
      const uncachedIn = Math.max(0, dIn - dCr - dCw);
      out.push({
        date,
        model: currentModel,
        input: uncachedIn,
        cacheRead: dCr,
        cacheWrite: dCw,
        output: dOut,
      });
    }
  }
  return out;
}
