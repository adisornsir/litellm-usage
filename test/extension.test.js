// End-to-end tests for the extension controller against a mock proxy, with a stubbed `vscode` API.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const http = require('node:http');

// ---- mock LiteLLM proxy ----
let validKeys = new Set();
const calls = [];
const today = new Date().toISOString().slice(0, 10);
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  calls.push(`${req.method} ${url.pathname}${url.search}`);
  calls.push(`${req.method} ${url.pathname}`); // path-only alias for legacy includes() checks
  const json = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (url.pathname === '/sso/cli/start') { return json(200, { login_id: 'L1', poll_secret: 'S', user_code: 'CODE-1' }); }
  if (url.pathname === '/sso/cli/poll/L1') { return json(200, { status: 'ready', key: 'cli-session', user_id: 'dev@example.com' }); }

  const key = (req.headers.authorization ?? '').replace('Bearer ', '');
  if (!validKeys.has(key)) { return json(401, { error: { message: 'expired' } }); }
  switch (url.pathname) {
    case '/key/info':
      return key === 'sk-test'
        ? json(200, { info: { key_alias: 'ci', spend: 3, max_budget: 10, user_id: 'dev@example.com', token: 'h' } })
        : json(404, { detail: 'key not found' });
    case '/v2/user/info': return json(200, {
      user_id: 'dev@example.com', user_email: 'dev@example.com', spend: 7.5, max_budget: 100,
    });
    case '/v1/models': return json(200, { data: [{ id: 'gemini-pro' }] });
    case '/user/daily/activity':
      if (key === 'sk-test') {
        return json(403, { detail: "Virtual key is not allowed to call this route. Only allowed to call routes: ['llm_api_routes', '/key/info', '/v2/user/info']. Tried to call route: /user/daily/activity" });
      }
      return json(200, {
        results: [{ date: today, metrics: { spend: 0.42, total_tokens: 1234, api_requests: 3 }, breakdown: { models: {} } }],
        metadata: { has_more: false },
      });
    default: return json(404, {});
  }
});

// ---- vscode stub ----
const answers = [];
const messages = [];
const opened = [];
const statusItem = { show() {}, dispose() {} };
const commands = {};
const globalState = new Map();
const secrets = new Map();
class Disposable { constructor(fn) { this.fn = fn; } dispose() { this.fn?.(); } }
class MarkdownString { constructor() { this.value = ''; } appendMarkdown(t) { this.value += t; } }
const vscode = {
  Disposable, MarkdownString,
  StatusBarAlignment: { Right: 2 }, ProgressLocation: { Notification: 15 }, QuickPickItemKind: { Separator: -1 }, ViewColumn: { Active: -1 },
  Uri: { parse: u => ({ url: u }), joinPath: () => ({}) },
  env: { openExternal: async uri => { opened.push(uri.url); return true; } },
  workspace: { getConfiguration: () => ({ get: (_k, d) => d }), onDidChangeConfiguration: () => new Disposable() },
  commands: { registerCommand: (id, fn) => { commands[id] = fn; return new Disposable(); } },
  window: {
    createStatusBarItem: () => statusItem,
    registerWebviewViewProvider: () => new Disposable(),
    showInputBox: async o => answers.shift()(o),
    showQuickPick: async (items, o) => answers.shift()(items, o),
    withProgress: async (_o, fn) => fn({ report() {} }, { isCancellationRequested: false }),
    showInformationMessage: async m => { messages.push(m); },
    showErrorMessage: async m => { messages.push(m); },
    showWarningMessage: async m => { messages.push(m); },
  },
};
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  return request === 'vscode' ? vscode : originalLoad.call(this, request, ...rest);
};

const context = {
  subscriptions: [], extensionUri: {},
  globalState: { get: (k, d) => (globalState.has(k) ? globalState.get(k) : d), update: async (k, v) => { globalState.set(k, v); } },
  secrets: { get: async k => secrets.get(k), store: async (k, v) => { secrets.set(k, v); }, delete: async k => { secrets.delete(k); } },
};
const settle = () => new Promise(r => setTimeout(r, 100));
let base;

