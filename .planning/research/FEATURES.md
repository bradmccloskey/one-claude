# Feature Landscape

**Domain:** AI-powered multi-agent coding session orchestrator
**Researched:** 2026-02-15
**Mode:** Ecosystem (Features dimension)

## Context

This is a SUBSEQUENT MILESTONE feature map. The orchestrator (v2.0) already handles process management -- tmux session lifecycle, SMS commands, signal protocol, proactive scanning, digests. The v3.0 milestone adds Claude AI as the decision engine on top of this foundation.

The user manages ~18 projects on a Mac Mini, wants minimal interruption, and expects the orchestrator to be autonomous and smart. The central question is: what features make an AI orchestrator genuinely useful vs. what's over-engineering?

---

## Table Stakes

Features users expect from an AI-powered orchestrator. Without these, the AI layer adds cost but not value.

| # | Feature | Why Expected | Complexity | Depends On | Notes |
|---|---------|--------------|------------|------------|-------|
| T1 | **Anthropic API Integration** | Foundation -- without this, there is no AI layer | Low | None (new module) | Haiku 4.5 for routine decisions ($1/$5 MTok), Sonnet 4 for complex evaluation ($3/$15 MTok). Prompt caching critical for system prompts (90% savings on reads). |
| T2 | **Project State Comprehension** | AI must understand what each project is doing to make any decision | Medium | T1, existing scanner | Feed STATE.md, recent git log, signal files to Claude. Structured extraction: phase, blockers, last activity, next steps. Already parsed partially by scanner.js -- AI adds semantic understanding. |
| T3 | **Priority Scoring Engine** | Core value prop -- "what should I work on next?" | Medium | T1, T2 | Weighted scoring across 5-6 dimensions: revenue potential, deadline urgency, blocker freshness, momentum (recent activity), effort remaining, strategic alignment. Output: ranked list with rationale. |
| T4 | **Autonomous Session Launch** | Transforms orchestrator from reactive to proactive | Medium | T3, existing session-manager | When idle slots available AND priority queue has work, launch sessions without asking. Existing startSession() handles tmux mechanics -- AI decides WHEN and WHAT. |
| T5 | **Session Completion Evaluation** | Must judge "did this session accomplish something useful?" | Medium | T1, T2, existing signal-protocol | When completed.json fires: read summary, check git diff, compare against plan. Decide: advance to next phase, retry, or flag for human. LLM-as-judge pattern using structured rubric. |
| T6 | **Intelligent SMS Summaries** | Raw data dumps are useless at scale -- AI must synthesize | Medium | T1, existing messenger | Replace current formatted status with AI-generated summaries. "3 projects progressed today. web-scraping-biz shipped Apify update. crypto-trader blocked on API keys. income-dashboard idle 3 days." Constraint: SMS has ~1600 char limit per message. |
| T7 | **Cost Tracking and Budget Controls** | Autonomous API calls without limits = budget disaster | Low | T1 | Daily/weekly/monthly budget caps. Per-decision token logging. Alert when approaching limits. Hard stop at budget ceiling. Essential for autonomous operation -- 73% of teams lack this per AICosts.ai research. |
| T8 | **Decision Logging** | Must explain WHY it did what it did -- debugging and trust | Low | T1 | Every AI decision logged: input context, prompt, response, action taken. JSON append-only log. Essential for debugging bad decisions and building user trust. |

### Table Stakes Rationale

These 8 features are non-negotiable because without them the orchestrator is either:
- Not actually intelligent (T1, T2, T3)
- Not actually autonomous (T4)
- Not actually useful (T5, T6)
- Not actually safe to run unattended (T7, T8)

---

## Differentiators

Features that elevate this from "AI wrapper" to genuinely smart orchestrator. Not expected, but valued.

