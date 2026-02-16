# Research Summary: v3.0 AI Decision Engine

**Project:** project-orchestrator v3.0
**Research Date:** 2026-02-15
**Research Scope:** Adding Claude AI decision-making layer to existing process manager
**Confidence:** HIGH (verified against official Anthropic documentation and codebase analysis)

---

## Executive Summary

The v3.0 milestone adds an AI decision engine on top of the existing v2.0 orchestrator, transforming it from a human-controlled process manager into an autonomous agent that decides what to work on. The research reveals a clear technical path: use the raw Anthropic SDK (not the Agent SDK) with Haiku 4.5 for routine decisions, integrate via a new `lib/brain.js` module that consumes existing scanner/signal data, and enforce strict cost controls before enabling autonomous operation.

The recommended approach is a **two-tier model strategy** (Haiku for 90% of decisions, Sonnet for complex reasoning), a **5-minute think cycle** separate from the existing 60-second scan, and a **structured tool use** pattern to ensure parseable decisions. The AI layer is additive—it sits alongside existing modules as a decision engine, not a replacement for process management.

Critical risks center on cost control: without budget caps and change-detection gating, API costs could reach $1,600+/month instead of the target $6-9/month. Secondary risks include runaway automation (AI starting too many sessions), stale state decisions (acting on outdated information), and hallucinated project understanding (AI misreading what a project needs). All critical mitigations must ship in Phase 1 before autonomous operation begins.

---

## Key Findings

### From STACK.md: Technology Decisions

**Core Decision: Use Raw Anthropic SDK, NOT Agent SDK**

The Agent SDK (`@anthropic-ai/claude-agent-sdk`) is designed for autonomous code agents with full Read/Write/Bash tooling. Using it here would create a second agentic layer competing with the Claude Code sessions the orchestrator manages—a "subagent cost explosion" pattern that burns 7x more tokens. The raw SDK (`@anthropic-ai/sdk`) provides exactly what's needed: Messages API, tool use for structured output, prompt caching, and token tracking.

**Stack Additions:**
- `@anthropic-ai/sdk` (latest) — official TypeScript SDK for Claude API
- `dotenv` (^16.x) — load ANTHROPIC_API_KEY from .env
- No LangChain, no vector stores, no additional frameworks

**Model Strategy:**
- **Claude Haiku 4.5** ($1/$5 per MTok) — routine decisions, 90% of calls
- **Claude Sonnet 4.5** ($3/$15 per MTok) — complex evaluation, 10% of calls
- **Opus 4.6** ($5/$25 per MTok) — rarely, strategic planning only

**Cost Control:**
- Prompt caching reduces input costs by 90% (system prompt cached at 1h TTL)
- Target: $6-9/month optimized with caching
- Budget caps: $2/day hard limit, auto-disable on breach

### From FEATURES.md: Feature Categories

**8 Table Stakes (non-negotiable):**
1. Anthropic API Integration — foundation for all AI decisions
2. Project State Comprehension — semantic understanding of STATE.md + signals
3. Priority Scoring Engine — weighted algorithm across 5-6 dimensions
4. Autonomous Session Launch — proactive "what to work on next" execution
5. Session Completion Evaluation — LLM-as-judge for session output quality
6. Intelligent SMS Summaries — synthesized updates, not raw data dumps
7. Cost Tracking and Budget Controls — daily/monthly caps, token logging
8. Decision Logging — every AI decision with context for debugging and trust

**9 Differentiators (high-value enhancements):**
1. Cross-Project Conflict Detection — prevent sessions from stepping on each other
2. Adaptive Priority Learning — learn user preferences from override patterns
3. Smart Error Recovery — evaluate and retry errors, not just report
4. Revenue-Aware Scheduling — prioritize income-generating projects
5. Session Prompt Engineering — context-rich prompts improve quality 30-50%
6. Proactive Staleness Detection — surface abandoned projects
7. Natural Language SMS Commands — AI interprets ambiguous SMS
8. Work Session Time Boxing — prevent runaway sessions (45-min cap)
9. Intelligent Morning Digest — AI-written daily briefing

