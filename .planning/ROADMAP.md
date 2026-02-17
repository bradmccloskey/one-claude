# Roadmap: Project Orchestrator

## Milestones

- v2.0 Process Manager - Phases 01-05 (shipped 2026-02, pre-GSD)
- v3.0 AI-Powered Orchestrator - Phases 01-02 (shipped 2026-02-16)
- v4.0 Autonomous Agent with External Integrations - Phases 03-07 (in progress)

## Phases

<details>
<summary>v3.0 AI-Powered Orchestrator (Phases 01-02) - SHIPPED 2026-02-16</summary>

### Phase 01: AI Brain Foundation (Observe Mode)
**Goal**: AI decision-making working in observe-only mode with guardrails
**Plans**: 3 plans

Plans:
- [x] 01-01: Context assembly + config + priorities foundation
- [x] 01-02: AI brain think cycle + decision executor scaffold
- [x] 01-03: SMS commands + main loop integration

**Status: COMPLETE** (2026-02-16)

### Phase 02: Autonomous Execution and Intelligence
**Goal**: AI acts autonomously with full safety guardrails
**Plans**: 4 plans

Plans:
- [x] 02-01: Notification manager + config additions + state extensions
- [x] 02-02: Decision executor wiring + autonomy gating + AI level command
- [x] 02-03: Context enrichments (staleness, errors, prompts) + time boxing
- [x] 02-04: AI morning digest + main loop execution dispatch

**Status: COMPLETE** (2026-02-16)

</details>

### v4.0 Autonomous Agent with External Integrations (In Progress)

**Milestone Goal:** Transform ONE Claude from an observe-mode project monitor into a truly autonomous agent with session evaluation, external integrations, revenue awareness, service health monitoring, and personal assistant capabilities.

- [x] **Phase 03: Foundation Hardening** - Fix pre-existing risks and lay infrastructure all v4.0 features depend on
- [ ] **Phase 04: Session Intelligence** - Close the feedback loop so the orchestrator knows whether sessions accomplish anything
- [ ] **Phase 05: Infrastructure Monitoring** - Know when Mac Mini services go down and have authority to respond
- [ ] **Phase 06: Revenue & Autonomy** - Revenue awareness, trust-building mechanism, and graduated autonomy promotion
- [ ] **Phase 07: Personal Assistant** - Reminders, persistent conversation memory, MCP-powered sessions, and cross-session learning

## Phase Details

### Phase 03: Foundation Hardening
**Goal**: The orchestrator is safe, testable, and has reliable structured communication with claude -p -- prerequisites for every v4.0 feature
**Depends on**: Phase 02 (v3.0 complete)
**Requirements**: FOUND-01, FOUND-02, FOUND-03, FOUND-04, FOUND-05, FOUND-06
**Success Criteria** (what must be TRUE):
  1. Sending a natural language SMS never triggers `--dangerously-skip-permissions` and the AI response completes in a single turn
  2. Running two concurrent `claude -p` calls succeeds; a third call queues and waits instead of spawning
  3. All AI brain responses are valid JSON matching their schema -- no more parsing fallbacks or malformed output recovery
  4. Restarting the daemon preserves conversation history, and messages older than 24h are automatically pruned
  5. Running `node --test` executes integration tests that verify core orchestrator behavior (think cycle, SMS routing, session lifecycle)
  6. The AI does not send the same recommendation SMS twice in observe mode (content-based dedup, not just timer-based)
**Plans**: 4 plans

Plans:
- [x] 03-01-PLAN.md -- Centralized exec wrapper with semaphore + NL handler safety fix
- [x] 03-02-PLAN.md -- Conversation persistence + recommendation dedup
- [x] 03-03-PLAN.md -- Structured JSON output via --json-schema + semaphore wiring
- [x] 03-04-PLAN.md -- Test infrastructure + integration tests

**Status: COMPLETE** (2026-02-17)

### Phase 04: Session Intelligence
**Goal**: The orchestrator knows what each session accomplished, how the system is performing, and uses that knowledge to write better session prompts
**Depends on**: Phase 03 (structured output, semaphore, test infra)
**Requirements**: SESS-01, SESS-02, SESS-03, SESS-04
**Success Criteria** (what must be TRUE):
  1. After a session runs, the orchestrator can report how many commits it made, what files changed, and the diff size -- visible in AI context
  2. Each completed session receives a quality score (1-5) with a recommendation (continue/retry/escalate/complete) based on objective signals and LLM judgment
  3. When a session resumes a project, its prompt includes the previous session's score and specific accomplishments/failures
  4. The AI context includes current CPU load, free memory, and disk usage, and the AI references resource constraints in its reasoning
