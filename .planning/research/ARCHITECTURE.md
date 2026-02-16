# Architecture Patterns

**Domain:** AI-powered orchestrator layer for an existing Node.js process manager
**Researched:** 2026-02-15
**Updated:** 2026-02-16 — Revised to use `claude -p` (Max plan) instead of Anthropic SDK
**Confidence:** HIGH

## Executive Summary

The existing orchestrator (v2.0) is a clean, well-factored process manager with clear component boundaries. The AI layer (v3.0) integrates as a **new decision engine module** that shells out to `claude -p` (Claude Code's print mode) for reasoning. It sits between the data-gathering components (scanner, process-monitor, signal-protocol) and the action-taking components (session-manager, messenger).

The key insight: **the AI layer replaces the human in the loop, not the process manager.** It reads status, makes decisions, and issues commands — the same interface the SMS user has today. And because the user has a Max plan, the AI brain uses `claude -p` at zero incremental cost instead of the Anthropic API.

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
              v              v                       claude -p
     +--------+----+  +-----+------+                     |
     | commands    |  | signal-    |              +------+------+
     | (router)    |  | protocol   |              | context-    |
     +--------+----+  +-----+------+              | assembler   |
              |              |                     | (NEW)       |
              v              v                     +------+------+
     +--------+----+  +-----+------+                     |
     | session-    |  | process-   |              +------+------+
     | manager     |  | monitor    |              | decision-   |
     | (tmux)      |  | (ps aux)   |              | executor    |
     +-------------+  +------------+              | (NEW)       |
                                                  +------+------+
     +-------------+                                     |
     | state       |                              +------+------+
     | (.state.json)|                              | Uses:      |
     +-------------+                               | sessionMgr |
                                                   | messenger  |
                                                   | commands   |
                                                   +------------+
```

### New Components

| Component | File | Purpose | Depends On |
|-----------|------|---------|------------|
| **AI Brain** | `lib/ai-brain.js` | Orchestrates think cycle: gather context, call `claude -p`, log decisions, execute actions | context-assembler, decision-executor |
| **Context Assembler** | `lib/context-assembler.js` | Gathers all project/session state into a structured prompt for Claude | scanner, processMonitor, signalProtocol, sessionManager, state |
| **Decision Executor** | `lib/decision-executor.js` | Parses Claude's structured response and executes actions | sessionManager, messenger, signalProtocol, commands |

**Removed from original design:** Cost Tracker (`lib/cost-tracker.js`) — not needed with Max plan.

### Modified Components

| Component | Change | Why |
|-----------|--------|-----|
| **index.js** | Add `aiThinkCycle()` interval (5 min default) | New polling loop for AI decisions |
| **commands.js** | Add `ai on/off`, `ai status`, `ai level` commands | Human override and monitoring |
| **state.js** | Extend state with AI decision history | Persist AI decisions for audit |
| **config.json** | Add `ai` section (model, interval, enabled) | Configuration for AI layer |

### Unchanged Components

| Component | Why Unchanged |
|-----------|--------------|
| **messenger.js** | AI uses same send interface as existing code |
| **scanner.js** | AI reads same STATE.md data as existing proactive scan |
| **signal-protocol.js** | AI reads same signals as existing scan |
| **process-monitor.js** | AI checks same process status |
| **session-manager.js** | AI issues same start/stop/restart commands |
| **scheduler.js** | AI think cycle is a separate interval, not cron |
| **digest.js** | Morning digest stays as-is until Phase 2 replaces it |

---

## Component Details

### 1. AI Brain (`lib/ai-brain.js`)

The central orchestration point. Runs on a configurable interval (default: 5 minutes). Shells out to `claude -p` for reasoning.

```javascript
const { execFile } = require('child_process');

class AIBrain {
  constructor({ contextAssembler, decisionExecutor, config, state }) {
    this.contextAssembler = contextAssembler;
    this.decisionExecutor = decisionExecutor;
    this.config = config;
    this.state = state;
    this.enabled = config.ai?.enabled ?? false;
    this.lastThinkResult = null;
  }

  async think() {
    if (!this.enabled) return null;

    // 1. Gather context
    const context = this.contextAssembler.assemble();

    // 2. Build full prompt
    const prompt = this._buildPrompt(context);

    // 3. Call claude -p
    const response = await this._askClaude(prompt);

    // 4. Parse decisions
    const decisions = this._parseDecisions(response);

    // 5. Log decisions
    this._logDecisions(decisions, context);

    // 6. Execute (if autonomy level allows)
    let results = [];
    if (this.config.ai.autonomyLevel !== 'observe') {
      results = await this.decisionExecutor.execute(decisions);
    } else {
      // Observe mode: notify human of recommendations
      const actionable = decisions.filter(d => d.action !== 'no_action');
      if (actionable.length > 0) {
        this._notifyRecommendations(actionable);
      }
    }

    this.lastThinkResult = { timestamp: new Date(), decisions, results };
    return this.lastThinkResult;
  }

  _askClaude(prompt) {
    return new Promise((resolve, reject) => {
      const args = ['-p'];
      const model = this.config.ai.defaultModel;
      if (model) args.push('--model', model);

      const child = execFile('claude', args, {
        timeout: 30000,
        maxBuffer: 1024 * 1024,
      }, (error, stdout, stderr) => {
        if (error) return reject(error);
        resolve(stdout.trim());
      });

      child.stdin.write(prompt);
      child.stdin.end();
    });
  }
}
```

**Design rationale:**
- The think cycle is **async** — does not block message polling or scanning
- `claude -p` runs as a child process, isolating the AI from the main event loop
- Each think cycle is a fresh prompt — no growing conversation history
- The brain can be enabled/disabled at runtime via SMS command
- Observe mode sends recommendations without acting — safe for initial rollout

### 2. Context Assembler (`lib/context-assembler.js`)

Gathers all orchestrator state into a structured prompt. This is the "eyes" of the AI.

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
      })),
      pendingSignals: signals,
      recentDecisions: s.aiDecisionHistory?.slice(-5) || [],
    });
  }

  _formatContext(data) {
    let ctx = `# Orchestrator State (${data.timestamp})\n\n`;
    ctx += `## Sessions: ${data.activeSessions.length}/${data.maxSessions} active\n`;
    for (const s of data.activeSessions) {
      ctx += `- ${s.projectName} (running since ${s.startedAt})\n`;
    }
    ctx += `\n## Projects Needing Attention\n`;
    const attention = data.projects.filter(p => p.needsAttention);
    for (const p of attention) {
      ctx += `- **${p.name}**: ${p.attentionReason} (Phase ${p.phase}/${p.totalPhases})\n`;
    }
    ctx += `\n## All Projects\n`;
    for (const p of data.projects) {
      ctx += `- ${p.name}: ${p.status} | Phase ${p.phase}/${p.totalPhases} | `;
      ctx += `${p.blockers ? 'BLOCKED: ' + p.blockers : 'No blockers'} | `;
      ctx += `${p.hasActiveSession ? 'SESSION RUNNING' : 'idle'}\n`;
    }
    if (data.pendingSignals.length > 0) {
      ctx += `\n## Pending Signals\n`;
      for (const sig of data.pendingSignals) {
        ctx += `- ${sig.project}: ${sig.type} — ${sig.summary}\n`;
      }
    }
    if (data.recentDecisions.length > 0) {
      ctx += `\n## Recent AI Decisions (last 5)\n`;
      for (const d of data.recentDecisions) {
        ctx += `- ${d.timestamp}: ${d.action} ${d.project || ''} — ${d.reasoning}\n`;
      }
    }
    return ctx;
  }
}
```

**Design rationale:**
- Reuses ALL existing data-gathering modules
- Formats data compactly — ~50 tokens per project, ~1000 tokens total for 18 projects
- Includes recent decision history so the AI has short-term memory
- Context is assembled synchronously (all data is local) before async claude -p call

### 3. Decision Executor (`lib/decision-executor.js`)

Parses the AI's structured response and maps decisions to existing orchestrator actions.

```javascript
class DecisionExecutor {
  constructor({ sessionManager, signalProtocol, messenger, state, config }) {
    this.sessionManager = sessionManager;
    this.signalProtocol = signalProtocol;
    this.messenger = messenger;
    this.state = state;
    this.config = config;
    this.cooldowns = {}; // project -> lastActionTimestamp
  }

