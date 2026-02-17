# Requirements — v4.0 Autonomous Agent with External Integrations

## Foundation Hardening

- [ ] **FOUND-01**: NL handler uses `--max-turns 1` and does not use `--dangerously-skip-permissions`
- [ ] **FOUND-02**: Global ClaudeSemaphore limits concurrent `claude -p` processes to 2 max
- [ ] **FOUND-03**: All AI brain `claude -p` calls use `--json-schema` for structured output (replaces fragile 3-stage parser)
- [ ] **FOUND-04**: Conversation history persists to `.conversation-history.json` and survives daemon restarts (TTL 24h, cap 20 messages, credential filtering)
- [ ] **FOUND-05**: Test infrastructure exists with `node:test`, `lib/exec.js` wrapper for mocking, temp directory helpers, and core integration tests
- [ ] **FOUND-06**: AI recommendation dedup prevents repetitive notifications in observe mode (content-based dedup, not just cooldown timers)

## Session Intelligence

- [ ] **SESS-01**: Orchestrator tracks git progress per project (commit count, diff stats, files changed, last commit timestamp) and feeds into AI context
- [ ] **SESS-02**: Orchestrator evaluates session output quality using tmux capture + git diff + objective signals (tests, commits) + LLM-as-judge rubric (score 1-5, recommendation: continue/retry/escalate/complete)
- [ ] **SESS-03**: Session resume prompts incorporate evaluation data ("Last session scored 3/5. Completed: X. Failed: Y. Continue from Z.")
- [ ] **SESS-04**: AI context includes system resource data (CPU load, free memory, disk usage, active processes) so AI can reason about resource constraints

## Infrastructure Monitoring

- [ ] **INFRA-01**: Health monitor checks 8+ services via configurable registry in `config.json` — supports HTTP, TCP, process, and Docker check types with per-service intervals and timeouts
- [ ] **INFRA-02**: Orchestrator can automatically restart failed services (`launchctl kickstart` for launchd services, `docker restart` for containers), gated by autonomy level, with restart budget (max 2/hour) and correlated failure detection (3+ simultaneous = infrastructure event, no restarts)
- [ ] **INFRA-03**: MCP bridge enables `claude -p --allowedTools` for external integrations (GitHub, Docker, Calendar, Reminders, Memory) with circuit breaker per MCP server (3 consecutive failures = 5-min backoff)

## Revenue & Autonomy

- [ ] **REV-01**: Revenue tracker collects earnings data from local sources (XMR mining API, MLX access logs) and stores snapshots in SQLite with NULL vs zero distinction and data age tracking
- [ ] **REV-02**: Trust metrics track per-autonomy-level stats (sessions launched, avg evaluation score, false alert rate, days at level) for graduated autonomy promotion decisions
- [ ] **REV-03**: Orchestrator recommends autonomy level promotions via SMS when trust metrics cross thresholds (e.g., 30+ sessions at cautious with avg score >= 3.5) — never self-promotes, always asks user
- [ ] **REV-04**: Weekly revenue summary SMS sent Sunday mornings with per-source breakdown and week-over-week trends
- [ ] **REV-05**: Evening wind-down digest sent at 9:45 PM with day's session accomplishments, commits across projects, and tomorrow's AI plan

## Personal Assistant

- [ ] **PA-01**: User can set reminders via SMS ("remind me to check YouTube OAuth tomorrow at 10am") that persist to disk and fire at the scheduled time via existing notification system
- [ ] **PA-02**: Conversation history stored in SQLite (last 100 exchanges) with timestamps, enabling the AI to reference past conversations and user-declared facts
- [ ] **PA-03**: Managed Claude Code sessions have MCP server access configured (GitHub MCP, filesystem) via `.mcp.json` or `--allowedTools` flags
- [ ] **PA-04**: Orchestrator tracks which prompt styles, session durations, and project approaches yield best evaluation scores, feeding patterns back into future session decisions (requires 50+ evaluations)

---

## Future Requirements (deferred beyond v4.0)

- Revenue tracking from platform APIs (RapidAPI GraphQL, Apify API, bandwidth service dashboards) — deferred until local sources are proven stable
- Calendar integration for session scheduling (schedule around meetings) — unnecessary for always-on Mac Mini
- Web dashboard for health monitoring — SMS is the interface, existing dashboards cover visualization
- Per-project autonomy levels — global 4-level system is sufficient for single user
- Automated financial projections — report actuals only, let human draw conclusions
- Docker container lifecycle management (create, scale, update) — monitor health only

## Out of Scope

- Multi-user support or RBAC (single-user system)
- Vector store / RAG (19 projects fit in context window)
- Agent-to-agent communication (hub-spoke model is correct)
- Plugin/extension system (single developer, modify code directly)
- Web dashboard UI (SMS is the interface)

---

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| FOUND-01 | 03 | Pending |
| FOUND-02 | 03 | Pending |
| FOUND-03 | 03 | Pending |
| FOUND-04 | 03 | Pending |
| FOUND-05 | 03 | Pending |
| FOUND-06 | 03 | Pending |
| SESS-01 | 04 | Pending |
| SESS-02 | 04 | Pending |
| SESS-03 | 04 | Pending |
| SESS-04 | 04 | Pending |
| INFRA-01 | 05 | Pending |
| INFRA-02 | 05 | Pending |
| INFRA-03 | 05 | Pending |
| REV-01 | 06 | Pending |
| REV-02 | 06 | Pending |
| REV-03 | 06 | Pending |
| REV-04 | 06 | Pending |
| REV-05 | 06 | Pending |
| PA-01 | 07 | Pending |
| PA-02 | 07 | Pending |
| PA-03 | 07 | Pending |
| PA-04 | 07 | Pending |