before(async () => {
  await new Promise(r => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
  await require('../out/extension').activate(context);
  await settle();
});

after(() => {
  context.subscriptions.forEach(d => d.dispose());
  server.close();
});

test('starts signed out', () => {
  assert.equal(statusItem.text, '$(pulse) LiteLLM: Add account');
});

test('adds an SSO account through the browser flow without calling /key/info', async () => {
  validKeys = new Set(['cli-session']);
  answers.push(() => base, items => items.find(i => i.mode === 'sso'), o => o.value);
  await commands['litellm.addAccount']();
  await settle();

  const [account] = globalState.get('accounts');
  assert.equal(account.authMode, 'sso');
  assert.equal(account.userId, 'dev@example.com');
  assert.equal(account.label, `dev@example.com @ ${new URL(base).host}`);
  assert.equal(opened[0], `${base}/sso/key/generate?source=litellm-cli&key=L1`);
  assert.equal(calls.includes('GET /key/info'), false);
  assert.equal(statusItem.text, '$(pulse) $0.42');
  assert.match(statusItem.tooltip.value, /\$7\.50/);
});

test('an expired SSO session asks to sign in again, and re-authentication recovers', async () => {
  validKeys = new Set();
  await commands['litellm.refresh']();
  await settle();
  assert.equal(statusItem.command, 'litellm.reauthenticate');
  assert.match(statusItem.text, /warning/);
  assert.ok(messages.some(m => /SSO session .* has expired/.test(m)));

  validKeys = new Set(['cli-session']);
  await commands['litellm.reauthenticate']();
  await settle();
  assert.equal(statusItem.command, 'litellm.showDashboard');
  assert.equal(statusItem.text, '$(pulse) $0.42');
});

test('adds an API key account and switches to it', async () => {
  validKeys = new Set(['cli-session', 'sk-test']);
  answers.push(() => base, items => items.find(i => i.mode === 'apiKey'), () => 'sk-test', o => o.value);
  await commands['litellm.addAccount']();
  await settle();

  const accounts = globalState.get('accounts');
  assert.equal(accounts.length, 2);
  assert.equal(globalState.get('activeAccount'), accounts[1].id);
  assert.ok(calls.includes('GET /key/info'));
  assert.ok(calls.includes('GET /v2/user/info'));
  assert.equal(statusItem.command, 'litellm.showDashboard', 'a forbidden activity route must not break virtual-key usage');
  assert.equal(statusItem.text, '$(pulse) $0');
  assert.match(statusItem.tooltip.value, /\$7\.50/);
  assert.match(statusItem.tooltip.value, /ci @ .*\n\n.*dev@example\.com/s, 'tooltip lists both accounts');
});

test('an admin key owned by another user: budget and usage stay scoped to the key', async () => {
  // Regression for the admin report: the proxy-wide budget ($1) and the sum of every user's
  // spend ($2.44/day) leaked into the dashboard when the signed-in user ($5 budget, $1.92/day
  // across their own keys) authenticated with a key belonging to someone else.
  const adminKey = 'sk-admin';
  validKeys = new Set([...validKeys, adminKey]);
  calls.length = 0;

  // /key/info for the admin key reports another member's budget ($1) and a key owner that
  // differs from the signed-in user.
  const origHandler = server.listeners('request')[0];
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/key/info'
        && (req.headers.authorization ?? '').replace('Bearer ', '') === adminKey) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ info: { key_alias: 'other-member', spend: 2.44, max_budget: 1, user_id: 'other@example.com', token: 'adminhash' } }));
      return;
    }
    // Signed-in admin user: own budget is $5.
    if (url.pathname === '/v2/user/info') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ user_id: 'other@example.com', user_email: 'other@example.com', spend: 0, max_budget: 5 }));
      return;
    }
    // Whole-proxy usage (what the route returns when unscoped): $2.44/day across all users.
    if (url.pathname === '/user/daily/activity' && !url.searchParams.get('api_key')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ results: [{ date: today, metrics: { spend: 2.44, total_tokens: 9999, api_requests: 42 }, breakdown: { models: {} } }], metadata: { has_more: false } }));
      return;
    }
    // Scoped to the key: only $1.92.
    if (url.pathname === '/user/daily/activity' && url.searchParams.get('api_key') === 'adminhash') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ results: [{ date: today, metrics: { spend: 1.92, total_tokens: 4321, api_requests: 7 }, breakdown: { models: {} } }], metadata: { has_more: false } }));
      return;
    }
    origHandler(req, res);
  });

  answers.push(() => base, items => items.find(i => i.mode === 'apiKey'), () => adminKey, o => o.value);
  await commands['litellm.addAccount']();
  await settle();

  try {
    // Budget card / tooltip shows the signed-in user's $5, not the key owner's $1 cap.
    assert.match(statusItem.tooltip.value, /\/ \$5/, 'user budget wins over the key budget');
    const activityCalls = calls.filter(c => c.startsWith('GET /user/daily/activity'));
    assert.ok(!activityCalls.some(c => !c.includes('api_key=adminhash')),
      `every activity call is scoped to the key, got: ${activityCalls.join(', ')}`);
    assert.equal(statusItem.text, '$(pulse) $1.92', 'today spend is scoped to the key, not proxy-wide');
  } finally {
    server.removeAllListeners('request');
    server.on('request', origHandler);
  }
});
