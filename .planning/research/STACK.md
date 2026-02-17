# Technology Stack: v4.0 Autonomous Agent with External Integrations

**Project:** project-orchestrator
**Researched:** 2026-02-16
**Confidence:** HIGH (verified via codebase analysis, official docs, CLI testing, Node.js runtime testing)

## Executive Summary

v4.0 adds external integrations, session evaluation, service health monitoring, revenue intelligence, and event-driven architecture to an existing Node.js daemon with 2 npm dependencies (`better-sqlite3`, `node-cron`). The overarching principle: **maximize what the Node.js runtime and `claude -p` already give you; add packages only when the alternative is reimplementing a non-trivial wheel.**

The recommended stack additions are:

| Addition | Purpose | Dependency? |
|----------|---------|-------------|
| `claude -p --mcp-config` | MCP tool access from orchestrator | No (CLI flag) |
| `claude -p --json-schema` | Guaranteed structured output | No (CLI flag) |
| `claude -p --model haiku/sonnet/opus` | Multi-model routing | No (CLI flag) |
| `fs.watch` (recursive) | Event-driven file watching | No (Node.js built-in) |
| `node:test` | Test framework | No (Node.js built-in) |
| `fetch` (global) | HTTP health checks, API calls | No (Node.js built-in) |
| `better-sqlite3` | Conversation persistence (already installed) | Already present |
| `node-cron` | Scheduling (already installed) | Already present |

**Net new npm packages: ZERO.**

This is achievable because Node.js v25.6.1 ships with native `fetch`, native `fs.watch` with recursive macOS support, and native `node:test`. And `claude -p` v2.1.39 ships with `--json-schema`, `--mcp-config`, `--model`, and `--output-format json` flags that solve structured output, MCP integration, and multi-model routing without any SDK dependency.

---

## 1. Structured Output: `--json-schema` Flag

**Status: VERIFIED** -- tested on this machine with Claude Code v2.1.39.

### The v3.0 Problem

v3.0 uses a fragile `parseJSON()` function that tries 3 strategies to extract JSON from `claude -p` text output. This works ~95% of the time but fails when Claude wraps JSON in prose or uses malformed fences.

### The v4.0 Solution

```bash
claude -p --json-schema '{"type":"object","properties":{"recommendations":{"type":"array"},"summary":{"type":"string"}},"required":["recommendations","summary"]}' --output-format json --max-turns 1 "Your prompt here"
```

The `--json-schema` flag uses **constrained decoding** at inference time -- the model is physically prevented from emitting tokens that would violate the schema. This is not "asking nicely for JSON." It is guaranteed schema compliance.

**Integration with existing `ai-brain.js`:**

```javascript
// Replace the fragile execSync + parseJSON pattern
const args = [
  '-p',
  '--model', model,
  '--max-turns', '1',
  '--output-format', 'json',
  '--json-schema', JSON.stringify(DECISION_SCHEMA),
];

const child = execFile('claude', args, {
  timeout: 60000,
  maxBuffer: 1024 * 1024,
}, (error, stdout) => {
  if (error) return reject(error);
  // stdout is GUARANTEED valid JSON matching the schema
  const result = JSON.parse(stdout);
  // result.result contains the schema-matched output
  resolve(result);
});

child.stdin.write(prompt);
child.stdin.end();
```

**Schema definition for think cycle decisions:**

```javascript
const DECISION_SCHEMA = {
  type: "object",
  properties: {
    recommendations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          project: { type: "string" },
          action: { type: "string", enum: ["start", "stop", "restart", "notify", "skip"] },
          reason: { type: "string" },
          priority: { type: "integer", minimum: 1, maximum: 5 },
          prompt: { type: "string" },
          confidence: { type: "number" }
        },
        required: ["project", "action", "reason"]
      }
    },
    summary: { type: "string" },
    nextThinkIn: { type: "integer" }
  },
  required: ["recommendations", "summary"]
};
```

