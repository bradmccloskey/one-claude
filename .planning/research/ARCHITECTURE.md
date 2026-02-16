# Architecture Patterns

**Domain:** AI-powered orchestrator layer for an existing Node.js process manager
**Researched:** 2026-02-15
**Confidence:** HIGH (architecture based on official Anthropic guidance + deep codebase analysis)

## Executive Summary

The existing orchestrator (v2.0) is a clean, well-factored process manager with clear component boundaries. The AI layer (v3.0) should integrate as a **new decision engine module** that sits between the data-gathering components (scanner, process-monitor, signal-protocol) and the action-taking components (session-manager, messenger). It does NOT replace the existing architecture -- it adds a "brain" that consumes the same data the human currently reads via SMS, and produces the same commands the human currently types.

The key insight: **the AI layer is a replacement for the human in the loop, not a replacement for the process manager.** It reads status, makes decisions, and issues commands -- the same interface the SMS user has today.

---

## Current Architecture (v2.0)

```
                    +------------------+
                    |    index.js      |
                    |   Main Loop      |
                    +--------+---------+
                             |
              +--------------+--------------+
              |              |              |
     pollMessages()   proactiveScan()   scheduler
     (10s interval)   (60s interval)    (cron)
              |              |              |
              v              v              v
     +--------+----+  +-----+------+  +----+------+
     | messenger   |  | scanner    |  | scheduler |
     | (iMessage)  |  | (STATE.md) |  | (digest)  |
     +--------+----+  +-----+------+  +-----------+
              |              |
              v              v
     +--------+----+  +-----+------+
     | commands    |  | signal-    |
     | (router)    |  | protocol   |
     +--------+----+  +-----+------+
              |              |
              v              v
     +--------+----+  +-----+------+
     | session-    |  | process-   |
     | manager     |  | monitor    |
     | (tmux)      |  | (ps aux)   |
     +-------------+  +------------+

     +-------------+
     | state       |
     | (.state.json)|
     +-------------+
```

### Current Data Flows

1. **Inbound SMS** -> `messenger.getNewMessages()` -> `commands.route()` -> action (start/stop/status/reply)
2. **Proactive scan** -> `scanner.scanAll()` + `signalProtocol.scanSignals()` -> compare to last state -> `messenger.send()` alert
3. **Morning digest** -> `scanner.scanAll()` + `processMonitor.checkProjects()` -> `digest.format()` -> `messenger.send()`
4. **Session lifecycle** -> `sessionManager.startSession()` -> tmux + Claude Code -> `.orchestrator/` signal files -> picked up by scan

### Key Observation

The current system has a clean **data gathering layer** (scanner, processMonitor, signalProtocol) and a clean **action layer** (sessionManager, messenger). The human is the decision layer in between. The AI replaces that human decision layer.

---

## Recommended Architecture (v3.0)

### High-Level: The AI Think Cycle

```
                    +------------------+
                    |    index.js      |
                    |   Main Loop      |
                    +--------+---------+
                             |
              +--------------+------------------+
              |              |              |    |
     pollMessages()   proactiveScan()  scheduler  aiThinkCycle()
     (10s)            (60s)            (cron)     (5min)
              |              |              |         |
              v              v              v         v
     +--------+----+  +-----+------+  +---------+  +-----------+
     | messenger   |  | scanner    |  |scheduler|  | AI BRAIN  |
     | (iMessage)  |  | (STATE.md) |  | (digest)|  | (NEW)     |
     +--------+----+  +-----+------+  +---------+  +-----+-----+
              |              |                            |
              v              v                            v
     +--------+----+  +-----+------+              +------+------+
     | commands    |  | signal-    |              | context-    |
     | (router)    |  | protocol   |              | assembler   |
     +--------+----+  +-----+------+              | (NEW)       |
              |              |                     +------+------+
              v              v                            |
     +--------+----+  +-----+------+              +------+------+
     | session-    |  | process-   |              | decision-   |
     | manager     |  | monitor    |              | executor    |
     | (tmux)      |  | (ps aux)   |              | (NEW)       |
     +-------------+  +------------+              +------+------+
                                                         |
     +-------------+  +-------------+              +-----+------+
     | state       |  | cost-       |              | Uses:      |
     | (.state.json)| | tracker     |              | sessionMgr |
     +-------------+  | (NEW)       |              | messenger  |
                       +-------------+              | commands   |
                                                    +------------+
```