| # | Feature | Value Proposition | Complexity | Depends On | Notes |
|---|---------|-------------------|------------|------------|-------|
| D1 | **Cross-Project Conflict Detection** | Prevents sessions from stepping on each other | Medium | T2, T4 | Before launching session: check if another session touches overlapping files, shared dependencies, or the same port ranges. Example: don't run income-dashboard and web-scraping-biz collectors simultaneously if they share DB. AI can detect semantic conflicts humans miss. |
| D2 | **Adaptive Priority Learning** | Gets smarter about what the user actually values | High | T3, T8 | Track which AI recommendations user follows vs. overrides. Over time, adjust priority weights. "User always prioritizes revenue-generating projects over experiments" -- learn this. Requires decision log history analysis. |
| D3 | **Smart Error Recovery** | Don't just report errors -- try to fix them | Medium | T5, existing session-manager | When error.json fires: AI evaluates the error, decides if it's retryable (restart with refined prompt), needs a different approach (modify instructions), or truly needs human (credential issues, architecture decisions). Reduces notification noise by 40-60%. |
| D4 | **Revenue-Aware Scheduling** | Schedule revenue-impacting work during optimal hours | Medium | T3, T7 | Track which projects generate revenue (web-scraping-biz, mlx-inference-api, bandwidth-sharing). Prioritize these during high-availability hours. Deprioritize experiments during peak API cost periods. Requires project metadata in config. |
| D5 | **Session Prompt Engineering** | Context-rich prompts dramatically improve session quality | Medium | T2, T5 | Instead of generic "resume work" prompts, AI constructs targeted prompts: what was accomplished, what failed last time, specific next steps, known pitfalls. Use completed.json history and STATE.md evolution. Research shows context-aware prompts improve agent task completion by 30-50%. |
| D6 | **Proactive Staleness Detection** | Surface projects that are silently rotting | Low | T2 | Scan for: no git commits in N days, STATE.md unchanged, abandoned mid-phase. Alert: "crypto-trader hasn't been touched in 12 days and is mid-phase-2. Want me to resume it?" Low complexity, high value for 18-project portfolio. |
| D7 | **Natural Language SMS Commands** | "What should I work on?" instead of rigid "priority" command | Medium | T1, existing commands | Route ambiguous SMS through AI for interpretation. "How's the money stuff?" -> status on revenue-generating projects. "Anything need me?" -> filter to genuine human-required decisions only. Existing command router handles exact matches; AI handles everything else. |
| D8 | **Work Session Time Boxing** | Prevent runaway sessions from hogging resources | Low | T4, existing session-manager | Set max duration per session (e.g., 45 min). When time expires: capture tmux output, evaluate progress, decide restart vs. yield slot. Prevents one stuck session from blocking all 5 slots indefinitely. |
| D9 | **Intelligent Morning Digest** | AI-written daily briefing replaces template-based digest | Medium | T1, T2, T6 | Replace current digest.js template with AI-generated narrative: what happened overnight, what's blocked, what the AI plans to do today, what needs human decision. "Yesterday: 3 sessions completed, 1 errored. Today: planning to resume crypto-trader and start youtube-automation. Need your input on democrat-dollar signing certs." |

### Differentiator Prioritization

**Build first (high value, moderate complexity):**
- D5 (Session Prompt Engineering) -- immediate quality improvement
- D6 (Staleness Detection) -- low complexity, high portfolio value
- D8 (Time Boxing) -- safety mechanism for autonomous operation
- D3 (Smart Error Recovery) -- reduces notification noise

**Build second (high value, high complexity):**
- D1 (Cross-Project Conflict Detection)
- D7 (Natural Language SMS)
- D9 (Intelligent Morning Digest)
- D4 (Revenue-Aware Scheduling)

**Build last (requires data accumulation):**
- D2 (Adaptive Priority Learning) -- needs weeks of decision logs

---

## Anti-Features

Things to deliberately NOT build. These are common over-engineering traps in AI orchestration systems.