**10 Anti-Features (deliberately avoided):**
- Multi-model routing logic (just pick Haiku vs Sonnet per decision type)
- Agent-to-agent communication (hub-and-spoke only)
- Fine-grained permissions (single-user system, binary act-or-ask)
- Persistent vector store (18 projects fit in one prompt window)
- Web dashboard (SMS is the interface)
- Automatic git branch management (too much complexity)
- Plugin/extension system (pure YAGNI for single user)
- Conversation memory database (30-min context window sufficient)
- Real-time session output streaming (signal files are enough)
- Complex workflow DAGs (linear decision loop, not graph-based)

### From ARCHITECTURE.md: Component Design

**New Modules (4 total):**

1. **AI Brain** (`lib/ai-brain.js`) — orchestrates think cycle, calls Claude API, enforces budget
2. **Context Assembler** (`lib/context-assembler.js`) — gathers project states into compact prompt (~2-4K tokens)
3. **Decision Executor** (`lib/decision-executor.js`) — parses structured AI output, executes actions via existing modules
4. **Cost Tracker** (`lib/cost-tracker.js`) — tracks daily/monthly spend, enforces budget ceiling

**Modified Modules:**
- `index.js` — add 5-minute `aiThinkCycle()` interval
- `commands.js` — add AI control commands (on/off/status/budget/level)
- `state.js` — extend with `aiDecisionHistory` and `aiCosts` tracking
- `config.json` — add `ai` section (model, budget, interval, enabled)

**Unchanged Modules (existing data/action layers):**
- `messenger.js`, `scanner.js`, `signal-protocol.js`, `process-monitor.js`, `session-manager.js`, `scheduler.js`, `digest.js`

**Think Cycle Timing:**
- 5-minute interval (not 60 seconds) — allows sessions to produce meaningful output
- Separate from existing 60s scan (which still handles urgent alerts)
- AI thinks in background, does not block message polling

**Two-Tier Model Approach:**
- 260 Haiku calls/day (~$0.007 each) = $1.82/day
- 29 Sonnet calls/day (~$0.020 each) = $0.58/day
- **Blended cost: ~$2.40/day = ~$72/month before caching**
- **With prompt caching: ~$6-9/month (90% cache hit rate)**

**Escalation Triggers (when to use Sonnet):**
- Multiple projects need attention simultaneously
- Evaluating session output quality
- Cross-project conflicts detected
- Budget approaching limit (meta-decision)

### From PITFALLS.md: Critical Risks

**4 Critical Pitfalls (must address in Phase 1):**

1. **API Cost Explosion** (CATASTROPHIC) — unthrottled calls every 60s could cost $1,600+/month
   - Mitigation: Change-detection gate, daily budget ($2 cap), Haiku-first, context budget per call

2. **Runaway Automation** (CRITICAL) — AI starts/stops sessions inappropriately, crashes Mac Mini
   - Mitigation: Action allowlist, cooldown timers, resource checks (2GB free RAM), protected sessions

3. **Stale State Decisions** (HIGH) — AI acts on outdated information, duplicate sessions
   - Mitigation: Atomic state snapshots, optimistic locking, 30s decision expiry, debounce changes

4. **Hallucinated Understanding** (HIGH) — AI misreads project needs, wastes sessions
   - Mitigation: Explicit blocker enforcement, user priority overrides file, confidence scoring

**3 Moderate Pitfalls:**
- Token context bloat (inflates costs 5-10x) — use two-stage reasoning, delta-only context
- Structured output parsing failures (15-20% failure rate without tool use) — use Anthropic tool use from day one
- Notification spam (iMessage throttles at ~200/hour) — tier system, 10-15 SMS/day budget

**Cost Scenarios:**
- Naive: $1,620/month (Sonnet every 60s, no optimization)
- Optimized: $6-9/month (Haiku on change, Sonnet escalation, caching)
- Budget ceiling: $60/month ($2/day hard cap)

---

## Implications for Roadmap

### Recommended Phase Structure