  async execute(decisions) {
    const results = [];
    for (const decision of decisions) {
      // Enforce cooldowns
      if (this._isOnCooldown(decision.project)) {
        results.push({ decision, skipped: true, reason: 'cooldown' });
        continue;
      }
      // Enforce resource limits
      if (decision.action === 'start_session' && !this._hasResources()) {
        results.push({ decision, skipped: true, reason: 'resources' });
        continue;
      }
      try {
        const result = await this._executeOne(decision);
        results.push({ decision, result, success: true });
        this._setCooldown(decision.project);
      } catch (e) {
        results.push({ decision, error: e.message, success: false });
      }
    }
    return results;
  }

  async _executeOne(decision) {
    switch (decision.action) {
      case 'start_session':
        return this.sessionManager.startSession(decision.project, decision.prompt);
      case 'stop_session':
        return this.sessionManager.stopSession(decision.project);
      case 'restart_session':
        return this.sessionManager.restartSession(decision.project, decision.prompt);
      case 'reply_to_session':
        return this.sessionManager.sendInput(decision.project, decision.message);
      case 'notify_human':
        this.messenger.send(decision.message);
        return { sent: true };
      case 'no_action':
        return { ok: true };
      default:
        throw new Error(`Unknown action: ${decision.action}`);
    }
  }

