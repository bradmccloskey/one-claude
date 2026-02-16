# Technology Stack: v3.0 AI-Powered Orchestrator

**Project:** project-orchestrator
**Researched:** 2026-02-15
**Updated:** 2026-02-16 — Revised to use `claude -p` (Max plan) instead of Anthropic SDK
**Confidence:** HIGH

## Executive Decision: Claude CLI vs Raw API vs Agent SDK

**Recommendation: Use `claude -p` (Claude Code print mode), NOT the Anthropic SDK or Agent SDK.**

This is the most important decision in this document. The user has a Claude Max plan with unlimited Claude Code usage. Paying for API calls on top of that is wasting money.

### Why `claude -p` (Claude Code Print Mode)

The `claude` CLI supports a print mode (`-p`) that accepts a prompt and returns a response:

```bash
# Simple one-shot prompt
claude -p "What should I work on next?"

# Pipe longer prompts via stdin
echo "$context" | claude -p "Given this project state, prioritize work"

# With model selection (optional)
claude -p --model sonnet "Evaluate this session output"
```

This gives us:
- **Zero cost** — covered by Max subscription ($200/mo flat, unlimited)
- **Zero new dependencies** — `claude` is already installed
- **Zero API key management** — uses existing OAuth session
- **Access to latest models** — Opus 4.6, Sonnet 4.5, Haiku 4.5
- **Built-in prompt caching, context management, etc.** — handled by Claude Code internals

### Why NOT the Anthropic SDK (`@anthropic-ai/sdk`)

The v3.0 research originally recommended the raw SDK. That made sense if you were paying per-token and needed fine-grained cost control. With Max plan:

| Concern | API SDK | claude -p |
|---------|---------|-----------|
| Cost per call | $0.001-0.02 each | $0 (unlimited) |
| Monthly ceiling | $60-100+ | $0 (flat $200 Max plan) |
| API key management | Need .env, rotation | Not needed |
| Cost tracking | Must build | Not needed |
| Budget caps | Must build | Not needed |
| Prompt caching logic | Must implement | Handled internally |
| Model routing | Must implement | Pass `--model` flag |
| Rate limits | Must handle 429s | Not applicable |
| Dependencies added | 2 packages | 0 packages |

The SDK approach adds complexity that solves a problem (cost control) that doesn't exist with Max plan.

### Why NOT the Agent SDK (`@anthropic-ai/claude-agent-sdk`)

Same reasons as before: the orchestrator is a **decision engine**, not a code agent. The Agent SDK gives Claude full Read/Write/Bash tooling, creating a second agentic layer competing with the Claude Code sessions the orchestrator manages. This is still the wrong abstraction regardless of pricing model.

### When Would You Switch to the API?

Only if:
1. Max plan is discontinued or pricing changes dramatically
2. You need sub-second latency (claude -p has ~2-5s startup overhead)
3. You need structured tool use (function calling) for guaranteed JSON output

For now, none of these apply.

---

## Recommended Stack Additions

### Core: Zero New Dependencies

```bash
# Nothing to install. Claude CLI is already on the system.
which claude  # /usr/local/bin/claude (or wherever it's installed)
```

The AI brain uses Node.js built-in `child_process` to shell out to `claude`:

```javascript
const { execFile } = require('child_process');

function askClaude(prompt, options = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-p'];
    if (options.model) args.push('--model', options.model);

    const child = execFile('claude', args, {
      timeout: options.timeout || 30000,
      maxBuffer: 1024 * 1024, // 1MB
    }, (error, stdout, stderr) => {
      if (error) return reject(error);
      resolve(stdout.trim());
    });

    // Send prompt via stdin for longer contexts
    child.stdin.write(prompt);
    child.stdin.end();
  });
}
```

### Model Selection

| Model | Flag | Use For | When |
|-------|------|---------|------|
| **Default (Opus 4.6)** | (none) | Complex decisions: prioritization, evaluation | When quality matters most |
| **Sonnet 4.5** | `--model sonnet` | Routine decisions: scan triage, status checks | Most think cycles |
| **Haiku 4.5** | `--model haiku` | Simple formatting: SMS composition, status summaries | High-frequency, low-stakes |

**Recommendation:** Default to Sonnet for the think cycle. With Max plan, there's no cost penalty for using a smarter model. Use Haiku only for truly trivial formatting tasks. Use Opus for weekly planning or complex multi-project evaluations.

**Key difference from API approach:** With the API, we'd default to Haiku to save money. With Max plan, we default to Sonnet because it's free and smarter.

### Supporting Libraries (What NOT to Add)

| Library | Verdict | Rationale |
|---------|---------|-----------|
| `@anthropic-ai/sdk` | **DO NOT ADD** | Not needed. Max plan covers unlimited claude -p usage. |
| `@anthropic-ai/claude-agent-sdk` | **DO NOT ADD** | Wrong abstraction. Decision engine, not code agent. |
| `dotenv` | **DO NOT ADD** | No API key to manage. |
| `langchain` / `llamaindex` | **DO NOT ADD** | Massive overkill. Shell out to claude -p. |
| `tiktoken` / token counters | **DO NOT ADD** | No token billing to track. |
| Any vector DB | **DO NOT ADD** | Context is <10K tokens. No RAG needed. |
| `winston` / `pino` | **CONSIDER later** | Current console.log is fine for now. |

---

## Integration Architecture with Existing Stack

### New Module: `lib/brain.js`

The AI decision engine shells out to `claude -p`:

```
index.js                    (main loop - existing)
  |-- lib/commands.js       (SMS routing - existing)
  |-- lib/scanner.js        (STATE.md reading - existing)
  |-- lib/session-manager.js (tmux management - existing)
  |-- lib/brain.js          (NEW: AI decision engine)
        |-- child_process.execFile('claude', ['-p'])
        |-- System prompt management (string template)
        |-- Decision functions (prioritize, evaluate, plan)
        |-- Decision logging (JSON append)
```

### Integration Points

| Existing Module | How Brain Integrates | Direction |
|----------------|---------------------|-----------|
| `scanner.js` | Brain receives scanned project data as context | Scanner -> Brain |
| `session-manager.js` | Brain calls start/stop/restart based on decisions | Brain -> SessionManager |
| `process-monitor.js` | Brain receives running session info for awareness | ProcessMonitor -> Brain |
| `signal-protocol.js` | Brain receives signal data, decides response | SignalProtocol -> Brain |
| `commands.js` | Some SMS commands trigger Brain decisions | Commands -> Brain |
| `messenger.js` | Brain composes intelligent SMS via claude -p | Brain -> Messenger |
| `scheduler.js` | Brain runs on think interval, respects quiet hours | Scheduler -> Brain |
| `state.js` | Brain reads/writes orchestrator state | Brain <-> State |

### No Changes to Existing Modules

The existing modules should NOT be modified significantly. The Brain module is an **addition** that sits alongside them. It consumes their output and issues commands through their existing interfaces.

### Config Additions

Add to `config.json`:

```json
{
  "ai": {
    "enabled": true,
    "defaultModel": "sonnet",
    "thinkIntervalMs": 300000,
    "maxActionsPerCycle": 3,
    "notifyOnMajorActions": true,
    "autonomyLevel": "observe",
    "decisionLog": true
  }
}
```

No API key, no budget caps, no monthly limits. Just feature toggles and behavior configuration.

---

## Structured Output Strategy

Without the Anthropic SDK's tool use, we need to get structured JSON from `claude -p`. Two approaches:

### Approach 1: JSON-in-Prompt (Recommended for simplicity)

```javascript
const systemPrompt = `
You are the AI brain of a project orchestrator.
ALWAYS respond with ONLY a JSON array. No markdown, no commentary.
Example: [{"action": "start_session", "project": "web-scraping-biz", "reasoning": "..."}]
`;

const response = await askClaude(systemPrompt + '\n\n' + context);
const decisions = JSON.parse(response);
```

**Parsing safety:** Use a robust parser that strips markdown fences and extracts JSON:

```javascript
function parseJSON(text) {
  // Strip markdown code fences if present
  text = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '');
  // Try to extract JSON array
  const match = text.match(/\[[\s\S]*\]/);
  if (match) return JSON.parse(match[0]);
  // Try JSON object
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) return [JSON.parse(objMatch[0])];
  throw new Error('No JSON found in response');
}
```

### Approach 2: Two-Step (if parsing becomes unreliable)

1. First call: get reasoning in natural language
2. Second call: "Convert this to JSON: [structured schema]"

This is more expensive (two calls per cycle) but more reliable. Only use if Approach 1 fails >10% of the time.

### Validation

Always validate parsed decisions against the action allowlist:

```javascript
const VALID_ACTIONS = ['start_session', 'stop_session', 'restart_session',
                        'reply_to_session', 'notify_human', 'no_action'];

function validateDecisions(decisions) {
  return decisions.filter(d =>
    VALID_ACTIONS.includes(d.action) &&
    (d.action === 'no_action' || d.project)
  );
}
```

---

## `claude -p` Behavior Notes

Important characteristics of `claude -p` for the brain module:

1. **Startup time:** ~1-3 seconds for process launch + model loading. Not instant like an API call, but acceptable for a 5-minute think cycle.

2. **Timeout:** Set a 30-second timeout. If Claude is thinking longer than that, something is wrong.

3. **Output size:** `claude -p` can return large outputs. Cap `maxBuffer` at 1MB to be safe.

4. **Concurrency:** Only run one `claude -p` at a time from the orchestrator. Multiple simultaneous calls could cause resource contention.

5. **Stdin for long prompts:** For prompts >4KB, pipe via stdin rather than command-line args (shell argument length limits).

6. **Exit codes:** `claude -p` returns 0 on success. Non-zero on error (network issues, auth problems, etc.).

7. **No conversation state:** Each `claude -p` call is independent. No message history between calls. This is exactly what we want — each think cycle is a fresh evaluation.

---

## Alternatives Considered

| Category | Recommended | Alternative | Why Not Alternative |
|----------|-------------|-------------|---------------------|
| LLM Interface | `claude -p` | `@anthropic-ai/sdk` | Max plan makes API billing unnecessary. Zero dependencies vs two packages. |
| LLM Interface | `claude -p` | Agent SDK | Wrong abstraction. Decision engine, not code agent. |
| LLM Framework | None (cli) | LangChain.js | Massive complexity for shell-out-to-cli. |
| Config | `config.json` | dotenv + .env | No secrets to manage. No API key. |
| Structured output | JSON-in-prompt | Tool use (API) | Tool use requires API SDK. JSON-in-prompt works with claude -p. |
| Cost tracking | None | CostTracker module | Max plan = unlimited. Nothing to track. |

---

## Sources

- Claude Code CLI documentation — `-p` print mode, `--model` flag
- [Claude Max Plan](https://claude.ai/pricing) — $200/mo unlimited usage
- Codebase analysis of existing orchestrator — Node.js child_process patterns
