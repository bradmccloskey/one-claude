# Technology Stack: v3.0 AI-Powered Orchestrator

**Project:** project-orchestrator
**Researched:** 2026-02-15
**Dimension:** Stack additions for Claude AI decision engine
**Confidence:** HIGH (verified with official docs)

## Executive Decision: Agent SDK vs Raw API

**Recommendation: Use `@anthropic-ai/sdk` (raw Anthropic SDK), NOT `@anthropic-ai/claude-agent-sdk`.**

This is the most important decision in this document. Here is why.

### Why NOT the Claude Agent SDK

The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`, v0.2.37 as of Feb 2026) is designed for building agents that autonomously read files, run commands, edit code, and execute complex workflows. It gives you Claude Code's full toolset: Read, Write, Edit, Bash, Glob, Grep, WebSearch, etc.

That is exactly what you do NOT want for a decision engine. The orchestrator already manages Claude Code CLI sessions via tmux. The Agent SDK would create a second, competing agentic layer -- another Claude instance that reads files and runs commands. This creates:

1. **Redundant execution.** The orchestrator's job is to DECIDE what to work on, then launch a Claude Code session (via tmux) to DO the work. The Agent SDK conflates deciding and doing.

2. **Cost explosion.** Agent SDK sessions consume 7x more tokens than standard API calls because they maintain their own context window, run tools, and iterate. The orchestrator makes 20-50 decisions per day. At Agent SDK cost levels, that is burning money on decision-making that should be cheap.

3. **Architectural confusion.** You would have Claude Agent SDK sessions launching Claude Code CLI sessions. Two agentic loops fighting over the same filesystem and project state. This is the "subagent cost explosion" pattern that has burned real teams.

4. **Dependency weight.** The Agent SDK bundles the entire Claude Code runtime. That is massive overkill for structured decision-making.

### Why the Raw Anthropic SDK

The raw `@anthropic-ai/sdk` gives you exactly what the decision engine needs:

- **Messages API** for structured prompting (system prompt + context + question = decision)
- **Tool use** for structured output (define tools like `prioritize_projects`, `evaluate_session`, `launch_session`)
- **Prompt caching** for cost control (system prompt + project context stays cached)
- **Streaming** for real-time progress on long evaluations
- **Token tracking** for cost monitoring
- **Lightweight** -- just an HTTP client with TypeScript types

The orchestrator's AI brain should be a **decision function**, not an agent. It receives context (project states, session outputs, signal files), reasons about it, and returns a structured decision. The Anthropic SDK is purpose-built for this.

### When Would You Use the Agent SDK?

Only if the orchestrator itself needed to edit files, run commands, or browse the web as part of its core loop. It does not -- that is what the managed Claude Code sessions do.

---

## Recommended Stack Additions

### Core: Anthropic SDK

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| `@anthropic-ai/sdk` | latest (npm) | Claude API access for decision-making | Official SDK. Messages API, tool use, streaming, prompt caching. Lightweight. TypeScript-native. |

**Install:**
```bash
npm install @anthropic-ai/sdk
```

**Configuration:**
```bash
# Set in environment or .env
export ANTHROPIC_API_KEY=sk-ant-...
```

**Source:** [Official SDK docs](https://platform.claude.com/docs/en/api/client-sdks), [GitHub](https://github.com/anthropics/anthropic-sdk-typescript)

### Model Selection

| Model | Price (Input/Output per MTok) | Use For | When |
|-------|-------------------------------|---------|------|
| **Claude Haiku 4.5** | $1 / $5 | Routine decisions: session health checks, simple prioritization, SMS formatting | Every scan cycle (every 60s), high volume |
| **Claude Sonnet 4.5** | $3 / $15 | Complex decisions: cross-project prioritization, progress evaluation, work planning | On-demand when projects need attention (a few times per day) |
| **Claude Opus 4.6** | $5 / $25 | Strategic decisions: weekly planning, major reprioritization, "should I wake the human?" | Rarely, maybe weekly digest or when stakes are high |

**Recommendation:** Default to Haiku 4.5 for most orchestrator decisions. The orchestrator makes many small decisions frequently -- the quality difference between Haiku and Sonnet for "which project should I work on next?" is minimal, but the cost difference is 3-5x. Escalate to Sonnet for genuinely complex reasoning (evaluating whether a session's output was good, deciding between conflicting priorities).

**Pricing verified:** [Official Anthropic pricing page](https://platform.claude.com/docs/en/about-claude/pricing), accessed 2026-02-15.

### Cost Control Strategy

**Prompt Caching** is critical for the orchestrator. The system prompt + project roster + priority rules will be sent with EVERY API call. Without caching, you pay full input price every 60 seconds.

| Cache Strategy | Token Cost | Notes |
|----------------|-----------|-------|
| No caching | $1/MTok per call (Haiku) | Unsustainable at 60s intervals |
| 5-min cache (default) | $0.10/MTok cache hits | System prompt cached, user message uncached. Perfect for orchestrator. |
| 1-hour cache | $0.10/MTok hits, $2/MTok writes | Only if scanning interval drops below 5 min |

**Implementation pattern:**
```typescript
const response = await client.messages.create({
  model: "claude-haiku-4-5-20250929",
  max_tokens: 1024,
  system: [
    {
      type: "text",
      text: ORCHESTRATOR_SYSTEM_PROMPT, // ~2000 tokens, rarely changes
    },
    {
      type: "text",
      text: projectContextSnapshot,      // ~3000 tokens, changes per scan
      cache_control: { type: "ephemeral" }
    }
  ],
  messages: [
    { role: "user", content: "What should I work on next?" }
  ]
});
```

**Cache minimum thresholds:**
- Haiku 4.5: 4096 tokens minimum to cache
- Sonnet 4.5: 1024 tokens minimum to cache
- Cache hit = 10% of input price
- Cache write = 125% of input price (amortized across hits)

**Budget controls:**

| Control | Value | Rationale |
|---------|-------|-----------|
| Monthly budget cap | $20-30 | 18 projects, scans every 60s, mostly Haiku |
| Per-decision token limit | max_tokens: 1024 | Decisions are short. No need for long outputs. |
| Daily cost tracking | Log `response.usage` | Track actual spend vs budget |
| Escalation threshold | Sonnet only when score > threshold | Avoid expensive model for trivial decisions |

**Estimated monthly costs (Haiku 4.5 primary):**

| Activity | Frequency | Tokens/Call | Monthly Cost |
|----------|-----------|-------------|--------------|
| Routine scan decisions | ~1440/day | ~5K in, ~500 out | ~$4.50/mo |
| Progress evaluations | ~20/day | ~8K in, ~1K out | ~$2.00/mo |
| Session launch decisions | ~10/day | ~6K in, ~800 out | ~$0.80/mo |
| Morning digest (Sonnet) | 1/day | ~15K in, ~2K out | ~$2.00/mo |
| Complex prioritization (Sonnet) | ~5/day | ~10K in, ~1.5K out | ~$3.00/mo |
| **Total estimated** | | | **~$12-15/mo** |

With prompt caching reducing input costs by ~90% on cache hits, actual cost could be significantly lower (~$5-8/mo).

**Source:** [Prompt caching docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)

### Supporting Libraries (What NOT to Add)

| Library | Verdict | Rationale |
|---------|---------|-----------|
| `langchain` / `llamaindex` | **DO NOT ADD** | Massive abstraction layer. The orchestrator needs direct API control, not a framework that hides prompts and adds latency. |
| `@anthropic-ai/claude-agent-sdk` | **DO NOT ADD** | See detailed analysis above. Wrong tool for decision-making. |
| `zod` | **CONSIDER** | Already a dependency of the Anthropic SDK. Useful for validating tool use responses if you use structured output. Low cost to adopt. |
| `dotenv` | **ADD** | Tiny, standard. Store ANTHROPIC_API_KEY separate from config.json. |
| `tiktoken` / token counters | **DO NOT ADD** | The Anthropic SDK returns token counts in `response.usage`. No need for client-side counting. |
| `winston` / `pino` | **CONSIDER later** | Current logging is console.log with timestamps. Fine for now. Add structured logging when you need cost dashboards. |
| Any vector DB | **DO NOT ADD** | The orchestrator does not need RAG. It reads STATE.md files and signal files directly. Context is small (<10K tokens). |
| `openai` SDK | **DO NOT ADD** | Stick with one LLM provider. Anthropic Claude is the right choice given the entire ecosystem is Claude-based. |

### dotenv

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| `dotenv` | ^16.x | Load ANTHROPIC_API_KEY from .env file | Standard practice. Keeps secrets out of config.json. Already used by most Node.js projects. |

```bash
npm install dotenv
```

---

## Integration Architecture with Existing Stack

### New Module: `lib/brain.js`

The AI decision engine should be a single new module that integrates with the existing architecture:

```
index.js                    (main loop - existing)
  |-- lib/commands.js       (SMS routing - existing)
  |-- lib/scanner.js        (STATE.md reading - existing)
  |-- lib/session-manager.js (tmux management - existing)
  |-- lib/brain.js          (NEW: AI decision engine)
        |-- Anthropic SDK client
        |-- System prompt management
        |-- Decision functions (prioritize, evaluate, plan)
        |-- Cost tracking
        |-- Prompt caching layer