| # | Anti-Feature | Why Avoid | What to Do Instead |
|---|--------------|-----------|-------------------|
| A1 | **Multi-Model Routing / Model Selection** | Adds complexity for marginal gains. The orchestrator's decisions are not latency-sensitive enough to justify routing logic between Haiku/Sonnet/Opus per-request. | Pick two models: Haiku 4.5 for routine (priority scoring, status parsing) and Sonnet 4 for complex (evaluation, error analysis). Hardcode the selection per decision type. Revisit only if costs become a problem. |
| A2 | **Agent-to-Agent Communication** | The Claude Code sessions don't need to talk to each other. Cross-project coordination belongs in the orchestrator, not in a mesh between sessions. | Keep hub-and-spoke. Orchestrator is the only brain. Sessions communicate only via signal files (.orchestrator/). No A2A protocol, no shared memory between sessions. |
| A3 | **Fine-Grained Permission System** | Over-engineering for a single-user system. RBAC, approval workflows, and permission matrices add complexity for no audience. | The user is the only human. The orchestrator either acts autonomously or asks the user. Binary: act or ask. No roles, no approval chains. |
| A4 | **Persistent Vector Store / RAG** | Tempting but unnecessary at 18 projects. Full project context fits in a single Haiku prompt window. Embeddings add infra, latency, and failure modes. | Use direct file reads: STATE.md + last 10 git log entries + signal files. Total context per project is ~500-1000 tokens. All 18 projects summarized is ~10K tokens. Well within Haiku's 200K window. |
| A5 | **Web Dashboard / UI** | The user explicitly prefers SMS. Building a React dashboard is a distraction that won't get used. | SMS is the interface. The terminal REPL (already built) is the debug interface. If visualization is ever needed, pipe to income-dashboard (already built and running on port 8060). |
| A6 | **Automatic Git Branch Management** | Sessions already run in project directories. Adding git worktree isolation, branch creation, and merge logic is a rabbit hole. | Sessions work on whatever branch is checked out. The CLAUDE.md injection already tells sessions to make commits. Branch strategy is a per-project concern, not an orchestrator concern. |
| A7 | **Plugin / Extension System** | Extensibility architecture for a system with one user and one developer is pure YAGNI. | Hardcode everything. When new behavior is needed, modify the code. The entire orchestrator is ~800 lines. |
| A8 | **Conversation Memory Database** | Storing full SMS conversation history in a database for "context" across sessions. The existing 30-minute context window in commands.js is sufficient. | Keep the existing ephemeral context. The AI's decision context comes from project state files, not conversation history. If longer context is needed, extend the window -- don't build a database. |
| A9 | **Real-Time Session Output Streaming** | Capturing and processing tmux output in real-time for live monitoring. Massive complexity for minimal value when signal files already report key events. | Continue using signal files (needs-input, completed, error) as the communication protocol. These are the meaningful events. Streaming raw Claude Code output is noise. |
| A10 | **Complex Workflow Graphs / DAGs** | Building a DAG execution engine for multi-step workflows across projects. The orchestrator's job is pick-one-start-it, not orchestrate-complex-pipelines. | Keep the decision loop simple: scan state -> score priorities -> pick top N -> launch sessions -> evaluate results -> repeat. Linear, not graph-based. |

### Anti-Feature Rationale

The common thread: this orchestrator manages a single person's portfolio of side projects on a single Mac Mini. Enterprise patterns (RBAC, DAGs, vector stores, dashboards, plugins) add complexity for a use case that doesn't need them. The orchestrator should be *opinionated and simple*, not *flexible and complex*.

---

## Feature Dependencies

```
T1 (API Integration)
  |
  +-- T2 (State Comprehension)
  |     |
  |     +-- T3 (Priority Scoring)
  |     |     |
  |     |     +-- T4 (Autonomous Launch)
  |     |     |     |
  |     |     |     +-- D1 (Conflict Detection)
  |     |     |     +-- D8 (Time Boxing)
  |     |     |
  |     |     +-- D4 (Revenue Scheduling)
  |     |     +-- D6 (Staleness Detection)
  |     |
  |     +-- T5 (Completion Evaluation)
  |     |     |
  |     |     +-- D3 (Error Recovery)
  |     |     +-- D5 (Prompt Engineering)
  |     |
  |     +-- T6 (Intelligent Summaries)
  |           |
  |           +-- D9 (Morning Digest)
  |
  +-- T7 (Cost Tracking)
  +-- T8 (Decision Logging)
        |
        +-- D2 (Adaptive Learning)

D7 (Natural Language SMS) -- depends on T1 + existing command router
```

