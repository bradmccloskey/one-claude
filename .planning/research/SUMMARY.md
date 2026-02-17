# Research Summary: ONE Claude v4.0 — Autonomous Agent with External Integrations

**Project:** project-orchestrator v4.0
**Research Date:** 2026-02-16
**Confidence:** HIGH (all 4 dimensions verified against codebase, official docs, and live CLI testing)

---

## Executive Summary

v4.0 is a depth milestone, not a breadth milestone. v3.0 is a working autonomous orchestrator that manages ~19 projects across a Mac Mini, communicates via iMessage, and runs 5 concurrent Claude Code sessions. What it cannot do: know whether those sessions accomplished anything (no evaluation), know when services go down (no health monitoring), understand which projects generate revenue (no revenue intelligence), or earn its way to higher autonomy levels through demonstrated competence (no trust-building mechanism). v4.0 closes all four gaps.

The research converges on a clear implementation philosophy: extend the existing hub-and-spoke architecture with new data-gathering modules (session evaluator, health monitor, revenue tracker) that feed enriched context into the existing AI brain, and new action types in the existing decision executor. Zero architectural rewrites. Zero new npm dependencies — Node.js v25.6.1 provides native `fetch`, `fs.watch`, `node:test`, and `EventEmitter`; `claude -p` v2.1.39 provides `--json-schema`, `--allowedTools`, and `--model` routing without any SDK. The 2-dependency footprint (`better-sqlite3`, `node-cron`) is preserved.

The most important cross-cutting finding: **MCP tools ARE available inside `claude -p` print mode** (fixed in Claude Code v0.2.54, current version is 2.1.39). The orchestrator already has 11 MCP servers configured globally (GitHub, Docker, Calendar, Apple Reminders, Memory, etc.). Every `claude -p` call inherits these servers. The entire external integration layer — GitHub PR checking, calendar awareness, Docker management — comes for free via `--allowedTools`, with no new code beyond crafting prompts and setting `--max-turns 3-5`.

The critical path runs through the feedback loop: **Git Progress Tracking (T2) → Session Evaluation (T1) → Graduated Autonomy (T5)**. Without knowing if sessions accomplish anything, no other v4.0 feature produces reliable results. Revenue intelligence ranks second because "prioritize revenue projects" is meaningless without revenue data.

---

## Key Findings

### From STACK.md: Zero New Dependencies

**Headline:** v4.0 adds substantial capability with `package.json` identical to v3.0.

- `--json-schema` flag on `claude -p` provides **guaranteed structured output** via constrained decoding. Replaces the fragile 3-strategy `parseJSON()` function in `ai-brain.js`. Output is physically prevented from violating the schema — not "asking nicely for JSON."
- `--allowedTools "mcp__github__list_pull_requests"` bridges Node.js to the 11 already-configured MCP servers. No `@modelcontextprotocol/sdk`, no transport management.
- `--model haiku/sonnet/opus` enables model routing without any routing library. Use Haiku for SMS composition, Sonnet for default reasoning, Opus when >3 projects need attention simultaneously.
- Native `fetch` (Node v25.6.1, undici-powered) handles all HTTP health checks. No `axios`, no `node-fetch`.
- `fs.watch` with `{recursive: false}` on `.orchestrator/` signal directories handles event-driven session signals. Debounce at 1 second. Keep polling for everything else (macOS `fs.watch` has known reliability issues at scale — see PITFALLS).
- `better-sqlite3` (already installed) extends to conversation persistence and revenue snapshots. `node:sqlite` is still experimental; skip it.
- `tmux capture-pane -p -S -100` works on detached sessions — verified. Git diff + tmux output is the raw material for session evaluation.

**Verdict:** Net new npm packages: ZERO. This is a constraint to preserve.

### From FEATURES.md: Feature Dependency Map

**Table Stakes (non-negotiable for v4.0 to have substance):**

| ID | Feature | Rationale |
|----|---------|-----------|
| T2 | Git Progress Tracking | Ground truth. The only objective measure of "did something happen." |
| T1 | Session Output Evaluation | Closes the feedback loop. LLM-as-judge with git diff + tmux output. |
| T3 | Service Health Monitoring | The Mac Mini IS the infrastructure. Down = orchestrator failed its job. |
| T4 | Revenue Intelligence | "Prioritize revenue" is meaningless without numbers. Start with XMR + MLX. |
| T5 | Graduated Autonomy + Trust Building | Path from permanent observe-mode to earned autonomous operation. |