### New Components

| Component | File | Purpose | Depends On |
|-----------|------|---------|------------|
| **AI Brain** | `lib/ai-brain.js` | Orchestrates the think cycle: gather context, call Claude API, execute decisions | context-assembler, decision-executor, cost-tracker |
| **Context Assembler** | `lib/context-assembler.js` | Gathers all project/session state into a structured prompt for Claude | scanner, processMonitor, signalProtocol, sessionManager, state |
| **Decision Executor** | `lib/decision-executor.js` | Parses Claude's structured response and executes actions | sessionManager, messenger, signalProtocol, commands |
| **Cost Tracker** | `lib/cost-tracker.js` | Tracks API token usage, enforces daily/monthly budgets, logs costs | state (extends .state.json) |

### Modified Components

| Component | Change | Why |
|-----------|--------|-----|
| **index.js** | Add `aiThinkCycle()` interval (5 min default) | New polling loop for AI decisions |
| **commands.js** | Add `ai on/off`, `ai status`, `budget` commands | Human override and monitoring |
| **state.js** | Extend state with AI decision history, cost tracking | Persist AI decisions and budget |
| **config.json** | Add `ai` section (model, budget, interval, enabled) | Configuration for AI layer |

### Unchanged Components

| Component | Why Unchanged |
|-----------|--------------|
| **messenger.js** | AI uses same send interface as existing code |
| **scanner.js** | AI reads same STATE.md data as existing proactive scan |
| **signal-protocol.js** | AI reads same signals as existing scan |
| **process-monitor.js** | AI checks same process status |
| **session-manager.js** | AI issues same start/stop/restart commands |
| **scheduler.js** | AI think cycle is a separate interval, not cron |
| **digest.js** | Morning digest stays as-is; AI summaries are separate |

---

## Component Details

### 1. AI Brain (`lib/ai-brain.js`)

The central orchestration point for AI decision-making. Runs on a configurable interval (default: 5 minutes).

```javascript
class AIBrain {
  constructor({ contextAssembler, decisionExecutor, costTracker, config }) {
    this.contextAssembler = contextAssembler;
    this.decisionExecutor = decisionExecutor;
    this.costTracker = costTracker;
    this.config = config;
    this.anthropic = new Anthropic({ apiKey: config.ai.apiKey });
    this.enabled = config.ai.enabled;
    this.lastThinkResult = null;
  }

  async think() {
    if (!this.enabled) return null;
    if (this.costTracker.isOverBudget()) {
      this.enabled = false;
      return { action: 'budget-exceeded', details: this.costTracker.getSummary() };
    }

    // 1. Gather context
    const context = this.contextAssembler.assemble();

    // 2. Call Claude API
    const response = await this.anthropic.messages.create({
      model: this.config.ai.model,  // 'claude-haiku-4-5' for routine, 'claude-sonnet-4-5' for complex
      max_tokens: 2048,
      system: this._buildSystemPrompt(),  // Cached via cache_control
      messages: [{ role: 'user', content: context }],
    });

    // 3. Track cost
    this.costTracker.record(response.usage);

    // 4. Parse and execute decisions
    const decisions = this._parseDecisions(response.content);
    const results = await this.decisionExecutor.execute(decisions);

    this.lastThinkResult = { timestamp: new Date(), decisions, results };
    return this.lastThinkResult;
  }
}
```

**Design rationale:**
- The think cycle is **event-loop-friendly** -- it is async and does not block the existing poll/scan intervals
- It runs on its own interval, independent of message polling (10s) and proactive scanning (60s)
- The AI brain is a consumer of existing data, not a replacement for existing scanners
- The brain can be enabled/disabled at runtime via SMS command

### 2. Context Assembler (`lib/context-assembler.js`)

Gathers all orchestrator state into a structured prompt. This is the "eyes" of the AI -- everything it knows comes through here.