**Plans**: TBD

Plans:
- [ ] 04-01: TBD
- [ ] 04-02: TBD

### Phase 05: Infrastructure Monitoring
**Goal**: The orchestrator detects service outages across the Mac Mini and can recover failed services within its autonomy level
**Depends on**: Phase 03 (structured output, semaphore)
**Requirements**: INFRA-01, INFRA-02, INFRA-03
**Success Criteria** (what must be TRUE):
  1. The orchestrator checks all configured services (HTTP endpoints, Docker containers, launchd processes) on their own intervals and the user receives an SMS when a service goes down
  2. At moderate+ autonomy, the orchestrator automatically restarts a failed launchd service or Docker container -- but stops if 3+ services fail simultaneously (infrastructure event) or the restart budget (2/hour) is exhausted
  3. The orchestrator can call external tools (GitHub, Docker, Calendar, Reminders) via `claude -p --allowedTools` with circuit breaker protection -- 3 consecutive MCP failures disable that server for 5 minutes
**Plans**: TBD

Plans:
- [ ] 05-01: TBD
- [ ] 05-02: TBD

### Phase 06: Revenue & Autonomy
**Goal**: The orchestrator understands which projects generate revenue, builds trust through demonstrated competence, and earns its way to higher autonomy levels
**Depends on**: Phase 04 (evaluation scores for trust metrics), Phase 03 (structured output)
**Requirements**: REV-01, REV-02, REV-03, REV-04, REV-05
**Success Criteria** (what must be TRUE):
  1. The orchestrator collects revenue data from XMR mining and MLX access logs, stores snapshots in SQLite with NULL vs zero distinction, and the AI context shows per-source earnings with data age
  2. Trust metrics accumulate per autonomy level (sessions launched, avg evaluation score, false alert rate, days at level) and are visible in AI context
  3. When trust thresholds are crossed (e.g., 30+ sessions at cautious with avg score >= 3.5), the user receives a promotion recommendation SMS -- the orchestrator never self-promotes
  4. The user receives a weekly revenue summary SMS on Sunday mornings with per-source breakdown and week-over-week trends
  5. The user receives an evening wind-down digest at 9:45 PM summarizing the day's session accomplishments, commits across projects, and tomorrow's plan
**Plans**: TBD

Plans:
- [ ] 06-01: TBD
- [ ] 06-02: TBD

### Phase 07: Personal Assistant
**Goal**: The orchestrator becomes a personal assistant that remembers conversations, sets reminders, equips sessions with external tools, and learns from experience
**Depends on**: Phase 04 (evaluation data for learning), Phase 05 (MCP bridge for session tools), Phase 03 (conversation persistence foundation)
**Requirements**: PA-01, PA-02, PA-03, PA-04
**Success Criteria** (what must be TRUE):
  1. The user can text "remind me to check YouTube OAuth tomorrow at 10am" and receive that reminder SMS at the scheduled time
  2. The AI references past conversations and user-declared facts from SQLite-backed conversation history (last 100 exchanges)
  3. Managed Claude Code sessions launched by the orchestrator have MCP server access (GitHub, filesystem) configured via `.mcp.json` or `--allowedTools`
  4. After 50+ session evaluations, the orchestrator identifies which prompt styles and session durations yield the best scores and adjusts future session decisions accordingly
**Plans**: TBD

Plans:
- [ ] 07-01: TBD
- [ ] 07-02: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 03 -> 04 -> 05 -> 06 -> 07

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 01. AI Brain Foundation | v3.0 | 3/3 | Complete | 2026-02-16 |
| 02. Autonomous Execution | v3.0 | 4/4 | Complete | 2026-02-16 |
| 03. Foundation Hardening | v4.0 | 4/4 | Complete | 2026-02-17 |
| 04. Session Intelligence | v4.0 | 0/TBD | Not started | - |
| 05. Infrastructure Monitoring | v4.0 | 0/TBD | Not started | - |
| 06. Revenue & Autonomy | v4.0 | 0/TBD | Not started | - |
| 07. Personal Assistant | v4.0 | 0/TBD | Not started | - |