**High-value differentiators (build order: D1, D3, D5, D7 first; D2, D4, D8, D9 second; D6 last):**

- D1 (Personal Assistant via SMS) — natural language routing already exists; extend with reminders, calendar, notes
- D3 (Session Continuation Intelligence) — "last session scored 3/5, completed X, remaining Y" replaces generic resume prompts
- D5 (Proactive Service Recovery) — launchctl/docker restart gated by autonomy level
- D7 (System Resource Dashboard) — low complexity, improves every AI decision
- D6 (Cross-Session Learning) — needs 50+ evaluations; build last, after data accumulates

**Anti-features (deliberately skip):** Web dashboard for health (SMS works), official revenue APIs before scraping is proven stable, MCP server AS the orchestrator, per-project autonomy levels, automated financial projections.

**Critical dependency chain:**
```
T2 (Git Tracking) -> T1 (Evaluation) -> T5 (Graduated Autonomy) -> D6 (Learning)
T3 (Health Monitor) -> T4 (Revenue) -> D4 (Weekly Report)
v3.0 NL SMS -> D1 (Personal Assistant) -> D8 (Conversation Memory)
```

### From ARCHITECTURE.md: Additive Extension, Not Restructure

**The rule:** Do NOT restructure the existing hub-and-spoke model. Add new modules, extend existing ones.

**New modules (4):**

| Module | File | Purpose | Phase |
|--------|------|---------|-------|
| Session Evaluator | `lib/session-evaluator.js` | tmux capture + git diff, quick assessment | Early |
| Health Monitor | `lib/health-monitor.js` | HTTP pings, Docker status, alerting | Early |
| Revenue Tracker | `lib/revenue-tracker.js` | Revenue-data.json + income-dashboard DB | Mid |
| Event Bus | `lib/event-bus.js` | Internal EventEmitter for module decoupling | Early |

**Modified modules (6):** `context-assembler.js` (add eval/health/revenue sections), `decision-executor.js` (add evaluate_session, check_health, query_mcp actions), `ai-brain.js` (model routing + MCP bridge), `state.js` (health history + conversation persistence), `config.json`, `index.js` (health check interval).

**Unchanged modules (6):** messenger, scanner, signal-protocol, process-monitor, scheduler, digest.

**Architecture decision: Hybrid MCP approach**
- HIGH-frequency, SIMPLE ops → direct Node.js (health pings, Docker status, revenue file reads)
- LOW-frequency, COMPLEX ops → `claude -p` with `--allowedTools` (GitHub PR analysis, calendar queries, Reminders creation)
- Never spawn parallel `claude -p` processes — use a global semaphore (max 2 concurrent)

**Key constraint: Anti-pattern 4 is law.** Never run multiple `claude -p` calls concurrently. Each consumes 200-500 MB RAM on a 16 GB Mac Mini already running Claude Code sessions. Queue all AI calls through a serialized pipeline.

**Build order (dependency-aware):**
1. Event Bus, Session Evaluator, Health Monitor, Conversation Persistence (no cross-dependencies)
2. Context Assembler Extensions, Revenue Tracker (depend on Tier 1)
3. Multi-Model Routing, MCP Bridge, Decision Executor Extensions (depend on Tier 2)
4. Graduated Autonomy rollout (depends on Tier 3 being stable)

### From PITFALLS.md: Top Risks with Mitigations

**Critical (system-threatening, must address before the feature ships):**