```javascript
class ContextAssembler {
  constructor({ scanner, processMonitor, signalProtocol, sessionManager, state, config }) {
    this.scanner = scanner;
    this.processMonitor = processMonitor;
    this.signalProtocol = signalProtocol;
    this.sessionManager = sessionManager;
    this.state = state;
    this.config = config;
  }

  assemble() {
    const projects = this.scanner.scanAll();
    const processStatus = this.processMonitor.checkProjects(this.config.projects);
    const signals = this.signalProtocol.scanSignals(this.config.projects);
    const sessions = this.sessionManager.getSessionStatuses();
    const s = this.state.load();

    return this._formatContext({
      timestamp: new Date().toISOString(),
      activeSessions: sessions,
      maxSessions: this.config.maxConcurrentSessions,
      projects: projects.map(p => ({
        name: p.name,
        status: p.status,
        phase: p.phase,
        totalPhases: p.totalPhases,
        progress: p.progress,
        blockers: p.blockers,
        nextSteps: p.nextSteps,
        needsAttention: p.needsAttention,
        attentionReason: p.attentionReason,
        processRunning: processStatus[p.name]?.running || false,
        hasActiveSession: sessions.some(s => s.projectName === p.name),
        coreValue: p.coreValue,
      })),
      pendingSignals: signals,
      recentDecisions: s.aiDecisionHistory?.slice(-5) || [],
      budget: this.costTracker?.getSummary() || null,
    });
  }

  _formatContext(data) {
    // Format as structured text for the LLM
    // Compact but readable -- minimize tokens while preserving all info
    let ctx = `# Orchestrator State (${data.timestamp})\n\n`;
    ctx += `## Sessions: ${data.activeSessions.length}/${data.maxSessions} active\n`;
    // ... format projects, signals, etc.
    return ctx;
  }
}
```

**Design rationale:**
- Reuses ALL existing data-gathering modules -- scanner, processMonitor, signalProtocol
- Formats data compactly to minimize token usage (this runs every 5 minutes, tokens matter)
- Includes recent decision history so the AI has memory across think cycles
- Context is assembled synchronously (all data is local file/process reads) before the async API call

### 3. Decision Executor (`lib/decision-executor.js`)

Parses the AI's structured response and maps decisions to existing orchestrator actions.

```javascript
class DecisionExecutor {
  constructor({ sessionManager, signalProtocol, messenger, commands }) {
    this.sessionManager = sessionManager;
    this.signalProtocol = signalProtocol;
    this.messenger = messenger;
    this.commands = commands;
  }

  async execute(decisions) {
    const results = [];
    for (const decision of decisions) {
      try {
        const result = await this._executeOne(decision);
        results.push({ decision, result, success: true });
      } catch (e) {
        results.push({ decision, error: e.message, success: false });
      }
    }
    return results;
  }

  async _executeOne(decision) {
    switch (decision.action) {
      case 'start_session':
        this.signalProtocol.injectClaudeMd(decision.project);
        return this.sessionManager.startSession(decision.project, decision.prompt);
      case 'stop_session':
        return this.sessionManager.stopSession(decision.project);
      case 'restart_session':
        this.signalProtocol.injectClaudeMd(decision.project);
        return this.sessionManager.restartSession(decision.project, decision.prompt);
      case 'reply_to_session':
        this.signalProtocol.clearSignal(decision.project, 'needs-input');
        return this.sessionManager.sendInput(decision.project, decision.message);
      case 'notify_human':
        this.messenger.send(decision.message);
        return { success: true };
      case 'no_action':
        return { success: true, message: 'No action needed' };
      default:
        throw new Error(`Unknown action: ${decision.action}`);
    }
  }
}
```

**Design rationale:**
- Maps AI decisions to EXISTING orchestrator actions -- start, stop, restart, reply, notify
- The AI cannot do anything the human cannot do via SMS
- Actions are executed sequentially to avoid race conditions with tmux
- Each action is try/caught independently so one failure does not block others
- The action vocabulary is constrained -- the AI cannot invent new actions

### 4. Cost Tracker (`lib/cost-tracker.js`)

Tracks API usage and enforces budget limits. Critical for a 24/7 daemon.

```javascript
class CostTracker {
  constructor(config, stateManager) {
    this.config = config;
    this.state = stateManager;
    this.pricing = {
      'claude-haiku-4-5': { input: 1.0, output: 5.0 },      // $ per MTok
      'claude-sonnet-4-5': { input: 3.0, output: 15.0 },
      'claude-haiku-3-5': { input: 0.80, output: 4.0 },
      'cache-read': 0.1,  // multiplier of base input price
      'cache-write': 1.25, // multiplier of base input price
    };
  }