---

## Decision-Making Patterns

How the AI orchestrator should make decisions, based on ecosystem research.

### The Core Decision Loop

The orchestrator runs a continuous loop (not event-driven, not cron -- a steady heartbeat):

```
Every scan_interval (60s currently):
  1. PERCEIVE: Read all project states, signal files, session statuses
  2. REASON:  Feed context to AI, ask for prioritized action plan
  3. ACT:     Execute top action (launch, stop, evaluate, notify)
  4. LOG:     Record decision with full context
  5. REPORT:  If action affects user, compose intelligent notification
```

This is the "perceive-reason-act" pattern documented in LLM agent architecture research (TUM seminar paper, arxiv 2510.09244).

### Decision Types

| Decision | Trigger | Model | Latency Tolerance | Frequency |
|----------|---------|-------|-------------------|-----------|
| What to work on next | Idle session slot available | Haiku 4.5 | 5-10s OK | Every few minutes |
| Evaluate completed work | completed.json signal | Sonnet 4 | 30s OK | Per session completion |
| Assess error severity | error.json signal | Sonnet 4 | 30s OK | Per session error |
| Compose user notification | Any user-facing event | Haiku 4.5 | 5s OK | Per notification |
| Morning planning | 7 AM daily | Sonnet 4 | 60s OK | Once daily |
| Priority re-ranking | Project state change | Haiku 4.5 | 10s OK | Per state change |

### Priority Scoring Algorithm

Recommended weighted scoring model (based on RICE/WSJF frameworks adapted for this use case):

```
Score = (Revenue_Weight * revenue_potential)
      + (Urgency_Weight * time_sensitivity)
      + (Momentum_Weight * recent_activity_recency)
      + (Blocker_Weight * blocker_freshness)
      + (Effort_Weight * inverse_remaining_effort)
      + (Strategic_Weight * user_priority_override)

Where:
  revenue_potential:    0-10 (from project config metadata)
  time_sensitivity:     0-10 (deadlines, market timing)
  recent_activity:      decay function (active yesterday=10, week ago=5, month=1)
  blocker_freshness:    10 if newly unblocked, decays to 0
  remaining_effort:     inverted (nearly done=10, just started=2)
  user_priority_override: manual boost/suppress from SMS

Default weights: Revenue=0.30, Urgency=0.20, Momentum=0.15,
                 Blocker=0.15, Effort=0.10, Strategic=0.10
```

The AI doesn't just compute this formula -- it uses the scores as *input* to a reasoning prompt that can override raw scores with judgment. "crypto-trader scores highest but it's been failing repeatedly -- deprioritize until error is understood."

### Human-in-the-Loop Threshold

Based on research (Zapier, Permit.io, n8n patterns), the orchestrator should only interrupt the human for:

1. **Credential/access barriers** -- "democrat-dollar needs Apple signing certs, I can't get those"
2. **Ambiguous architecture decisions** -- "crypto-trader could use grid trading or DCA -- which strategy?"
3. **Significant spending** -- "about to launch 5 sessions, estimated API cost $2.40"
4. **Repeated failures** -- "web-scraping-biz has failed 3 times on the same task"
5. **Multi-project conflicts** -- "can't run both income-dashboard and mlx-inference without port conflict"

Everything else should be autonomous. The bias should be toward action, not toward asking.

---

## Cost Estimation

Estimated API costs for autonomous operation based on current Anthropic pricing.

### Per-Decision Costs

| Decision Type | Model | Input Tokens | Output Tokens | Cost |
|---------------|-------|-------------|---------------|------|
| Priority scan (all 18 projects) | Haiku 4.5 | ~12K | ~2K | $0.022 |
| Session evaluation | Sonnet 4 | ~5K | ~1K | $0.030 |
| Error assessment | Sonnet 4 | ~3K | ~1K | $0.024 |
| SMS composition | Haiku 4.5 | ~2K | ~500 | $0.005 |
| Morning digest | Sonnet 4 | ~15K | ~2K | $0.075 |

### Daily Cost Estimate (moderate autonomy)