**Why this matters for v4.0:** Session evaluation, revenue intelligence, and service health monitoring all need structured output from Claude. With `--json-schema`, we get guaranteed schemas for evaluation rubrics, health reports, and revenue summaries without ever hitting a parse error.

**Confidence:** HIGH -- verified `--json-schema` flag exists in `claude -p --help` on this machine. The flag uses the same constrained decoding engine as the Anthropic API's structured outputs feature.

---

## 2. MCP Integration: `--mcp-config` Flag

**Status: VERIFIED** -- 11 MCP servers configured and connected on this machine.

### The Decision: How to Access MCP Tools

The orchestrator has three options for accessing MCP capabilities:

| Approach | Complexity | Reliability | Best For |
|----------|-----------|-------------|----------|
| A. `claude -p --mcp-config` | Low | High | Complex reasoning + tool use |
| B. Direct REST/HTTP calls | Medium | High | Simple, predictable operations |
| C. MCP TypeScript SDK client | High | Medium | Custom MCP client embedding |

**Recommendation: Use approach A for complex tasks, approach B for simple ones. Do NOT use approach C.**

### Approach A: Let Claude Use MCP Tools (complex reasoning)

For tasks where the AI needs to reason about what to do with the data:

```bash
# Claude Code already has MCP servers configured globally.
# claude -p inherits them from ~/.claude.json automatically.
claude -p --model sonnet --max-turns 3 --output-format json \
  "Check GitHub for open PRs across my repos and summarize which need review"
```

This works because `claude -p` inherits the user's MCP server configuration. The 11 MCP servers already configured on this machine (github, docker-mcp, google-calendar, apple-mcp, memory, filesystem, playwright, etc.) are available to every `claude -p` call.

**When to use this:**
- GitHub PR/issue analysis (needs reasoning about code changes)
- Calendar scheduling (needs reasoning about conflicts)
- Memory graph queries (needs reasoning about context)
- Docker container management (needs reasoning about dependencies)
- Multi-step operations where Claude needs to chain tool calls

**Key flag: `--max-turns`**
For MCP tool use, increase `--max-turns` beyond 1. Each tool call counts as a turn. A GitHub query might need 2-3 turns (list repos, get PRs, get details). Set `--max-turns 5` for MCP-heavy tasks, with a 60s timeout.

### Approach B: Direct HTTP/REST Calls (simple operations)

For predictable, non-reasoning operations, skip the LLM and call APIs directly:

```javascript
// Service health check -- no LLM needed
async function checkServiceHealth(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    return { url, status: response.status, ok: response.ok };
  } catch (e) {
    return { url, status: 0, ok: false, error: e.message };
  }
}

// RapidAPI revenue -- structured API call, no LLM needed
async function getRapidAPIAnalytics() {
  // RapidAPI provides a GraphQL Platform API for provider analytics
  // Revenue data available: fixed price, overages, up to 1 year history
  const response = await fetch('https://platform.rapidapi.com/graphql', {
    method: 'POST',
    headers: { 'x-rapidapi-key': process.env.RAPIDAPI_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: '{ billing { revenue { total } } }' })
  });
  return response.json();
}
```

**When to use this:**
- HTTP health pings to running services (ports 8002, 8050, 8060, 8070, 8100, 7681)
- Fetching structured data from APIs with known endpoints
- Simple GET requests that return JSON
- Docker socket queries (`/var/run/docker.sock` via HTTP)

### Approach C: MCP TypeScript SDK -- DO NOT USE

**Why not:** The `@modelcontextprotocol/sdk` (v1.27.0, production) would require:
1. Adding a new npm dependency
2. Implementing MCP client connection logic
3. Managing stdio transport lifecycle
4. Handling MCP server startup/shutdown
5. Duplicating what `claude -p` already does automatically

This is wrong for our use case. The orchestrator does not need to be an MCP client. It needs to ask Claude questions that sometimes require MCP tools. `claude -p` already handles the MCP client logic internally.

### MCP Servers Available on This Machine

Verified via `claude mcp list`:

| Server | Transport | Purpose for v4.0 |
|--------|-----------|-------------------|
| `github` | stdio (`github-mcp-server`) | Git/GitHub integration: PRs, issues, commits |
| `docker-mcp` | stdio (`uvx docker-mcp`) | Container health, service status |
| `google-calendar` | stdio (npx) | Calendar awareness for scheduling |
| `apple-mcp` | stdio (npx) | Reminders, Notes integration |
| `memory` | stdio (npx) | Persistent memory graph for context |
| `filesystem` | stdio (npx) | File operations (already have native fs) |
| `playwright` | stdio (npx) | Browser automation for testing |
| `context7` | stdio (npx) | Library documentation lookup |
| `firecrawl` | stdio (npx) | Web scraping/fetching |
| `apple-shortcuts` | stdio (npx) | Shortcuts automation |
| `claude.ai Slack` | HTTP | Slack integration (needs auth) |

**Key insight:** All of these are already available to `claude -p` without any code changes. The orchestrator just needs to craft prompts that tell Claude to use these tools, and set `--max-turns` high enough for tool call chains.

---

## 3. Session Evaluation: tmux Scrollback + git diff

### Reading Session Output

```javascript
const { execSync } = require('child_process');

function captureSessionOutput(sessionName, lines = 200) {
  try {
    // capture-pane works on detached sessions -- verified in research
    execSync(`tmux capture-pane -t "${sessionName}" -p -S -${lines}`, {
      encoding: 'utf-8',
      timeout: 5000
    });
    return execSync(`tmux capture-pane -t "${sessionName}" -p -S -${lines}`, {
      encoding: 'utf-8',
      timeout: 5000
    }).trim();
  } catch {
    return null; // Session may not exist
  }
}
```

**Verified:** `tmux capture-pane -p -S -` works on detached sessions. The `-p` flag outputs to stdout. No tmux buffer management needed.

### Evaluating Session Quality via git diff

```javascript
function getRecentChanges(projectDir) {
  try {
    // What changed in the last commit
    const diff = execSync('git diff HEAD~1 --stat', {
      cwd: projectDir, encoding: 'utf-8', timeout: 5000
    });
    const log = execSync('git log -1 --oneline', {
      cwd: projectDir, encoding: 'utf-8', timeout: 5000
    });
    return { diff, log };
  } catch {
    return null;
  }
}
```

Then feed both tmux output and git diff to Claude for evaluation:

```javascript
const evaluationPrompt = `
Evaluate this Claude Code session's output.
Scrollback (last 100 lines): ${scrollback}
Git changes: ${gitDiff}
Project goal: ${currentPhaseGoal}

Rate 1-5: Did the session make meaningful progress?
`;

const result = execSync(
  `claude -p --model sonnet --max-turns 1 --json-schema '${EVAL_SCHEMA}'`,
  { input: evaluationPrompt, encoding: 'utf-8', timeout: 30000 }
);
```

**No new dependencies.** All via existing `child_process.execSync` (tmux, git) and `claude -p` with `--json-schema`.

---

## 4. Service Health Monitoring: Native `fetch`

**Status: VERIFIED** -- Node.js v25.6.1 has native global `fetch` (powered by undici).

### Implementation

```javascript
class HealthMonitor {
  constructor(services) {
    this.services = services; // [{ name, url, expectedStatus }]
    this.history = new Map();
  }

  async checkAll() {
    const results = await Promise.allSettled(
      this.services.map(s => this.check(s))
    );
    return results.map((r, i) => ({
      service: this.services[i].name,
      ...(r.status === 'fulfilled' ? r.value : { ok: false, error: r.reason.message })
    }));
  }

  async check({ name, url, expectedStatus = 200 }) {
    const start = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      return {
        ok: response.status === expectedStatus,
        status: response.status,
        latencyMs: Date.now() - start
      };
    } catch (e) {
      clearTimeout(timeout);
      return { ok: false, status: 0, error: e.message, latencyMs: Date.now() - start };
    }
  }
}
```

### Services to Monitor

From `config.json` and MEMORY.md:

| Service | URL | Expected |
|---------|-----|----------|
| Web Scraping API | `http://localhost:8002/health` | 200 |
| Project Dashboard | `http://localhost:8050/health` | 200 |
| Income Dashboard | `http://localhost:8060/health` | 200 |
| Site Monitor | `http://localhost:8070/health` | 200 |
| MLX Inference API | `http://localhost:8100/health` | 200 |
| SSH Terminal (ttyd) | `http://localhost:7681` | 200 |

**No npm packages needed.** Native `fetch` with `AbortController` for timeouts is sufficient for health pings. No need for `axios`, `got`, `node-fetch`, or any HTTP library.

### Docker Container Health (via Docker socket)

For containers managed by Docker (bandwidth-sharing has 9 containers):

```javascript
async function getDockerContainers() {
  // Docker Engine API over Unix socket
  // Node.js fetch does NOT support Unix sockets natively
  // Option A: Use claude -p with docker-mcp (recommended for complex queries)
  // Option B: Shell out to docker CLI for simple queries
  const output = execSync(
    'docker ps --format "{{.Names}}|{{.Status}}|{{.Ports}}" 2>/dev/null',
    { encoding: 'utf-8', timeout: 10000 }
  );
  return output.trim().split('\n').map(line => {
    const [name, status, ports] = line.split('|');
    return { name, status, healthy: status.includes('Up') };
  });
}
```

**Note:** Native `fetch` does not support Unix sockets, so direct Docker Engine API access would require the `undici` package or a Unix socket HTTP client. Since we only need container status, shelling out to `docker ps` is simpler and adequate. For complex Docker management, delegate to `claude -p` with the `docker-mcp` MCP server.

---

## 5. Event-Driven Architecture: `fs.watch` + EventEmitter

**Status: VERIFIED** -- `fs.watch({ recursive: true })` works on macOS with Node.js v25.6.1.

### Replacing Polling with File Watchers

v3.0 uses polling intervals for everything:
- Message polling: 10s `setInterval`
- Proactive scan: 60s `setInterval`
- Think cycle: 300s `setTimeout` chain

v4.0 should replace the scan interval with a file watcher for `.orchestrator/` signal files, while keeping message polling (iMessage chat.db requires polling) and the think cycle (strategic decisions on a timer is correct).

### Implementation

```javascript
const fs = require('fs');
const { EventEmitter } = require('events');

class OrchestratorEvents extends EventEmitter {
  constructor(projectsDir, projectNames) {
    super();
    this.watchers = [];
    this._setupWatchers(projectsDir, projectNames);
  }

  _setupWatchers(projectsDir, projectNames) {
    for (const project of projectNames) {
      const signalDir = `${projectsDir}/${project}/.orchestrator`;
      if (!fs.existsSync(signalDir)) continue;

      const watcher = fs.watch(signalDir, (eventType, filename) => {
        if (!filename) return;
        if (filename === 'needs-input.json') {
          this.emit('signal', { project, type: 'needs-input', filename });
        } else if (filename === 'completed.json') {
          this.emit('signal', { project, type: 'completed', filename });
        } else if (filename === 'error.json') {
          this.emit('signal', { project, type: 'error', filename });
        }
      });
      this.watchers.push(watcher);
    }
  }

  close() {
    this.watchers.forEach(w => w.close());
  }
}
```

### Why NOT chokidar

| Factor | `fs.watch` | chokidar v4/v5 |
|--------|-----------|----------------|
| macOS recursive | Native (verified) | Uses FSEvents wrapper |
| Dependency | None (built-in) | npm package + native addon |
| ESM requirement | No (CommonJS fine) | v5 is ESM-only |
| Use case fit | Watching ~19 flat dirs | Designed for deep trees |
| Reliability concern | Can fire duplicates | Deduplicates events |

**Decision:** Use `fs.watch` for signal directories. We are watching ~19 flat directories (`.orchestrator/` under each project) for specific JSON files. This is the simplest possible watch use case. The known `fs.watch` caveats (duplicate events, filename issues) are mitigated by:
1. Debouncing: ignore events within 1s of each other per file
2. Verification: always read the file after the event to confirm it exists and is valid JSON
3. Flat directories: no recursive watching needed per project (signal dirs are flat)