  record(usage, model) {
    const s = this.state.load();
    if (!s.aiCosts) s.aiCosts = { daily: {}, monthly: {}, total: 0 };

    const cost = this._calculateCost(usage, model);
    const today = new Date().toISOString().split('T')[0];
    const month = today.substring(0, 7);

    s.aiCosts.daily[today] = (s.aiCosts.daily[today] || 0) + cost;
    s.aiCosts.monthly[month] = (s.aiCosts.monthly[month] || 0) + cost;
    s.aiCosts.total += cost;
    s.aiCosts.lastCall = { timestamp: new Date().toISOString(), usage, cost, model };

    this.state.save(s);
    return cost;
  }

  isOverBudget() {
    const s = this.state.load();
    const today = new Date().toISOString().split('T')[0];
    const month = today.substring(0, 7);
    const dailyCost = s.aiCosts?.daily?.[today] || 0;
    const monthlyCost = s.aiCosts?.monthly?.[month] || 0;
    return dailyCost > this.config.ai.dailyBudget || monthlyCost > this.config.ai.monthlyBudget;
  }

  getSummary() {
    const s = this.state.load();
    const today = new Date().toISOString().split('T')[0];
    const month = today.substring(0, 7);
    return {
      today: s.aiCosts?.daily?.[today] || 0,
      dailyBudget: this.config.ai.dailyBudget,
      thisMonth: s.aiCosts?.monthly?.[month] || 0,
      monthlyBudget: this.config.ai.monthlyBudget,
      total: s.aiCosts?.total || 0,
    };
  }
}
```

---

## Data Flow Changes (v2.0 -> v3.0)

### Current Flow: Human-in-the-Loop

```
[Project STATE.md changes] --scan--> [proactiveScan()] --SMS--> [Human reads SMS]
[Signal files appear]      --scan--> [proactiveScan()] --SMS--> [Human reads SMS]
[Human types SMS]          --poll--> [commands.route()] -------> [sessionManager action]
```

### New Flow: AI-in-the-Loop (with human escalation)

```
[Project STATE.md changes] --scan--> [proactiveScan()] --SMS--> [Human reads SMS]
[Signal files appear]      --scan--> [proactiveScan()] --SMS--> [Human reads SMS]
[Human types SMS]          --poll--> [commands.route()] -------> [sessionManager action]

                                     +--- NEW FLOW ---+
[All project state]  --assemble-->   [contextAssembler]
[All session status] --assemble-->   [contextAssembler]
[All signal files]   --assemble-->   [contextAssembler] --> [Claude API]
[Decision history]   --assemble-->   [contextAssembler]         |
                                                                v
                                                         [AI Brain parses]
                                                                |
                                     +--<decision>---<decision>--+--<decision>--+
                                     |               |                          |
                              [start session]  [notify human]          [answer signal]
                                     |               |                          |
                              [sessionManager]  [messenger]            [sessionManager]