  _isOnCooldown(project) {
    if (!project) return false;
    const last = this.cooldowns[project];
    if (!last) return false;
    return (Date.now() - last) < 300000; // 5 min cooldown
  }

  _setCooldown(project) {
    if (project) this.cooldowns[project] = Date.now();
  }

  _hasResources() {
    const os = require('os');
    const freeGB = os.freemem() / (1024 * 1024 * 1024);
    return freeGB > 2.0; // Require 2GB free
  }
}
```

**Design rationale:**
- Maps AI decisions to EXISTING orchestrator actions
- The AI cannot do anything the human cannot do via SMS
- Built-in cooldown timers (5 min between actions on same project)
- Resource checks before starting sessions (2GB free RAM minimum)
- Actions are executed sequentially to avoid race conditions

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
[All signal files]   --assemble-->   [contextAssembler] --> [claude -p]
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

### Key Design Properties

1. **Alerts are NOT delayed** — the 60s scan still catches signals and alerts immediately
2. **AI decisions are deliberate** — 5 min gives time for sessions to produce meaningful output
3. **Human retains override** — SMS commands still work exactly as before, always take priority
4. **AI adds value on top** — proactive session launching, cross-project awareness, intelligent prioritization

---

## The Think Cycle in Detail

### Timing: Why 5 Minutes

| Interval | Pro | Con |
|----------|-----|-----|
| 1 min | Fast reactions | Too frequent, sessions haven't produced output yet |
| 3 min | Reasonable | Slightly too eager |
| **5 min** | **Good balance, sessions produce meaningful output** | **Minor delay on strategic decisions** |
| 10 min | Conservative | Too slow for a responsive orchestrator |

5 minutes is the default. The proactive scan (60s) handles urgent alerts. The AI think cycle handles strategic decisions.

### System Prompt Design

The system prompt tells Claude its role, available actions, and output format:

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
1. Unblock stuck sessions (answer needs-input signals)
2. Revenue-generating projects first (web-scraping-biz, mlx-inference-api, etc.)
3. Fill empty session slots (if < max concurrent, start something useful)
4. Monitor progress (restart stalled sessions)
5. Notify human only for genuine decisions they must make

## Rules
- NEVER start more sessions than maxConcurrentSessions
- NEVER stop a session the human just started (check recentDecisions)
- Respond ONLY with a JSON array of decisions — no other text
- Include brief reasoning for each decision
- If nothing needs doing, return [{"action": "no_action", "reasoning": "..."}]

## Output Format
[
  {
    "action": "start_session",
    "project": "web-scraping-biz",
    "prompt": "Continue with the next feature. Check STATE.md.",
    "reasoning": "Highest revenue project, no active session, has pending work"
  }
]
```

### Model Selection per Think Cycle

With Max plan, model choice is about quality and speed, not cost:

```javascript
_selectModel(context) {
  // Use Sonnet for routine cycles (fast, good enough)
  // Use Opus for complex situations
  const attentionCount = context.projects.filter(p => p.needsAttention).length;
  const hasSignals = context.pendingSignals.length > 0;

  if (attentionCount > 3 || hasSignals) return 'opus'; // Complex reasoning
  return 'sonnet'; // Routine triage
}
```