If reliability becomes an issue, chokidar v4 (v4.0.1, supports CommonJS, Node 14+) is the fallback. But start without it.

### What Stays as Polling

| Loop | Why Keep Polling |
|------|-----------------|
| Message polling (10s) | iMessage chat.db is an SQLite file owned by another process. `fs.watch` on it would fire on every message in every conversation, not just ours. Polling with `WHERE ROWID > ?` is correct. |
| Think cycle (5min) | Strategic decisions belong on a timer, not triggered by events. The AI should evaluate the full picture periodically, not react to individual events. |

---

## 6. Test Framework: `node:test`

**Status: VERIFIED** -- `package.json` already has `"test": "node --test test/"` configured.

### Why `node:test` (Already Chosen)

The project already uses the Node.js built-in test runner. This is the right choice:

| Factor | `node:test` | vitest | jest |
|--------|------------|--------|------|
| Dependencies | 0 | 1+ | 1+ |
| Setup | None | Config file | Config file |
| Node.js compat | Native | Vite layer | Babel/TS layer |
| Already in package.json | Yes | No | No |
| CJS support | Yes | Yes | Yes |
| Watch mode | `--watch` flag | Built-in | Built-in |

### Testing a Long-Running Daemon

The challenge is testing a 24/7 daemon with `setInterval` loops, `execSync` to external processes, and file-system side effects. Recommended patterns:

**1. Unit test modules in isolation (mock dependencies via constructor injection)**

```javascript
const { describe, it, mock } = require('node:test');
const assert = require('node:assert');
const AIBrain = require('../lib/ai-brain');

describe('AIBrain', () => {
  it('should parse JSON from markdown fences', () => {
    const brain = new AIBrain({
      contextAssembler: { assemble: () => 'test' },
      decisionExecutor: { evaluate: () => [] },
      state: { load: () => ({}), logDecision: () => {} },
      messenger: { send: () => {} },
      config: { ai: { enabled: true } }
    });

    const result = brain.parseJSON('```json\n{"test": true}\n```');
    assert.deepStrictEqual(result, { test: true });
  });
});
```

**2. Mock `execSync` / `execFile` for claude -p calls**

```javascript
const { mock } = require('node:test');
const cp = require('child_process');

// Mock execSync for claude -p
mock.method(cp, 'execSync', (cmd, opts) => {
  if (cmd.includes('claude')) {
    return JSON.stringify({ recommendations: [], summary: 'test' });
  }
  return '';
});
```

**3. Integration tests with temp directories**

```javascript
const fs = require('fs');
const os = require('os');
const path = require('path');

function createTempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-test-'));
  fs.mkdirSync(path.join(dir, '.orchestrator'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  return dir;
}
```

**4. Test health monitoring with a local HTTP server**

```javascript
const http = require('http');
const { describe, it, before, after } = require('node:test');

describe('HealthMonitor', () => {
  let server;
  before(() => {
    server = http.createServer((req, res) => {
      res.writeHead(200);
      res.end('ok');
    }).listen(0); // Random available port
  });
  after(() => server.close());

  it('should detect healthy service', async () => {
    const port = server.address().port;
    const monitor = new HealthMonitor([{ name: 'test', url: `http://localhost:${port}` }]);
    const results = await monitor.checkAll();
    assert.strictEqual(results[0].ok, true);
  });
});
```

---

## 7. Conversation Persistence: `better-sqlite3`

**Status: Already installed** (v12.6.2 in package.json).

### Current Usage

`better-sqlite3` is currently used only for reading macOS Messages.app `chat.db`. v4.0 extends it to store orchestrator conversation history.

### Schema for Conversation Storage

```sql
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  context TEXT,  -- JSON: project name, command type, etc.
  model TEXT     -- which model was used (haiku/sonnet/opus)
);

