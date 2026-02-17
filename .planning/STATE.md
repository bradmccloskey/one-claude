# State

## Current Position

Phase: Not started (defining requirements)
Plan: —
Status: Defining requirements
Last activity: 2026-02-16 — Milestone v4.0 started

## Accumulated Context

### Decisions
- v2.0 is solid as a process manager, keep existing architecture
- v3.0 adds AI layer on top, doesn't replace the process management
- User wants fully autonomous operation with minimal interruption
- **Use `claude -p` (Max plan) instead of Anthropic SDK** — zero cost, zero dependencies
- Default to Sonnet model (free with Max, better quality than Haiku)
- 13 modules total: 10 from v2.0 + 3 new (ai-brain, context-assembler, decision-executor) + notification-manager
- Safety-first: observe mode before autonomous execution
- v4.0 focus: session evaluation, external integrations, revenue awareness, graduated autonomy
- MCP servers (GitHub, Docker, Calendar, Reminders, Memory) for external integrations
- Event-driven architecture (fs.watch) to replace polling where possible
- Multi-model strategy: Haiku for routine, Sonnet for decisions, Opus for complex analysis

### Known Issues (from v3.0 review)
- Repetitive AI recommendations (dedup not working in observe mode)
- Conversation history lost on restart (in-memory only)
- priorities.json is empty (no user-defined priorities)
- ProcessMonitor._matchProject() bug with subdirectories
- No test suite
- _handleNaturalLanguage uses --dangerously-skip-permissions with no --max-turns
- Only observe mode has been tested in production

### Blockers
- None

## Session Continuity

Last session: 2026-02-16
Stopped at: Defining v4.0 milestone requirements
Resume file: None