---

## Configuration

### New `config.json` Fields

```json
{
  "ai": {
    "enabled": true,
    "defaultModel": "sonnet",
    "complexModel": "opus",
    "thinkIntervalMs": 300000,
    "maxActionsPerCycle": 3,
    "cooldownMs": 300000,
    "notifyOnMajorActions": true,
    "autonomyLevel": "observe",
    "decisionLog": true
  }
}
```

### Autonomy Levels

| Level | Behavior |
|-------|----------|
| `"observe"` | AI thinks but only notifies, never acts |
| `"cautious"` | AI can answer signals and start sessions, notifies for stops/restarts |
| `"moderate"` | AI can start/stop/restart/answer, notifies for multi-project changes |
| `"full"` | AI acts fully autonomously, notifies only on errors or human-needed decisions |

### New SMS Commands

| Command | Action |
|---------|--------|
| `ai on` / `ai off` | Enable/disable AI brain |
| `ai status` | Show last think result and recent decisions |
| `ai level <level>` | Set autonomy level |
| `ai think` | Force an immediate think cycle |
| `ai explain` | Show reasoning for last decision |
| `ai log` | Show recent decision log entries |

---

## Error Handling

### `claude -p` Failures

```javascript
async _askClaude(prompt) {
  try {
    return await this._execClaude(prompt);
  } catch (e) {
    if (e.killed) {
      // Timeout (30s exceeded)
      this._log('AI', 'Think cycle timed out, skipping');
      return '[]';
    }
    if (e.code === 'ENOENT') {
      // claude not found
      this.enabled = false;
      this.messenger.send('AI brain disabled: claude CLI not found.');
      return '[]';
    }
    // Unknown error — log and return no-op
    this._log('AI', `Error: ${e.message}`);
    return '[]';
  }
}
```

### Decision Parsing Failures

If Claude returns malformed JSON:
1. Log the raw response for debugging
2. Return empty decisions (skip this cycle)
3. If 3 consecutive parse failures, notify human and continue

### Race Conditions

The AI think cycle and human SMS commands can overlap:
1. **AI starts a session, human also starts same session:** SessionManager handles "already running"
2. **AI stops a session the human just started:** Include recent human commands in context
3. **Human sends "ai off" during think cycle:** Check `enabled` before executing decisions

---

## Anti-Patterns to Avoid

### Anti-Pattern 1: Replacing the Existing Scan Loop
Keep both. Scan alerts immediately (60s). AI makes strategic decisions (5 min).

### Anti-Pattern 2: Unbounded Context
Context assembler produces compact summaries (~50 tokens/project). Never dump raw STATE.md files.

### Anti-Pattern 3: Conversational Memory
Each think cycle is a fresh prompt. Include only last 5 decisions. No growing message history.

### Anti-Pattern 4: AI as Primary SMS Interface
Keep existing command router for structured commands. AI handles strategic decisions only.

### Anti-Pattern 5: Multiple Concurrent claude -p Calls
Run only ONE claude -p at a time. Queue additional requests. Prevents resource contention.

---

## Suggested Build Order

### Phase 1: Foundation (Observe Mode)

1. **Context Assembler** — build and test the prompt generation
2. **AI Brain (observe only)** — `claude -p` integration, decision parsing, logging
3. **SMS Commands** — `ai on/off/status/level/think/explain`
4. **Guardrails** — cooldowns, resource checks, action allowlist
5. **Priority overrides** — `priorities.json` for user veto power

### Phase 2: Execution and Intelligence

6. **Decision Executor** — wire up to existing session-manager/messenger
7. **Upgrade to cautious/moderate autonomy**
8. **Session prompt engineering** — context-rich prompts per project
9. **Smart error recovery** — evaluate and retry errors
10. **Intelligent morning digest** — replace template with AI-generated
11. **Time boxing** — 45-min session cap
12. **Notification tiers** — urgent/summary/debug

---

## Sources

- Claude Code CLI — `-p` print mode, `--model` flag
- [Building Effective Agents](https://www.anthropic.com/research/building-effective-agents) — HIGH confidence
- [Effective Harnesses for Long-Running Agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) — HIGH confidence
- Codebase analysis of existing orchestrator modules — HIGH confidence