```

### Integration Points

| Existing Module | How Brain Integrates | Direction |
|----------------|---------------------|-----------|
| `scanner.js` | Brain receives scanned project data as context | Scanner -> Brain |
| `session-manager.js` | Brain calls start/stop/restart based on decisions | Brain -> SessionManager |
| `process-monitor.js` | Brain receives running session info for awareness | ProcessMonitor -> Brain |
| `signal-protocol.js` | Brain receives signal data, decides response | SignalProtocol -> Brain |
| `commands.js` | Some SMS commands trigger Brain decisions | Commands -> Brain |
| `messenger.js` | Brain composes intelligent SMS via LLM | Brain -> Messenger |
| `scheduler.js` | Brain runs on scan interval, respects quiet hours | Scheduler -> Brain |
| `state.js` | Brain reads/writes orchestrator state | Brain <-> State |

### No Changes to Existing Modules

The existing modules should NOT be modified significantly. The Brain module is an **addition** that sits alongside them. It consumes their output and issues commands through their existing interfaces. This minimizes risk.

### Config Additions

Add to `config.json`:

```json
{
  "ai": {
    "enabled": true,
    "defaultModel": "claude-haiku-4-5-20250929",
    "escalationModel": "claude-sonnet-4-5-20250929",
    "maxTokens": 1024,
    "monthlyBudgetUsd": 25,
    "autonomousMode": false,
    "decisionLog": true
  }
}
```

The `autonomousMode: false` flag is critical for safe rollout. Start with AI making recommendations via SMS ("I think we should work on X next. Go?"), then graduate to autonomous launches.

---

## Tool Use for Structured Decisions

The Anthropic SDK supports tool use (function calling). This is how the Brain should return structured decisions instead of free-text:

```typescript
const tools = [
  {
    name: "prioritize_projects",
    description: "Rank projects by priority for the next work session",
    input_schema: {
      type: "object",
      properties: {
        rankings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              project: { type: "string" },
              priority: { type: "number", minimum: 1, maximum: 10 },
              reason: { type: "string" },
              action: { type: "string", enum: ["start", "continue", "stop", "skip"] }
            },
            required: ["project", "priority", "reason", "action"]
          }
        }
      },
      required: ["rankings"]
    }
  },
  {
    name: "evaluate_session",
    description: "Judge whether a completed session made good progress",
    input_schema: {
      type: "object",
      properties: {
        project: { type: "string" },
        verdict: { type: "string", enum: ["good", "partial", "stuck", "failed"] },
        summary: { type: "string" },
        next_action: { type: "string", enum: ["continue", "restart", "escalate", "stop"] },
        human_needed: { type: "boolean" },
        human_question: { type: "string" }
      },
      required: ["project", "verdict", "summary", "next_action", "human_needed"]
    }
  },
  {
    name: "compose_message",
    description: "Compose an intelligent SMS to the human",
    input_schema: {
      type: "object",
      properties: {
        urgency: { type: "string", enum: ["info", "action", "urgent"] },
        message: { type: "string", maxLength: 1000 },
        requires_response: { type: "boolean" }
      },
      required: ["urgency", "message", "requires_response"]
    }
  }
];
```

This pattern forces the AI to return structured, parseable decisions rather than free-text that needs parsing.

**Source:** [Anthropic Tool Use docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview)

---

## Node.js Compatibility

The existing project uses CommonJS (`require()`). The Anthropic SDK supports both CommonJS and ESM:

```javascript
// CommonJS (current project style)
const Anthropic = require("@anthropic-ai/sdk").default;