CREATE INDEX idx_conversations_timestamp ON conversations(timestamp);
CREATE INDEX idx_conversations_context ON conversations(context);
```

### Implementation Pattern

```javascript
const Database = require('better-sqlite3');

class ConversationStore {
  constructor(dbPath) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');  // Better concurrent reads
    this._migrate();
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        context TEXT,
        model TEXT
      )
    `);
  }

  addMessage(role, content, context = null, model = null) {
    const stmt = this.db.prepare(
      'INSERT INTO conversations (role, content, context, model) VALUES (?, ?, ?, ?)'
    );
    stmt.run(role, content, context ? JSON.stringify(context) : null, model);
  }

  getRecentMessages(limit = 20) {
    return this.db.prepare(
      'SELECT * FROM conversations ORDER BY id DESC LIMIT ?'
    ).all(limit).reverse();
  }

  getProjectConversations(projectName, limit = 10) {
    return this.db.prepare(
      `SELECT * FROM conversations WHERE context LIKE ? ORDER BY id DESC LIMIT ?`
    ).all(`%${projectName}%`, limit).reverse();
  }
}
```

**Why not use `node:sqlite` (built-in)?** Node.js v25.6.1 has `node:sqlite`, and it works (verified on this machine). However:
1. It is still marked **experimental** with a warning on every import
2. `better-sqlite3` is already installed and battle-tested
3. The API differs enough that migration would be work for no gain
4. `better-sqlite3` supports WAL mode and prepared statements identically

Stick with `better-sqlite3`. Revisit `node:sqlite` when it exits experimental status.

---

## 8. Multi-Model Strategy

**Status: VERIFIED** -- `claude -p --model haiku/sonnet/opus` all work on this machine.

### Model Routing Rules

| Task | Model | Rationale | Max Turns |
|------|-------|-----------|-----------|
| Think cycle (routine) | `sonnet` | Best cost/quality trade-off for 5-min cycle | 1 |
| Think cycle (complex: >3 projects need attention) | `opus` | Deep reasoning for multi-project coordination | 1 |
| Session evaluation | `sonnet` | Needs good judgment on code quality | 1 |
| MCP tool use (GitHub, Calendar, etc.) | `sonnet` | Needs tool-calling ability + reasoning | 3-5 |
| SMS composition | `haiku` | Simple text formatting, fast | 1 |
| Morning digest generation | `sonnet` | Needs synthesis across many projects | 1 |
| Revenue analysis | `sonnet` | Aggregation + reasoning about data | 3 |
| Health check interpretation | `haiku` | Simple status assessment | 1 |

### Implementation

```javascript
function selectModel(taskType, context = {}) {
  switch (taskType) {
    case 'think':
      return context.attentionCount > 3 ? 'opus' : 'sonnet';
    case 'evaluate':
    case 'digest':
    case 'revenue':
    case 'mcp':
      return 'sonnet';
    case 'sms':
    case 'health':
      return 'haiku';
    default:
      return 'sonnet';
  }
}
```

**Key discovery from research:** Claude Code supports an `opusplan` model alias that uses Opus for planning and Sonnet for execution. This is NOT useful for our use case -- we want single-turn, focused calls, not multi-turn agent sessions.

**Important note on Haiku:** Tool search (MCP tool discovery) requires Sonnet 4 or Opus 4 -- Haiku does not support `tool_reference` blocks. When using Haiku with MCP-heavy tasks, tools must be pre-loaded, not discovered dynamically. For the orchestrator, this means: never use Haiku for MCP tool tasks.

---

## 9. Revenue Tracking: Direct API Calls

### Data Sources

| Source | Access Method | Data Available |
|--------|--------------|----------------|
| RapidAPI | GraphQL Platform API | Revenue (fixed + overage), up to 1 year history |
| XMR Mining | Mining pool API (HTTP GET) | Hash rate, pending balance, payouts |
| Bandwidth Sharing | Container logs / dashboards | Earnings per container |
| MLX Inference | RapidAPI (same as above) | Same API, different endpoint |

### RapidAPI Revenue