```

### Key Difference

The proactive scan still runs and still sends SMS alerts. The AI think cycle runs on a SEPARATE, LONGER interval (5 min vs 60s). This means:

1. **Alerts are NOT delayed** -- the 60s scan still catches signals and alerts immediately
2. **AI decisions are deliberate** -- 5 min gives time for sessions to produce meaningful output
3. **Human retains override** -- SMS commands still work exactly as before
4. **AI adds value on top** -- proactive session launching, cross-project awareness, intelligent prioritization

### Flow Priority

When the AI and human both want to act:
1. **Human commands always win** -- if the human sends an SMS, that overrides AI
2. **AI checks before acting** -- the context assembler provides current state, including human-initiated sessions
3. **AI notifies before major actions** -- for high-impact decisions (stopping a session, changing priorities), the AI notifies rather than acts unilaterally
4. **Budget gating** -- if over budget, AI disables itself and notifies human

---

## The Think Cycle in Detail

### Timing: Why 5 Minutes

| Interval | Pro | Con |
|----------|-----|-----|
| 1 min | Fast reactions | Too much API cost, too little info change between cycles |
| 3 min | Reasonable | Slightly expensive for "nothing changed" calls |
| **5 min** | **Good cost/value balance, sessions have time to produce output** | **Minor delay on urgent matters** |
| 10 min | Very cheap | Too slow for a responsive orchestrator |
| 15 min | Cheapest | Defeats purpose of autonomous operation |

5 minutes is the default. The proactive scan (60s) handles urgent alerts. The AI think cycle handles strategic decisions.

### Token Budget per Cycle

**Context (input):** ~2,000-4,000 tokens typical
- System prompt (cached): ~1,500 tokens
- Project states (18 projects): ~1,500 tokens
- Active sessions + signals: ~500 tokens
- Decision history: ~500 tokens

**Response (output):** ~500-1,000 tokens typical
- Structured JSON decisions
- Brief reasoning

**Cost per cycle with Haiku 4.5:**
- Input: ~3,000 tokens x $1.00/MTok = $0.003
- Output: ~750 tokens x $5.00/MTok = $0.00375
- Cache read (system prompt): ~1,500 tokens x $0.10/MTok = $0.00015
- **Total per cycle: ~$0.007**
- **Per hour (12 cycles): ~$0.084**
- **Per day: ~$2.00**
- **Per month: ~$60**

**Cost per cycle with Sonnet 4.5 (for complex decisions):**
- Input: ~3,000 tokens x $3.00/MTok = $0.009
- Output: ~750 tokens x $15.00/MTok = $0.01125
- **Total per cycle: ~$0.020**
- **Per day (if all Sonnet): ~$5.76**
- **Per month (if all Sonnet): ~$173**

**Recommended approach:** Use Haiku 4.5 for routine cycles, escalate to Sonnet 4.5 only when the AI detects a situation requiring deeper reasoning (multiple blockers, conflicting priorities, new project assessment).

### System Prompt Design

The system prompt should be cached to save tokens. It defines the AI's role, decision vocabulary, and output format.

```
You are the AI brain of a project orchestrator managing {N} software projects
on a Mac Mini. You run 24/7 and make decisions about what to work on.

## Your Capabilities
You can:
- start_session: Launch a Claude Code session for a project with a specific prompt
- stop_session: Stop a running session
- restart_session: Restart a session with new instructions
- reply_to_session: Answer a session's question
- notify_human: Send an SMS to the human (use sparingly)
- no_action: Do nothing this cycle

## Decision Priorities
1. Revenue-generating projects first (web-scraping-biz, mlx-inference-api, etc.)
2. Unblock stuck sessions (answer needs-input signals)
3. Fill empty session slots (if < max concurrent, start something useful)
4. Monitor progress (restart stalled sessions)
5. Notify human only for genuine decisions they must make

## Rules
- NEVER start more sessions than maxConcurrentSessions
- NEVER stop a session the human just started (check recentDecisions)
- ALWAYS respond with structured JSON
- Include brief reasoning for each decision
- If nothing needs doing, return no_action (this is fine and expected)