The research strongly suggests a **safety-first build order**: cost controls and guardrails must exist before the AI can act autonomously. Here's the recommended 3-phase structure:

#### Phase 1: Foundation and Safety (MUST SHIP TOGETHER)

**Goal:** Get AI integration working in observe-only mode with all safety mechanisms.

**What to Build:**
- Anthropic SDK integration with tool use (not raw JSON)
- Cost Tracker with daily/monthly budget caps and auto-disable
- Decision Logging (every AI decision with full context)
- Context Assembler (compact state representation, ~2-4K tokens)
- AI Brain in `autonomyLevel: "observe"` mode (thinks but doesn't act)
- SMS commands: `ai on/off`, `ai status`, `ai budget`

**What to Deliver:**
AI that makes recommendations via SMS ("I think we should work on X next. Go?") but does NOT execute autonomously. User can inspect decision quality before enabling execution.

**Critical Mitigations from Pitfalls:**
- Cost explosion prevention (Pitfall #1) — daily budget, change-detection gate
- Structured output parsing (Pitfall #6) — tool use from day one
- Main loop blocking (Pitfall #9) — async AI calls
- Rate limit handling (Pitfall #10) — separate API key, backoff

**Success Criteria:**
- AI recommends sensible priorities when prompted
- Budget tracking works correctly (no API call without tracking)
- Decision log captures all reasoning
- SMS notifications are clear and actionable
- Cost stays under $0.50/day in observe mode

#### Phase 2: Autonomous Execution (ENABLE ACTIONS)

**Goal:** Allow AI to start/stop/restart sessions autonomously with guardrails.

**What to Build:**
- Decision Executor with action allowlist
- Guardrails framework: cooldown timers, resource checks, protected sessions
- Atomic state snapshots and optimistic locking
- Priority overrides file (user veto power)
- Upgrade to `autonomyLevel: "cautious"` (can start/answer, notifies for stops)
- Session outcome tracking

**What to Deliver:**
AI that autonomously starts sessions for high-priority projects, answers signal inputs, and manages session lifecycle—but with safeguards against runaway behavior.

**Critical Mitigations from Pitfalls:**
- Runaway automation (Pitfall #2) — action allowlist, cooldowns, resource awareness
- Stale state (Pitfall #3) — atomic snapshots, decision expiry
- Hallucinated understanding (Pitfall #4) — priority overrides, confidence scoring

**Success Criteria:**
- AI successfully launches sessions for genuinely high-priority work
- No duplicate sessions (stale state prevented)
- No memory exhaustion (resource checks work)
- User can override AI decisions via priority file
- Cost stays under $1.50/day with moderate autonomous activity

#### Phase 3: Intelligence and Polish (QUALITY IMPROVEMENTS)

**Goal:** Make the AI smarter and more context-aware.

**What to Build:**
- Two-tier model selection (Haiku routine, Sonnet complex)
- Escalation triggers for complex decisions
- Session Prompt Engineering (context-rich prompts per project)
- Smart Error Recovery (evaluate and retry, not just report)
- Proactive Staleness Detection
- Intelligent Morning Digest (replace template-based)
- Notification tier system (urgent/summary/debug)
- Time boxing for work sessions (45-min cap)

**What to Deliver:**
AI that makes nuanced decisions, recovers from errors intelligently, and communicates effectively without spam.

**Critical Mitigations from Pitfalls:**
- Context bloat (Pitfall #5) — two-stage reasoning, prompt caching
- Notification spam (Pitfall #7) — tier system, daily message budget
- Model regression (Pitfall #8) — pin versions, eval suite

**Success Criteria:**
- AI correctly escalates to Sonnet for genuinely complex decisions
- Session prompts are context-rich and improve completion rates
- Error recovery reduces notification noise by 40-60%
- Morning digest is valuable and concise
- Cost optimized to $6-9/month with full autonomous operation

### Deferred to Future (Post-MVP)

- Cross-Project Conflict Detection (D1) — valuable but requires deep dependency analysis
- Natural Language SMS Commands (D7) — nice-to-have, existing command router handles 95% of cases
- Revenue-Aware Scheduling (D4) — requires project metadata schema evolution
- Adaptive Priority Learning (D2) — needs weeks of decision log data

---

## Research Flags

### Phases That Need Deeper Research

**Phase 1: API Integration**
- Well-documented by Anthropic — skip additional research
- Cost control is math, not discovery

**Phase 2: Autonomous Execution**
- **CONSIDER RESEARCH:** Optimistic locking patterns for file-based state
- **CONSIDER RESEARCH:** Session outcome evaluation rubrics (what defines "good progress"?)
- Standard patterns exist, but tuning to this specific codebase may need iteration

**Phase 3: Intelligence and Polish**
- **SKIP RESEARCH:** Two-tier model selection is straightforward (if-else based on triggers)
- **SKIP RESEARCH:** Prompt engineering is iterative testing, not research
- **CONSIDER RESEARCH:** Notification fatigue UX patterns (what makes a good digest?)

### Areas With High Confidence (No Research Needed)

- Anthropic API mechanics (official docs are comprehensive)
- Cost calculations (verified pricing, clear math)
- tmux session management (already working in v2.0)
- Signal protocol (already proven in existing codebase)
- SMS integration (already built and reliable)

### Gaps to Address During Planning

1. **Session Evaluation Rubric:** What makes a "successful" vs "failed" session? Needs user input on criteria (git commits? tests passing? STATE.md progress?).

2. **Priority Weights:** The scoring algorithm uses weights (Revenue=0.30, Urgency=0.20, etc.). These are recommendations—user should validate or adjust based on actual priorities.

3. **Notification Preferences:** The research recommends 10-15 SMS/day. Is this the right number for this user? Should quiet hours expand during autonomous operation?

4. **Resource Limits:** The 2GB free RAM threshold for starting sessions is a guess. Actual Mac Mini memory profile under load should be measured.

5. **API Key Strategy:** Should the orchestrator use a separate Anthropic API key from Claude Code sessions? Separate keys isolate rate limits but cost $0 to set up—just a workspace decision.

---

## Confidence Assessment

| Research Area | Confidence | Notes |
|---------------|-----------|-------|
| **Stack** | **HIGH** | Official Anthropic SDK docs, verified pricing, clear technical path. The "raw SDK vs Agent SDK" decision is strongly supported by architecture analysis. |
| **Features** | **HIGH** | Feature categories drawn from ecosystem research (Zapier, n8n, Auto-Claude patterns) and user's existing workflow. Table stakes are well-defined. |
| **Architecture** | **HIGH** | Codebase analysis shows clean integration points. New modules fit naturally alongside existing scanner/session-manager. Think cycle timing and cost math are sound. |
| **Pitfalls** | **MEDIUM-HIGH** | Cost explosion risks are verified by real incidents. Guardrail patterns are industry-standard. Some edge cases (race conditions, hallucination mitigation) may need tuning in practice. |

### Known Gaps

1. **Session Evaluation Criteria:** The AI needs to judge "did this session accomplish something useful?" The research proposes git diff + STATE.md comparison + completion time, but the rubric needs validation against actual sessions.

2. **User Priority Preferences:** The recommended priority weights (Revenue=0.30, etc.) are based on RICE/WSJF frameworks, but the user's actual preferences may differ. This needs calibration.

3. **Escalation Thresholds:** When should the AI escalate from Haiku to Sonnet? The research suggests "multiple blockers" or "evaluating session output," but exact triggers need testing.

4. **Cache Hit Rate:** Prompt caching savings assume 90% cache hit rate. Actual rate depends on how often system prompts and project metadata change. Needs measurement.

5. **Real-World Token Counts:** Context size estimates (2-4K tokens) are based on analysis of sample STATE.md files. Actual token counts across all 18 projects need measurement.

### Confidence by Phase

- **Phase 1 (Foundation):** HIGH confidence—API integration is well-documented, cost tracking is math, observe-mode has no unknowns.
- **Phase 2 (Autonomous Execution):** MEDIUM-HIGH confidence—guardrails are standard patterns, but stale state prevention and session evaluation need iteration.
- **Phase 3 (Intelligence):** MEDIUM confidence—two-tier model is straightforward, but prompt engineering and error recovery are iterative and success depends on tuning.

---

## Sources

### Official Documentation (HIGH Confidence)
- [Anthropic SDK TypeScript - GitHub](https://github.com/anthropics/anthropic-sdk-typescript)
- [Claude Agent SDK - Overview](https://platform.claude.com/docs/en/agent-sdk/overview)
- [Anthropic Pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- [Prompt Caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [Tool Use Implementation](https://platform.claude.com/docs/en/agents-and-tools/tool-use/implement-tool-use)
- [Rate Limits](https://platform.claude.com/docs/en/api/rate-limits)
- [Building Effective Agents](https://www.anthropic.com/research/building-effective-agents)
- [Effective Harnesses for Long-Running Agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)

### Real-World Incidents (MEDIUM Confidence)
- [Claude Code Subagent Cost Explosion](https://www.aicosts.ai/blog/claude-code-subagent-cost-explosion-887k-tokens-minute-crisis) — 887K tokens/min incident, $8K-15K session
- [AI Agent Cost Crisis - Budget Disaster Prevention](https://www.aicosts.ai/blog/ai-agent-cost-crisis-budget-disaster-prevention-guide) — 73% of teams lack cost tracking
- [tmux Memory Issues](https://github.com/tmux/tmux/issues/1167) — memory growth patterns
- [tmux Orphan Process Cleanup](https://github.com/steveyegge/gastown/issues/29) — orphaned processes from killed sessions
- [iMessage Rate Limiting](https://github.com/ZekeSnider/Jared/issues/65) — ~200 msg/hour throttling

### Ecosystem Research (MEDIUM Confidence)
- [Azure AI Agent Design Patterns](https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/ai-agent-design-patterns) — hub-spoke vs supervisor patterns
- [Auto-Claude](https://github.com/AndyMik90/Auto-Claude) — multi-agent coding orchestration
- [TUM Autonomous Agent Fundamentals](https://arxiv.org/html/2510.09244v1) — perceive-reason-act architecture
- [Zapier Human-in-the-Loop Patterns](https://zapier.com/blog/human-in-the-loop/) — conditional interruption
- [Why Multi-Agent LLM Systems Fail](https://arxiv.org/pdf/2503.13657) — failure taxonomy
- [AI Agent Guardrails Production Guide 2026](https://authoritypartners.com/insights/ai-agent-guardrails-production-guide-for-2026/) — defense-in-depth
- [Structured Outputs Guide](https://agenta.ai/blog/the-guide-to-structured-outputs-and-function-calling-with-llms) — 15-20% failure rate without tool use

### Codebase Analysis (HIGH Confidence)
- `/Users/claude/projects/project-orchestrator/index.js` — main loop architecture
- `/Users/claude/projects/project-orchestrator/lib/session-manager.js` — tmux lifecycle
- `/Users/claude/projects/project-orchestrator/lib/scanner.js` — STATE.md parsing
- `/Users/claude/projects/project-orchestrator/lib/signal-protocol.js` — signal file handling
- `/Users/claude/projects/project-orchestrator/config.json` — 18 projects, 60s scan, 5 max sessions

---

## Ready for Requirements

This research provides a clear foundation for roadmap creation:

1. **Technical path is validated:** Raw Anthropic SDK + tool use + Haiku-first + prompt caching
2. **Feature scope is defined:** 8 table stakes, 9 differentiators prioritized, 10 anti-features to avoid
3. **Architecture is mapped:** 4 new modules integrate cleanly with existing codebase
4. **Risks are identified:** 4 critical pitfalls with concrete mitigations
5. **Cost model is clear:** Target $6-9/month, ceiling at $60/month, catastrophe scenario is $1,600+/month
6. **Phase structure is recommended:** Safety-first (Phase 1), execution (Phase 2), intelligence (Phase 3)

The roadmapper can proceed with confidence to define detailed phase requirements.