1. **MCP Cascade Failure** — One hung MCP server stalls the entire think cycle. `execSync` blocks on MCP timeouts (documented as unreliable in Claude Code issues #3033, #20335). Mitigation: circuit breaker per MCP server (3 consecutive failures = 5-minute disable + exponential backoff), pre-think health check, only use MCP bridge for low-frequency complex tasks.

2. **Graduated Autonomy Without Rollback** — AI takes a destructive action at moderate level, no undo exists. Mitigation: staged promotion (cannot skip levels), automatic demotion on failure, action undo registry (every action records its inverse), pre-action "hot check" (is the target actively processing?), 15-minute rate limit between destructive actions on same project.

3. **Session Evaluation False Confidence** — LLM judges favor AI-generated output; sessions scoring "good" while broken. Mitigation: objective signals are primary (tests pass, commits made, signal file present), LLM judgment is supplementary only. Bias rubric toward "inconclusive" rather than "success." Track calibration accuracy against user feedback.

**High (significant degradation, address before or alongside the feature):**

4. **External Services Breaking the Main Loop** — GitHub rate limits (30 req/min search, 5K/hr REST), Docker socket hangs, new dependencies. Mitigation: ServiceDataCache pattern — refresh on its own interval, main loop reads from cache only. Use `gh` CLI and `docker` CLI via `execFile` with 10-second timeouts. Zero new npm dependencies.

5. **Health Monitor Alert Storms** — Cloudflare tunnel reconnect causes all services to fail simultaneously, orchestrator attempts cascading restarts. Mitigation: correlated failure detection (3+ simultaneous = infrastructure issue, not service issue), 3 consecutive failures before alert, localhost-first health checks, 2 service restarts per hour max.

6. **Revenue Data Producing Wrong Priorities** — Stale or missing data treated as zero revenue, deprioritizing earning projects. Mitigation: NULL vs zero distinction in data model, always show data age in AI context, manual override via `priorities.json`, do not connect revenue to priority scoring until 2+ weeks of stable data.

7. **`--dangerously-skip-permissions` in NL Handler** — Pre-existing risk that v4.0 amplifies. Current NL handler (commands.js:643) has no `--max-turns` and `--dangerously-skip-permissions`. Mitigation: add `--max-turns 1`, remove skip-permissions from NL handler, split into read-only path and write path through DecisionExecutor.

**Moderate (address in the relevant phase):**

8. Notification overload from multiple new sources — content-type budget allocation (health: 3/day, revenue: 2/day, reminders: 2/day, critical: unlimited)
9. `fs.watch` event storms on macOS — stick with polling; use content hashing for optimization if needed
10. Conversation persistence state size and credential leakage — separate `.conversation-history.json`, TTL 24h, sensitive data filtering, cap at 20 messages
11. Test suite reveals tight coupling — use existing dependency injection, `lib/exec.js` wrapper for `execSync` mocking, temp directories for state
12. Process accumulation from expanded `claude -p` call sites — global `ClaudeSemaphore` class (max 2 concurrent, SMS preempts background tasks)

---

## Implications for Roadmap

### Recommended Phase Structure (4 Phases)

The ordering follows two principles: (1) close feedback loops before adding intelligence that depends on them, and (2) build ground truth before building analysis on top of it.

---

#### Phase 1: Foundation Hardening

**Goal:** Fix pre-existing risks that v4.0 amplifies, and lay the infrastructure all v4.0 features depend on.

**What to build:**
- `lib/exec.js` wrapper for `execSync`/`execFile` (enables testing + future mocking)
- `lib/event-bus.js` (internal EventEmitter, wired into index.js)
- Global `ClaudeSemaphore` (max 2 concurrent `claude -p` processes)
- Conversation persistence: `.conversation-history.json` with TTL, size cap, credential filtering
- Fix NL handler: add `--max-turns 1`, remove `--dangerously-skip-permissions`
- State file splitting: `.state.json`, `.state-health.json`, `.state-revenue.json`, `.conversation-history.json`
- Test infrastructure: `lib/exec.js` mock pattern, temp dir helpers, first integration tests
- `--json-schema` on all `claude -p` calls (replaces fragile `parseJSON()`)

**Pitfalls to address:** #7 (NL handler), #12 (process accumulation), #11 (test infrastructure), #10 (conversation persistence)

**Research flag:** SKIP — patterns are well-documented and verified. No phase research needed.

---

#### Phase 2: Feedback Loop (Session Evaluation)

**Goal:** Close the feedback loop. The orchestrator must know whether sessions accomplish anything before making smarter decisions about them.

**What to build:**
- T2: Git Progress Tracking — per-project commit counts, diff stats, fed into context assembler
- D7: System Resource Context — expand existing `os.freemem()` check to full CPU/disk/GPU context
- T1: Session Output Evaluation — `lib/session-evaluator.js` with tmux capture + git diff + objective signals (tests pass, commits made) + LLM-as-judge (supplementary)
- D3: Session Continuation Intelligence — evaluation result drives the `nextPrompt` field
- Evaluation scoring → state.json for T5 data accumulation

**Pitfalls to address:** #3 (false confidence — objective signals first), #9 (don't add fs.watch)

**Research flag:** NO additional research needed. Patterns verified in STACK.md (tmux capture-pane) and FEATURES.md (LLM-as-judge rubric).

---

#### Phase 3: Infrastructure Awareness (Health + Service Recovery)

**Goal:** The Mac Mini IS the infrastructure. The orchestrator must know when services go down and have the authority to respond.

**What to build:**
- T3: `lib/health-monitor.js` — HTTP pings (native fetch), Docker status (`docker ps`), TCP checks (net module)
- ServiceDataCache — health checks run on own interval, main loop reads from cache
- Correlated failure detection — 3+ simultaneous failures = infrastructure event, no restarts
- Alert routing — tier 1 URGENT for service down, tier 3 for recovery
- D5: Proactive Service Recovery — `launchctl kickstart` and `docker restart` gated by autonomy level; restart budget (2/hour)
- MCP bridge foundation — `lib/mcp-bridge.js` or method in `ai-brain.js` for `claude -p --allowedTools`
- MCP circuit breaker — per-server failure tracking, 5-minute backoff on 3 consecutive failures

**Pitfalls to address:** #1 (MCP cascade), #4 (main loop failure modes), #5 (alert storms)

**Research flag:** MCP tool naming convention needs verification at implementation time (`claude -p --allowedTools "mcp__github__*"`). Quick check, not a full research phase.

---

#### Phase 4: Intelligence (Revenue + Graduated Autonomy + Personal Assistant)

**Goal:** Revenue awareness, trust-building mechanism, and personal assistant upgrade.

**What to build (in order):**
- T4: `lib/revenue-tracker.js` — start with XMR mining pool API and MLX access log parsing. Add RapidAPI GraphQL only after XMR/MLX are proven stable. Revenue context in AI prompt (with data age). NULL vs zero distinction.
- T5: Graduated Autonomy — trust metrics tracking (sessions launched, avg eval score, false alerts), promotion criteria (30+ sessions at cautious with avg 3.5+ → recommend moderate), auto-demotion on 3 consecutive low scores, action undo registry
- D4: Weekly Revenue Report — Sunday 7 AM cron, reuse digest infrastructure
- D9: Evening Wind-Down Digest — 9:45 PM, reuse digest infrastructure, requires T1/T2 stable
- D1: Personal Assistant — reminders via node-cron + state persistence, calendar via JXA/osascript, quick lookups via `claude -p` with tool access
- D8: Conversation Memory — persistent history used for reminder follow-up and continuity
- D2: MCP per-project configuration — ensure `.mcp.json` exists in session-managed projects for GitHub and filesystem tools

**Pitfalls to address:** #2 (autonomy escalation without rollback), #6 (revenue wrong numbers), #8 (notification overload — implement category budgets before this phase), #13 (macOS Calendar/Reminders permissions)

**Research flag:** Revenue API specifics (RapidAPI GraphQL exact schema, XMR mining pool API format) need verification at implementation time. Recommend `/gsd:research-phase` before T4 sub-task.

---

### Phase Ordering Rationale

| Phase | Delivers | Why This Position |
|-------|---------|-------------------|
| 1: Foundation | Safety + testability | Pre-existing risks become critical with v4.0 scope. Fix before expanding. |
| 2: Feedback Loop | Evaluation + git tracking | Everything else builds on "did that session work?" |
| 3: Infrastructure | Health monitoring + recovery | Second-most-critical feedback loop after session evaluation. |
| 4: Intelligence | Revenue + autonomy + PA | Requires evaluation data to accumulate (T5), revenue stability to verify (T4). |

---

## Confidence Assessment

| Area | Confidence | Basis |
|------|------------|-------|
| Stack | HIGH | Verified: `--json-schema`, `--allowedTools`, `--model` flags tested on this machine. Node v25.6.1 native `fetch` and `fs.watch` verified. Zero new dependencies confirmed feasible. |
| Features | HIGH | Clear dependency graph. Table stakes justified by v3.0 gaps. Anti-features have strong rationale. Phase ordering is opinionated and defensible. |
| Architecture | HIGH | Full codebase analysis of all 13 modules. Integration points identified precisely (file/line references). Build order dependency-aware. |
| Pitfalls | HIGH | Verified against live GitHub issues (MCP timeout #3033, #20335, fs.watch #49916, #52601). LLM-as-judge bias documented by multiple sources. Codebase analysis confirms which lines need changing. |

### Gaps to Address During Implementation

1. **RapidAPI GraphQL schema** — exact query syntax for provider analytics needs live API verification. Confidence: MEDIUM. Do not build T4 RapidAPI integration without testing against live endpoint first.

2. **XMR mining pool API** — depends on which pool is configured. Need to check `config.json` for pool URL at implementation time.

3. **MCP tool naming** — `mcp__github__list_pull_requests` format needs verification against `claude mcp list` output for exact tool names. Run discovery query before using `--allowedTools`.

4. **Notification budget recalibration** — the v3.0 budget of 20 SMS/day was not sized for v4.0's new notification sources (health, revenue, reminders). Phase 4 must re-budget before adding new sources.

5. **Session evaluation rubric thresholds** — what score constitutes "productive" vs "stalled" needs calibration. Start with conservative defaults; adjust after 2 weeks of real data.

---

## Areas of Agreement Across Research Dimensions

All four research files converge on these positions:

- **Zero new npm dependencies** — verified feasible, worth preserving as constraint
- **Polling over fs.watch** — STACK.md, ARCHITECTURE.md, and PITFALLS.md all recommend staying with polling for most use cases; fs.watch only for active session signal dirs
- **Hybrid MCP approach** — direct Node.js for simple/frequent, `claude -p --allowedTools` for complex/infrequent
- **Evaluation before autonomy** — you cannot earn trust without a mechanism to measure success
- **State file splitting** — `.state.json` cannot hold all v4.0 persistent data without becoming a bottleneck
- **Revenue tracking starts conservative** — do not use as priority input until 2+ weeks of stable data

## Areas of Tension (Resolved)

- **fs.watch vs. polling for signal files:** STACK.md cautiously recommends fs.watch for signal dirs. ARCHITECTURE.md recommends against for general use. PITFALLS.md documents macOS-specific bugs. Resolution: Use polling as default. Optionally add fs.watch ONLY on `.orchestrator/` dirs of ACTIVE sessions (low volume, targeted scope).
- **Revenue API approach:** FEATURES.md suggests official APIs (RapidAPI GraphQL). ARCHITECTURE.md suggests starting with static `revenue-data.json`. PITFALLS.md says prove scraping before APIs. Resolution: Start with XMR local API (trivial) and MLX log parsing (local file). Add RapidAPI GraphQL only after infrastructure is stable.

---

## Sources

### HIGH Confidence (Verified on This Machine)
- `claude -p --help` output — verified `--json-schema`, `--allowedTools`, `--model`, `--max-turns`, `--output-format` flags (Claude Code v2.1.39)
- `claude mcp list` output — verified 11 MCP servers configured
- `node --version` — v25.6.1 with native `fetch`, `fs.watch` recursive macOS support
- Full codebase analysis — all 13 lib modules read and understood with file:line references
- [Claude Code CLI Reference](https://code.claude.com/docs/en/cli-reference)
- [GitHub Issue #610](https://github.com/anthropics/claude-code/issues/610) — MCP in print mode FIXED in v0.2.54

### HIGH Confidence (Official Documentation)
- [Anthropic Structured Outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) — constrained decoding for `--json-schema`
- [Claude Code MCP Docs](https://code.claude.com/docs/en/mcp) — tool naming, scopes, `--allowedTools`
- [GitHub REST API Rate Limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
- [Node.js #49916](https://github.com/nodejs/node/issues/49916), [#52601](https://github.com/nodejs/node/issues/52601) — fs.watch macOS bugs
- [Claude Code #3033](https://github.com/anthropics/claude-code/issues/3033), [#20335](https://github.com/anthropics/claude-code/issues/20335) — MCP timeout unreliability

### MEDIUM Confidence (Multiple Sources Agree)
- LLM-as-Judge bias taxonomy (Langfuse, EvidentlyAI, Softtech)
- Knight Columbia Autonomy Levels framework (5-level, maps to existing 4-level system)
- Alert fatigue patterns (Datadog, IBM)
- RapidAPI GraphQL Platform API for provider analytics

### LOW Confidence (Verify at Implementation Time)
- RapidAPI exact GraphQL query schema
- XMR mining pool API format (pool-specific)
- MCP tool exact names (discover via `claude mcp list` details)