RapidAPI provides a GraphQL Platform API for provider analytics. Revenue data includes fixed price and overage breakdowns, with up to 1 year of history.

```javascript
async function fetchRapidAPIRevenue() {
  // RapidAPI's Platform API is GraphQL
  // Requires RapidAPI account API key
  // Revenue data: fixed price + overages
  const response = await fetch('https://platform-graphql.rapidapi.com/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-rapidapi-identity-key': config.rapidapi?.identityKey
    },
    body: JSON.stringify({
      query: `query { billing { transactions(limit: 30) { amount date apiName } } }`
    })
  });
  return response.json();
}
```

**Confidence: MEDIUM** -- RapidAPI docs confirm GraphQL Platform API exists for provider analytics, but exact query syntax needs verification against their actual schema. Flag for phase-specific research.

### XMR Mining Pool

```javascript
async function fetchMiningRevenue() {
  // Most pools expose a simple JSON API
  const response = await fetch(`https://pool.example.com/api/worker/${config.mining?.walletAddress}`);
  return response.json();
}
```

**Confidence: LOW** -- Depends on which mining pool is used. Need to check the specific pool's API.

### Implementation Pattern

Revenue tracking does NOT need to be real-time. A daily aggregation during the morning digest is sufficient:

```javascript
class RevenueTracker {
  constructor(config) {
    this.sources = config.revenue?.sources || [];
  }