// OR if that fails:
const { Anthropic } = require("@anthropic-ai/sdk");
```

No need to migrate to ESM. The SDK works with the current project structure.

**Minimum Node.js version:** 18+ (the Anthropic SDK requires Node.js 20+, but works on 18 with minor polyfills). Verify your Node version:

```bash
node --version  # Should be 18+ (ideally 20+)
```

---

## Full Installation Command

```bash
cd /Users/claude/projects/project-orchestrator
npm install @anthropic-ai/sdk dotenv
```

That is it. Two packages. The entire AI brain capability comes from one SDK and one env loader.

---

## Alternatives Considered

| Category | Recommended | Alternative | Why Not Alternative |
|----------|-------------|-------------|---------------------|
| LLM SDK | `@anthropic-ai/sdk` | `@anthropic-ai/claude-agent-sdk` | Wrong abstraction level. Decision engine, not code agent. See detailed analysis above. |
| LLM SDK | `@anthropic-ai/sdk` | OpenAI SDK | Entire ecosystem is Claude. No reason to fragment. |
| LLM Framework | None (raw SDK) | LangChain.js | Adds complexity, hides prompts, harder to debug. Raw SDK gives full control. |
| LLM Framework | None (raw SDK) | Vercel AI SDK | Nice but unnecessary abstraction. We need one provider, one call pattern. |
| Config | dotenv + config.json | YAML configs | JSON already works. dotenv just adds .env for secrets. |
| Token counting | API response.usage | tiktoken | SDK gives us usage data. No need to count locally. |
| Vector store | None | Pinecone/Chroma | Context is <10K tokens. No RAG needed. Direct file reads. |
| Cost tracking | In-memory + log | PostHog/Datadog | Overkill for personal use. Track in .state.json. |

---

## Sources

- [Anthropic SDK TypeScript - GitHub](https://github.com/anthropics/anthropic-sdk-typescript) -- HIGH confidence
- [Claude Agent SDK - Overview](https://platform.claude.com/docs/en/agent-sdk/overview) -- HIGH confidence
- [Claude Agent SDK - TypeScript Reference](https://platform.claude.com/docs/en/agent-sdk/typescript) -- HIGH confidence
- [Claude Agent SDK - Cost Tracking](https://platform.claude.com/docs/en/agent-sdk/cost-tracking) -- HIGH confidence
- [Anthropic Pricing](https://platform.claude.com/docs/en/about-claude/pricing) -- HIGH confidence
- [Prompt Caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) -- HIGH confidence
- [Client SDKs](https://platform.claude.com/docs/en/api/client-sdks) -- HIGH confidence
- [Agent SDK npm](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) -- v0.2.37, 1.85M weekly downloads -- HIGH confidence