## Output Format
Respond ONLY with a JSON array of decisions:
[
  {
    "action": "start_session",
    "project": "web-scraping-biz",
    "prompt": "Continue with the next feature. Check STATE.md.",
    "reasoning": "Highest revenue project, no active session, has pending work"
  }
]
```

This system prompt is ~400 tokens. With the context breakdown, it crosses the 1024 minimum cache threshold when combined, ensuring prompt caching works effectively.

---

## Prompt Caching Strategy

### What to Cache

| Content | Cache? | Why |
|---------|--------|-----|
| System prompt (role, rules, format) | YES, 1h TTL | Changes only on code deploy |
| Project list with revenue/priority metadata | YES, 5m TTL | Changes rarely, refreshed each cycle |
| Per-cycle context (states, sessions) | NO | Changes every cycle |

### Implementation

```javascript
const response = await this.anthropic.messages.create({
  model: 'claude-haiku-4-5',
  max_tokens: 2048,
  system: [
    {
      type: 'text',
      text: SYSTEM_PROMPT,  // Role, rules, format
      cache_control: { type: 'ephemeral', ttl: '1h' }
    },
    {
      type: 'text',
      text: PROJECT_METADATA,  // Static project info (names, revenue tiers)
      cache_control: { type: 'ephemeral' }  // 5m default
    }
  ],
  messages: [{
    role: 'user',
    content: dynamicContext  // Current states, sessions, signals
  }]
});
```

### Cache Economics

With 1,500 tokens of system prompt cached:
- First call: 1,500 tokens x $1.25/MTok = $0.001875 (cache write)
- Subsequent calls (11 per hour): 1,500 tokens x $0.10/MTok = $0.00015 each
- **Savings per hour: $0.01035 vs $0.012 without caching = 14% savings**
- Over a month: ~$7.50 saved

The cache savings are modest at Haiku pricing but become significant if escalating to Sonnet.

---

## Model Selection Strategy

### Two-Tier Model Approach

```
Routine cycle (90% of calls):
  Claude Haiku 4.5 ($1/$5 per MTok)
  - "Nothing changed, no action needed"
  - "Session X finished, start session Y"
  - "Session Z needs input, it's a routine question, answer it"

Complex cycle (10% of calls):
  Claude Sonnet 4.5 ($3/$15 per MTok)
  - Multiple blockers across projects
  - Revenue prioritization with tradeoffs
  - Evaluating session output quality
  - Planning multi-step workflows
```

### Escalation Triggers

The AI Brain detects complexity and escalates:
1. **More than 2 projects need attention simultaneously**
2. **A signal requires evaluating session output** (reading tmux output for quality)
3. **Cross-project conflicts** (two projects need the same resource)
4. **Human hasn't responded to a notify_human in 2+ cycles**
5. **Budget is approaching limit** (meta-decision about what to prioritize)

### Blended Cost Estimate

- 260 Haiku calls/day (90%) x $0.007 = $1.82
- 29 Sonnet calls/day (10%) x $0.020 = $0.58
- **Daily: ~$2.40**
- **Monthly: ~$72**

---

## Configuration Extension

### New `config.json` Fields

```json
{
  "ai": {
    "enabled": true,
    "apiKey": "ANTHROPIC_API_KEY_ENV_VAR",
    "model": "claude-haiku-4-5",
    "escalationModel": "claude-sonnet-4-5",
    "thinkIntervalMs": 300000,
    "dailyBudget": 5.00,
    "monthlyBudget": 100.00,
    "maxActionsPerCycle": 3,
    "notifyOnMajorActions": true,
    "autonomyLevel": "moderate"
  }
}
```

### Autonomy Levels

| Level | Behavior |
|-------|----------|
| `"observe"` | AI thinks but only notifies, never acts |
| `"cautious"` | AI can answer signals and start sessions, notifies for stops/restarts |
| `"moderate"` | AI can start/stop/restart/answer, notifies for multi-project changes |
| `"aggressive"` | AI acts fully autonomously, notifies only on errors or budget |

### New SMS Commands

| Command | Action |
|---------|--------|
| `ai on` / `ai off` | Enable/disable AI brain |
| `ai status` | Show last think result, budget, decisions |
| `ai budget` | Show cost tracking summary |
| `ai level <level>` | Set autonomy level |
| `ai think` | Force an immediate think cycle |
| `ai explain` | Show reasoning for last decision |

---

## Integration Points with Existing Code

### index.js Changes

```javascript
// New imports
const AIBrain = require('./lib/ai-brain');
const ContextAssembler = require('./lib/context-assembler');
const DecisionExecutor = require('./lib/decision-executor');
const CostTracker = require('./lib/cost-tracker');

// New initialization (after existing modules)
const costTracker = new CostTracker(CONFIG, state);
const contextAssembler = new ContextAssembler({
  scanner, processMonitor, signalProtocol, sessionManager, state, config: CONFIG
});
const decisionExecutor = new DecisionExecutor({
  sessionManager, signalProtocol, messenger, commands
});
const aiBrain = new AIBrain({
  contextAssembler, decisionExecutor, costTracker, config: CONFIG
});

// Add AI brain to command router deps
const commands = new CommandRouter({
  scanner, processMonitor, digest, scheduler, sessionManager,
  signalProtocol, state,
  projectNames: CONFIG.projects,
  aiBrain,  // NEW
});

