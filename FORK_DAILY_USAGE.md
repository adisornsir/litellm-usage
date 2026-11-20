# Gosoft LiteLLM Usage: Daily and Monthly

Upstream: mesutpiskin/litellm-usage v0.7.4 (MIT license).

This fork adds Daily / Monthly usage windows from GET /key/info budget_limits and budget_limits_usage.
Also supports the standard max_budget + budget_duration virtual key settings. It displays
spend / limit / remaining / reset and 80% / 90% warnings. Unknown data appears as N/A, never $0.
Original dashboard, SSO, multi-account, model breakdown and other usage features are preserved.

Install from VSIX in VS Code Extensions > ... > Install from VSIX. Disable the upstream extension
before installing this fork because command and view IDs are unchanged. Use a LiteLLM virtual key,
not a master key. Optional setting: litellm.statusBar = dailyBudget.

LiteLLM v1.101.0+ provides multi-window budget_limits_usage. Older proxies may show N/A.
Key budgets must not be combined with user or team budgets without an authoritative counter.
For production, test the extension against your actual corporate proxy response.

Build: npm ci && npm test && npm run package