- 24 priority scans/day (every hour): ~$0.53
- 8 session evaluations/day: ~$0.24
- 3 error assessments/day: ~$0.07
- 10 SMS compositions/day: ~$0.05
- 1 morning digest: ~$0.08
- **Daily total: ~$0.97**
- **Monthly total: ~$29/month**

### With Prompt Caching (recommended)

System prompts and project metadata can be cached (90% read discount):
- Estimated 60% of input tokens are cacheable
- **Optimized monthly: ~$15-18/month**

### Budget Recommendation

Set initial daily budget at $3.00 (3x estimated daily to allow burst). Monthly hard cap at $50. This provides headroom for heavy days while preventing runaways.

---

## MVP Recommendation

For MVP (first usable version of AI-powered orchestration), prioritize:

### Must Ship (Phase 1)
1. **T1** - Anthropic API integration with Haiku 4.5
2. **T7** - Cost tracking and budget controls (BEFORE autonomous operation)
3. **T8** - Decision logging (BEFORE autonomous operation)
4. **T2** - Project state comprehension (feed scanner output to AI)
5. **T3** - Priority scoring engine

### Ship Next (Phase 2)
6. **T4** - Autonomous session launch
7. **T5** - Session completion evaluation
8. **T6** - Intelligent SMS summaries
9. **D8** - Time boxing (safety mechanism)

### Enhance (Phase 3)
10. **D5** - Smart session prompts
11. **D3** - Error recovery
12. **D6** - Staleness detection
13. **D9** - Intelligent morning digest

### Later
14. **D1** - Cross-project conflict detection
15. **D7** - Natural language SMS
16. **D4** - Revenue-aware scheduling
17. **D2** - Adaptive learning (needs data accumulation)

**Phase ordering rationale:** Safety mechanisms (T7, T8) must exist before autonomous operation (T4). The AI must understand state (T2) before it can score priorities (T3). Evaluation (T5) should exist before the AI is launching sessions unsupervised. Differentiators layer on top once the core loop works.

---

## Sources

### HIGH Confidence (Official Documentation)
- [Anthropic Claude API Pricing](https://platform.claude.com/docs/en/about-claude/pricing) - Verified pricing for all models, batch processing, prompt caching
- [Claude Tool Use Implementation](https://platform.claude.com/docs/en/agents-and-tools/tool-use/implement-tool-use) - Tool use patterns and best practices
- [Claude Agent SDK Overview](https://platform.claude.com/docs/en/agent-sdk/overview) - Agent architecture patterns

### MEDIUM Confidence (Multiple Sources Agree)
- [Azure AI Agent Design Patterns](https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/ai-agent-design-patterns) - Orchestration patterns (supervisor, hub-spoke, mesh)
- [Addy Osmani - Future of Agentic Coding](https://addyosmani.com/blog/future-agentic-coding/) - Conductor vs. orchestrator model
- [Auto-Claude](https://github.com/AndyMik90/Auto-Claude) - Multi-agent coding framework with kanban, parallel execution
- [TUM Autonomous Agent Fundamentals](https://arxiv.org/html/2510.09244v1) - Perceive-reason-act architecture pattern
- [AICosts.ai Agent Cost Crisis](https://www.aicosts.ai/blog/ai-agent-cost-crisis-budget-disaster-prevention-guide) - 73% of teams lack cost tracking
- [Zapier Human-in-the-Loop Patterns](https://zapier.com/blog/human-in-the-loop/) - Conditional interruption, async review channels

### LOW Confidence (Single Source, Verify Later)
- [Galileo Multi-Agent Coordination](https://galileo.ai/blog/multi-agent-coordination-strategies) - Token duplication rates (1.5x-7x claims)
- [TensorZero Commit Evaluation](https://www.tensorzero.com/blog/automatically-evaluating-ai-coding-assistants-with-each-git-commit/) - Automated coding quality assessment via git
- [Kore.ai Orchestration Patterns](https://www.kore.ai/blog/choosing-the-right-orchestration-pattern-for-multi-agent-systems) - Supervisor vs. adaptive network patterns