// New polling loop (after existing ones)
const aiInterval = CONFIG.ai?.enabled
  ? setInterval(() => aiBrain.think().catch(e => log('AI', `Error: ${e.message}`)),
      CONFIG.ai.thinkIntervalMs || 300000)
  : null;

// Initial think after boot (30s delay to let scanning initialize)
if (CONFIG.ai?.enabled) {
  setTimeout(() => aiBrain.think().catch(e => log('AI', `Error: ${e.message}`)), 30000);
}
```

### commands.js Changes

Add new command handlers for AI control:

```javascript
// In route()
if (lower === 'ai on') return this._handleAiOn();
if (lower === 'ai off') return this._handleAiOff();
if (lower === 'ai status') return this._handleAiStatus();
if (lower === 'ai budget') return this._handleAiBudget();
if (lower.startsWith('ai level ')) return this._handleAiLevel(lower.slice(9).trim());
if (lower === 'ai think') return this._handleAiThink();
if (lower === 'ai explain') return this._handleAiExplain();
```

### state.js Changes

Extend default state:

```javascript
load() {
  try {
    return JSON.parse(fs.readFileSync(this.stateFile, 'utf-8'));
  } catch {
    return {
      lastRowId: 0,
      lastScan: null,
      lastDigest: null,
      alertHistory: {},
      // NEW
      aiDecisionHistory: [],
      aiCosts: { daily: {}, monthly: {}, total: 0 },
      aiEnabled: true,
      aiAutonomyLevel: 'moderate',
    };
  }
}
```

---

## Suggested Build Order

The build order is driven by dependencies and incremental value delivery.

### Phase 1: Foundation (API + Cost Tracking)

**Build:** `cost-tracker.js`, Anthropic SDK integration, `config.json` AI section
**Why first:** Everything depends on the API client and cost tracking. Cannot test anything without these.
**Test:** Manual API call, cost recording, budget check
**Value:** Zero (infrastructure only)

### Phase 2: Context Assembly

**Build:** `context-assembler.js`
**Why second:** The AI's "input" -- must be right before building the brain
**Test:** Run assembler, inspect output, verify all project data present
**Value:** Useful standalone for debugging (shows formatted project state)
**Depends on:** Existing scanner, processMonitor, signalProtocol, sessionManager

### Phase 3: AI Brain (Read-Only Mode)

**Build:** `ai-brain.js` with `autonomyLevel: "observe"`
**Why third:** Get the think cycle working in observe-only mode -- AI thinks, outputs decisions to log, but does NOT act
**Test:** Run daemon, watch logs, verify AI decisions make sense
**Value:** Immediate insight into what the AI would do -- validates decision quality before enabling actions
**Depends on:** Phase 1 (API), Phase 2 (context)

### Phase 4: Decision Executor + SMS Commands

**Build:** `decision-executor.js`, new SMS commands in `commands.js`
**Why fourth:** Enable execution only after decision quality is validated in Phase 3
**Test:** Upgrade to `autonomyLevel: "cautious"`, verify AI starts sessions correctly
**Value:** AI begins acting autonomously (cautiously)
**Depends on:** Phase 3 (brain), existing sessionManager, messenger

### Phase 5: Escalation + Polish

**Build:** Two-tier model selection, escalation triggers, `ai explain` command
**Why fifth:** Optimization -- only worth doing after the basic loop works
**Test:** Trigger escalation scenarios, verify Sonnet is used appropriately
**Value:** Better decisions for complex situations, lower cost for routine ones

---

## Anti-Patterns to Avoid

### Anti-Pattern 1: Replacing the Existing Scan Loop

**What:** Moving all proactive scanning into the AI think cycle
**Why bad:** The 60s scan catches urgent signals fast. The 5-min AI cycle is too slow for alerts.
**Instead:** Keep both. Scan alerts immediately. AI makes strategic decisions on longer intervals.

### Anti-Pattern 2: Unbounded Context

**What:** Dumping all project data, git logs, tmux output, and file contents into the prompt
**Why bad:** Token costs explode. 18 projects x full STATE.md = thousands of tokens. Add git logs and it becomes tens of thousands.
**Instead:** Context assembler produces a compact summary. Only include data the AI needs to decide. If the AI needs more detail for a specific project, it requests it in a follow-up cycle.

### Anti-Pattern 3: Conversational Memory

**What:** Maintaining a growing message history across think cycles
**Why bad:** Input tokens grow linearly with time. After 24 hours = thousands of history tokens.
**Instead:** Each think cycle is a fresh conversation. Include only the last 5 decisions in context. Use file-based state (which is already there) for long-term memory.

### Anti-Pattern 4: AI as Primary Interface

**What:** Routing all SMS through the AI for "natural language understanding"
**Why bad:** Adds latency (API call) to every SMS. Costs tokens for simple commands. The existing command router handles 95% of cases perfectly.
**Instead:** Keep the existing command router for structured commands. Only invoke AI for truly ambiguous input (and even then, consider just showing help).

### Anti-Pattern 5: No Budget Limits

**What:** Running the AI 24/7 without cost tracking or limits
**Why bad:** A bug (infinite loop, oversized context) could burn through budget fast.
**Instead:** Hard budget limits with automatic disable. Daily and monthly caps. Alert the human when approaching limits.

---

## Scalability Considerations

| Concern | At 18 projects (now) | At 50 projects | At 100+ projects |
|---------|---------------------|----------------|------------------|
| Context size | ~3K tokens | ~8K tokens | ~15K tokens (needs summarization) |
| Think cycle cost | $0.007/cycle | $0.015/cycle | $0.03/cycle |
| Monthly cost | ~$60-72 | ~$130-150 | ~$260-300 |
| Scan time | <1s | ~2s | ~5s (may need parallel scanning) |
| Decision complexity | Simple | Moderate | Needs project grouping/prioritization |

At 100+ projects, the architecture should evolve to:
- Group projects by category/priority tier
- Only include active/attention-needed projects in full detail
- Summarize dormant projects as a count
- Consider separate think cycles for different project tiers

---

## Error Handling

### API Failures

```javascript
async think() {
  try {
    // ... normal flow
  } catch (e) {
    if (e.status === 429) {
      // Rate limited -- back off, reduce think interval
      this._backoff();
      return;
    }
    if (e.status === 500 || e.status === 529) {
      // Anthropic server error -- retry next cycle
      log('AI', `API error (${e.status}), will retry next cycle`);
      return;
    }
    if (e.message.includes('api_key')) {
      // Auth error -- disable AI, notify human
      this.enabled = false;
      this.messenger.send('AI brain disabled: API key error. Fix and text "ai on".');
      return;
    }
    // Unknown error -- log and continue
    log('AI', `Unexpected error: ${e.message}`);
  }
}
```

### Decision Parsing Failures

If the AI returns malformed JSON or unexpected actions:
1. Log the raw response for debugging
2. Fall back to `no_action`
3. If 3 consecutive parse failures, notify human and disable until next manual `ai on`

### Race Conditions

The AI think cycle and human SMS commands can overlap:
1. **AI starts a session, human also starts the same session:** SessionManager already handles "already running" -- returns error, no double-start
2. **AI stops a session the human just started:** Prevention: include recent human commands in context, instruct AI not to override human actions within 10 minutes
3. **Human sends "ai off" during a think cycle:** The think cycle completes its current API call but does not execute decisions (check `enabled` before execution)

---

## Sources

- [Anthropic API Pricing (Official)](https://platform.claude.com/docs/en/about-claude/pricing) - HIGH confidence
- [Anthropic Rate Limits (Official)](https://platform.claude.com/docs/en/api/rate-limits) - HIGH confidence
- [Anthropic Prompt Caching (Official)](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) - HIGH confidence
- [Anthropic SDK TypeScript (GitHub)](https://github.com/anthropics/anthropic-sdk-typescript) - HIGH confidence
- [Building Effective Agents (Anthropic Research)](https://www.anthropic.com/research/building-effective-agents) - HIGH confidence
- [Effective Harnesses for Long-Running Agents (Anthropic Engineering)](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) - HIGH confidence
- [npm @anthropic-ai/sdk](https://www.npmjs.com/package/@anthropic-ai/sdk) - HIGH confidence
