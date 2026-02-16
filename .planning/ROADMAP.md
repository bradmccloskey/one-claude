# Roadmap — v3.0 AI-Powered Orchestrator

## Phase 01: AI Brain Foundation (Observe Mode)

**Goal:** Get AI decision-making working in observe-only mode with guardrails. The AI thinks about what to do but only sends recommendations via SMS — it does NOT execute actions autonomously.

**Delivers:**
- `lib/context-assembler.js` — gathers all project/session state into compact prompt
- `lib/ai-brain.js` — think cycle that shells out to `claude -p`, parses JSON decisions, logs everything
- `lib/decision-executor.js` — maps decisions to existing actions (used in Phase 2, scaffolded here with guardrails)
- New SMS commands: `ai on/off`, `ai status`, `ai level`, `ai think`, `ai explain`
- Decision logging to `.state.json` (aiDecisionHistory)
- `priorities.json` for user overrides (block/skip/focus projects)
- Guardrails: action allowlist, cooldown timers, resource checks
- Config: `ai` section in `config.json`

**Plans:** 3 plans

Plans:
- [x] 01-01-PLAN.md — Context assembly + config + priorities foundation
- [x] 01-02-PLAN.md — AI brain think cycle + decision executor scaffold
- [x] 01-03-PLAN.md — SMS commands + main loop integration

**Status: COMPLETE** — Verified 17/17 must-haves (2026-02-16)

**Success criteria:**
- AI recommends sensible priorities when `ai think` is triggered
- Decision log captures all reasoning with timestamps
- `claude -p` calls complete within 30 seconds
- SMS notifications are clear and actionable
- Zero new npm dependencies
- Existing v2.0 functionality unaffected

## Phase 02: Autonomous Execution and Intelligence

**Goal:** Enable AI to act autonomously — start/stop sessions, evaluate progress, recover from errors, generate intelligent digests — with full safety guardrails.

**Delivers:**
- Decision executor wired to session-manager/messenger
- Autonomy levels: observe → cautious → moderate → full
- Atomic state snapshots + optimistic locking (stale state prevention)
- Session prompt engineering (context-rich per-project prompts)
- Smart error recovery (evaluate + retry, not just report)
- Proactive staleness detection
- Intelligent morning digest (AI-generated, replaces template)
- Time boxing (45-min session cap)
- Notification tier system (urgent/summary/debug)

**Plans:** 4 plans

Plans:
- [x] 02-01-PLAN.md — Notification manager + config additions + state extensions
- [x] 02-02-PLAN.md — Decision executor wiring + autonomy gating + AI level command
- [x] 02-03-PLAN.md — Context enrichments (staleness, errors, prompts) + time boxing
- [x] 02-04-PLAN.md — AI morning digest + main loop execution dispatch

**Status: COMPLETE** — Verified 21/21 must-haves (2026-02-16)

**Success criteria:**
- AI autonomously launches sessions for high-priority work
- No duplicate sessions or memory exhaustion
- User can override via `priorities.json` or SMS
- Morning digest is AI-written and valuable
- Sessions time-boxed to prevent runaway usage