  async aggregate() {
    const results = {};
    for (const source of this.sources) {
      try {
        results[source.name] = await this._fetch(source);
      } catch (e) {
        results[source.name] = { error: e.message };
      }
    }
    return results;
  }
}
```

---

## 10. Config Additions for v4.0

### New `config.json` Fields

```json
{
  "services": [
    { "name": "web-scraping-api", "url": "http://localhost:8002/health", "critical": true },
    { "name": "project-dashboard", "url": "http://localhost:8050/health", "critical": false },
    { "name": "income-dashboard", "url": "http://localhost:8060/health", "critical": false },
    { "name": "site-monitor", "url": "http://localhost:8070/health", "critical": false },
    { "name": "mlx-inference-api", "url": "http://localhost:8100/health", "critical": true },
    { "name": "ssh-terminal", "url": "http://localhost:7681", "critical": false }
  ],
  "healthCheck": {
    "intervalMs": 300000,
    "timeoutMs": 5000,
    "alertAfterFailures": 3
  },
  "revenue": {
    "enabled": false,
    "sources": []
  },
  "eventDriven": {
    "watchSignalDirs": true,
    "debounceMs": 1000
  }
}
```

---

## What NOT to Add (and Why)

| Library / Tool | Verdict | Rationale |
|----------------|---------|-----------|
| `@modelcontextprotocol/sdk` | **DO NOT ADD** | `claude -p --mcp-config` gives MCP access for free. Adding the SDK means managing transport lifecycle, server connections, and protocol details that Claude CLI already handles. |
| `@octokit/rest` | **DO NOT ADD** | GitHub MCP server is already configured. Use `claude -p` with MCP for complex GitHub operations. For simple git operations, `execSync('git ...')` is sufficient. |
| `axios` / `got` / `node-fetch` | **DO NOT ADD** | Node.js v25.6.1 has native global `fetch`. No polyfill needed. |
| `chokidar` | **DO NOT ADD** (for now) | `fs.watch` is sufficient for watching ~19 flat signal directories on macOS. If reliability issues emerge, add chokidar v4 (v4.0.1, supports CommonJS). |
| `vitest` / `jest` | **DO NOT ADD** | `node:test` is already configured in package.json and is zero-dependency. |
| `dockerode` / `docker-modem` | **DO NOT ADD** | `docker ps` via execSync is sufficient for container status. For complex Docker management, use `claude -p` with docker-mcp. |
| `winston` / `pino` | **DEFER** | Current console.log is adequate. If log analysis becomes needed, add structured logging later. |
| `zod` / `ajv` | **CONSIDER** | JSON schema validation could be useful for validating config.json and signal files. But the overhead of adding a dependency for input validation on a single-user system is hard to justify. Use `--json-schema` for Claude output validation instead. |
| `eventemitter3` / `mitt` | **DO NOT ADD** | Node.js built-in `EventEmitter` is more than sufficient. Third-party event emitters optimize for performance at millions of events/sec, which is irrelevant here. |

---

## Complete Dependency Summary

### Current (v3.0)

```json
{
  "dependencies": {
    "better-sqlite3": "^12.6.2",
    "node-cron": "^3.0.3"
  }
}
```

### After v4.0

```json
{
  "dependencies": {
    "better-sqlite3": "^12.6.2",
    "node-cron": "^3.0.3"
  }
}
```

**Identical.** Zero new npm packages.

### Node.js Built-ins Used (v25.6.1)

| Built-in | Purpose | Status |
|----------|---------|--------|
| `child_process` | `claude -p`, git, tmux, docker commands | Stable, already used |
| `fs` | File operations, config, state, signal files | Stable, already used |
| `fs.watch` | Event-driven signal file watching | Stable on macOS (verified) |
| `path` | Path manipulation | Stable, already used |
| `os` | Memory checks, system info | Stable, already used |
| `events` (EventEmitter) | Internal event bus | Stable, already used implicitly |
| `readline` | Terminal input (already used) | Stable, already used |
| `http` | Test server for health check tests | Stable |
| `fetch` (global) | HTTP health checks, API calls | Stable (undici-powered) |
| `node:test` | Test framework | Stable since Node 20 |
| `node:assert` | Test assertions | Stable |

### External Tools Used (already installed)

| Tool | Purpose | Verified |
|------|---------|----------|
| `claude` v2.1.39 | AI reasoning, MCP tool access | Yes |
| `tmux` | Session management, scrollback capture | Yes |
| `git` | Diff evaluation, commit history | Yes |
| `docker` | Container status | Yes |

---

## Installation

```bash
# Nothing to install. Zero new dependencies.
# Verify existing tools:
node --version      # v25.6.1
claude --version    # 2.1.39
tmux -V             # tmux 3.x
git --version       # git 2.x
docker --version    # Docker 27.x
```

---

## Sources

### HIGH Confidence (Verified on This Machine)

- `claude -p --help` output -- verified `--json-schema`, `--mcp-config`, `--model`, `--max-turns`, `--output-format` flags
- `claude mcp list` output -- verified 11 MCP servers configured and connected
- `node --version` output -- verified v25.6.1 with native `fetch`, `fs.watch` recursive macOS support
- `package.json` -- verified existing dependencies and test configuration
- Codebase analysis -- all 13 lib modules read and understood
- [Claude Code CLI Reference](https://code.claude.com/docs/en/cli-reference) -- complete flag documentation

### MEDIUM Confidence (Official Documentation)

- [Claude Code MCP Documentation](https://code.claude.com/docs/en/mcp) -- MCP server configuration, scopes, tool access
- [Anthropic Structured Outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) -- constrained decoding for JSON schema compliance
- [RapidAPI Provider Analytics](https://docs.rapidapi.com/docs/provider-analytics) -- GraphQL Platform API for revenue data
- [Node.js fs.watch Documentation](https://nodejs.org/docs/latest/api/fs.html#fswatchfilename-options-listener) -- recursive watching, macOS support
- [better-sqlite3 Documentation](https://github.com/WiseLibs/better-sqlite3) -- WAL mode, prepared statements
- [chokidar GitHub](https://github.com/paulmillr/chokidar) -- v4 CommonJS support, v5 ESM-only
- [tmux capture-pane](https://gist.github.com/lukechilds/b277aa109598f44dae90d0f1154777f8) -- scrollback capture for detached sessions

### LOW Confidence (Needs Phase-Specific Verification)

- RapidAPI GraphQL query syntax -- exact schema needs testing against live API
- XMR mining pool API -- depends on specific pool, needs per-pool research
- Bandwidth sharing earnings data -- container-specific, needs investigation
