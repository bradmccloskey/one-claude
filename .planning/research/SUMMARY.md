# Research Summary: v3.0 AI Decision Engine

**Project:** project-orchestrator v3.0
**Research Date:** 2026-02-15
**Updated:** 2026-02-16 — Revised to use `claude -p` (Max plan) instead of Anthropic SDK
**Confidence:** HIGH

---

## Executive Summary

The v3.0 milestone adds an AI decision engine on top of the existing v2.0 orchestrator, transforming it from a human-controlled process manager into an autonomous agent that decides what to work on. The key insight from the revised approach: **the user has a Claude Max plan with unlimited Claude Code usage, so there is no reason to integrate the Anthropic API directly.**

Instead of adding SDK dependencies, API key management, cost tracking, model routing, and prompt caching logic, the AI brain simply shells out to `claude -p` (Claude Code's print mode). This eliminates the entire cost infrastructure layer and cuts the v3.0 scope roughly in half.

The recommended approach is:
- **`claude -p`** for all AI reasoning (zero cost, zero dependencies)
- **Sonnet as default model** (no reason to penny-pinch on Haiku when it's free)
- **5-minute think cycle** separate from the existing 60-second scan
- **JSON-in-prompt** for structured decisions (validated with allowlist)
- **Safety-first rollout**: observe mode first, then cautious autonomy

Critical risks now center on **runaway automation** (AI starting too many sessions), **stale state decisions** (acting on outdated information), and **hallucinated project understanding** (AI misreading what a project needs). Cost explosion — the previous #1 risk — is eliminated by the Max plan.

---

## Key Findings

### From STACK.md: Technology Decisions

**Core Decision: Use `claude -p`, NOT the Anthropic SDK**

The user's Claude Max plan ($200/mo flat) includes unlimited Claude Code usage. Every `claude -p` call is covered. Adding `@anthropic-ai/sdk` would mean paying per-token on top of the Max subscription — paying twice for the same capability.

**Stack Additions: ZERO**
- No `@anthropic-ai/sdk` — use `claude -p` via `child_process`
- No `dotenv` — no API key to manage
- No new npm packages at all

**Model Strategy:**
- **Default: Sonnet 4.5** via `claude -p --model sonnet` — best quality-to-speed ratio, free with Max
- **Complex: Opus 4.6** via `claude -p` (default model) — for weekly planning, complex evaluations
- **Simple: Haiku 4.5** via `claude -p --model haiku` — for trivial formatting tasks

With Max plan, there's no cost incentive to use Haiku. Default to Sonnet for better reasoning.

**Cost: $0 incremental**
- No API billing
- No budget caps needed
- No cost tracking needed
- No prompt caching logic needed

### From FEATURES.md: Feature Categories

**7 Table Stakes (non-negotiable):**
1. Claude CLI Integration — `claude -p` as the AI interface (replaces "API Integration")
2. Project State Comprehension — semantic understanding of STATE.md + signals
3. Priority Scoring Engine — weighted algorithm across 5-6 dimensions
4. Autonomous Session Launch — proactive "what to work on next" execution
5. Session Completion Evaluation — LLM-as-judge for session output quality
6. Intelligent SMS Summaries — synthesized updates, not raw data dumps
7. Decision Logging — every AI decision with context for debugging and trust

**Removed from Table Stakes:** Cost Tracking and Budget Controls (T7 from original). Not needed with Max plan.

**9 Differentiators (high-value enhancements):** Unchanged from original research.

**10 Anti-Features (deliberately avoided):** Unchanged. Additionally reinforced:
- Multi-model routing logic — even simpler now, just pass `--model` flag
- Cost dashboards — nothing to track

### From ARCHITECTURE.md: Component Design

**New Modules (3 total, down from 4):**

1. **AI Brain** (`lib/ai-brain.js`) — orchestrates think cycle, calls `claude -p`, logs decisions
2. **Context Assembler** (`lib/context-assembler.js`) — gathers project states into compact prompt
3. **Decision Executor** (`lib/decision-executor.js`) — parses structured AI output, executes actions

**Removed:** Cost Tracker (`lib/cost-tracker.js`) — not needed with Max plan.

**Modified Modules:**
- `index.js` — add 5-minute `aiThinkCycle()` interval
- `commands.js` — add AI control commands (on/off/status/level)
- `state.js` — extend with `aiDecisionHistory` tracking
- `config.json` — add `ai` section (model, interval, enabled)

**Think Cycle Timing:**
- 5-minute interval (default) — allows sessions to produce meaningful output
- Separate from existing 60s scan (which still handles urgent alerts)
- `claude -p` takes ~2-5 seconds per call — well within the 5-minute window
- Each call is a fresh conversation (no growing message history)

### From PITFALLS.md: Revised Risk Assessment

**Eliminated Risks (Max plan removes these):**
- ~~API Cost Explosion~~ — unlimited usage, $0 incremental cost
- ~~Rate Limits / 429 Errors~~ — no API rate limits with Claude Code CLI
- ~~Token Context Bloat cost impact~~ — still affects quality/latency but not billing

**Remaining Critical Risks (3):**

1. **Runaway Automation** (CRITICAL) — AI starts/stops sessions inappropriately, crashes Mac Mini
   - Mitigation: Action allowlist, cooldown timers, resource checks (2GB free RAM), protected sessions

2. **Stale State Decisions** (HIGH) — AI acts on outdated information, duplicate sessions
   - Mitigation: Atomic state snapshots, optimistic locking, 30s decision expiry, debounce changes

3. **Hallucinated Understanding** (HIGH) — AI misreads project needs, wastes sessions
   - Mitigation: Explicit blocker enforcement, user priority overrides file, confidence scoring

**Remaining Moderate Risks (3):**
- Structured output parsing failures — use robust JSON extraction + validation
- Notification spam — tier system, daily SMS budget
- Main loop blocking — async `claude -p` calls, timeout enforcement

---

## Implications for Roadmap

### Simplified Phase Structure (2 phases instead of 3)

With cost infrastructure removed, the build is simpler and can be condensed.

#### Phase 1: Foundation and Safety (OBSERVE MODE)

**Goal:** Get AI integration working in observe-only mode with guardrails.

**What to Build:**
- `claude -p` integration via `child_process`
- Context Assembler (compact state representation)
- AI Brain in `autonomyLevel: "observe"` mode (thinks but doesn't act)
- Decision Logging (every decision with full context)
- Guardrails: action allowlist, cooldown timers, resource checks
- SMS commands: `ai on/off`, `ai status`, `ai level`
- Priority overrides file (`priorities.json`)

**What to Deliver:**
AI that makes recommendations via SMS ("I think we should work on X next. Go?") but does NOT execute autonomously. User can inspect decision quality before enabling execution.

**Success Criteria:**
- AI recommends sensible priorities when prompted
- Decision log captures all reasoning
- `claude -p` calls complete within 30 seconds
- SMS notifications are clear and actionable
- No new npm dependencies added

#### Phase 2: Autonomous Execution and Intelligence

**Goal:** Allow AI to act autonomously with full intelligence features.

**What to Build:**
- Decision Executor with action allowlist
- Atomic state snapshots and optimistic locking
- Upgrade to `autonomyLevel: "cautious"` then `"moderate"`
- Session Prompt Engineering (context-rich prompts per project)
- Smart Error Recovery
- Proactive Staleness Detection
- Intelligent Morning Digest (AI-written, not template)
- Time Boxing (45-min max per session)
- Notification tier system

**What to Deliver:**
AI that autonomously starts sessions, evaluates progress, recovers from errors, and only interrupts the human for genuine decisions.

**Success Criteria:**
- AI successfully launches sessions for genuinely high-priority work
- No duplicate sessions (stale state prevented)
- No memory exhaustion (resource checks work)
- User can override AI decisions via priority file
- Morning digest is AI-generated and valuable
- Sessions time-boxed to prevent runaway resource usage

### Deferred to Future (Post-MVP)

- Cross-Project Conflict Detection — valuable but complex
- Natural Language SMS Commands — existing router handles 95% of cases
- Revenue-Aware Scheduling — requires metadata schema evolution
- Adaptive Priority Learning — needs weeks of decision log data

---

## Confidence Assessment

| Research Area | Confidence | Notes |
|---------------|-----------|-------|
| **Stack** | **HIGH** | `claude -p` is proven, already used across all projects. Zero risk on technology choice. |
| **Features** | **HIGH** | Feature scope simplified. Same core features, fewer infrastructure requirements. |
| **Architecture** | **HIGH** | 3 modules instead of 4. Clean integration with existing codebase. Simpler than API approach. |
| **Pitfalls** | **HIGH** | Biggest risk (cost explosion) eliminated. Remaining risks are well-understood with clear mitigations. |

### Known Gaps

1. **`claude -p` latency:** Need to measure actual response times for typical prompts. Estimated 2-5 seconds but not benchmarked.

2. **`claude -p` concurrency:** Need to verify behavior when multiple `claude -p` processes run simultaneously (orchestrator + active sessions).

3. **Structured output reliability:** JSON-in-prompt may have parsing failures. Need to measure failure rate and decide if two-step approach is needed.

4. **Session Evaluation Rubric:** What makes a "successful" vs "failed" session? Needs user input on criteria.

5. **Priority Weights:** The scoring algorithm weights are recommendations. User should validate.

---

## Sources

### Official Documentation (HIGH Confidence)
- Claude Code CLI — `-p` print mode, `--model` flag
- [Claude Max Plan](https://claude.ai/pricing) — $200/mo unlimited usage
- [Building Effective Agents](https://www.anthropic.com/research/building-effective-agents)
- [Effective Harnesses for Long-Running Agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)

### Codebase Analysis (HIGH Confidence)
- `/Users/claude/projects/project-orchestrator/index.js` — main loop architecture
- `/Users/claude/projects/project-orchestrator/lib/session-manager.js` — tmux lifecycle
- `/Users/claude/projects/project-orchestrator/lib/scanner.js` — STATE.md parsing
- `/Users/claude/projects/project-orchestrator/lib/signal-protocol.js` — signal file handling
- `/Users/claude/projects/project-orchestrator/config.json` — 18 projects, 60s scan, 5 max sessions

### Real-World Incidents (MEDIUM Confidence)
- [tmux Memory Issues](https://github.com/tmux/tmux/issues/1167) — memory growth patterns
- [tmux Orphan Process Cleanup](https://github.com/steveyegge/gastown/issues/29) — orphaned processes
- [iMessage Rate Limiting](https://github.com/ZekeSnider/Jared/issues/65) — ~200 msg/hour throttling

---

## Ready for Planning

This research provides a clear foundation for implementation:

1. **Technical path is validated:** `claude -p` via `child_process` — zero dependencies, zero cost
2. **Feature scope is defined:** 7 table stakes, 9 differentiators, 10 anti-features
3. **Architecture is mapped:** 3 new modules integrate cleanly with existing codebase
4. **Risks are identified:** 3 critical + 3 moderate pitfalls with concrete mitigations
5. **Phase structure is simplified:** 2 phases instead of 3 (cost layer removed)
6. **Build order is clear:** Observe first, execute second

The planner can proceed with confidence to define detailed phase requirements.
