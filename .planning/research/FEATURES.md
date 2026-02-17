# Feature Landscape: ONE Claude v4.0

**Domain:** AI-powered single-user project orchestrator with external integrations
**Researched:** 2026-02-16
**Mode:** Ecosystem (Features dimension for v4.0 milestone)

## Context

This is a SUBSEQUENT MILESTONE feature map. v3.0 is complete and running. It provides:
- AI brain with `claude -p` think cycles (5 min interval)
- Context assembler (project state -> structured prompt for AI)
- Decision executor with action allowlist, cooldowns, autonomy gating
- 4 autonomy levels (observe/cautious/moderate/full)
- 4-tier notification system (urgent/action/summary/debug)
- AI-generated morning digest
- Session time boxing (45 min cap)
- Proactive staleness detection
- Smart error recovery with retry counting
- Session prompt engineering
- Natural language SMS routing (all non-"ai on/off" messages go through AI)
- priorities.json for user overrides

v4.0 adds depth: the orchestrator should understand whether sessions actually accomplished anything (evaluation), track the health of services running on the Mac Mini (monitoring), understand revenue across the portfolio (intelligence), earn trust through demonstrated competence (graduated autonomy), and become genuinely useful for daily life (personal assistant).

The user manages ~19 projects on a Mac Mini, communicates via iMessage/SMS only, runs services 24/7, and wants autonomous operation with minimal interruption.

---

## Table Stakes

Features that v4.0 must have to be a meaningful upgrade over v3.0. Without these, v4.0 is a version bump with no substance.

| # | Feature | Why Expected | Complexity | Depends On | Notes |
|---|---------|--------------|------------|------------|-------|
| T1 | **Session Output Evaluation** | v3.0 launches sessions blindly without knowing if they helped. The AI must judge work quality to make better decisions. | Medium | v3.0 AI brain, session manager | Use LLM-as-judge pattern. After a session ends: capture tmux output (last 50-100 lines), run `git diff --stat` and `git log --oneline -5` in the project dir, feed both to `claude -p` with a structured rubric. Output: score (1-5), what was accomplished, what failed, whether to continue or escalate. |
| T2 | **Git Progress Tracking** | The only objective measure of "did something happen" is the git history. Without this, the AI is guessing. | Low | Existing scanner, child_process | Per-project: count commits in last N hours, capture diff stats (files changed, insertions, deletions), detect new test files, detect STATE.md changes. Feed into context assembler. This is the ground truth that evaluation and prioritization depend on. |
| T3 | **Service Health Monitoring** | The Mac Mini runs 7+ services (scraping API, MLX, SSH terminal, site monitor, income dashboard, XMR miner, bandwidth containers). The orchestrator should know when they're down. | Medium | None (new module) | Health check registry in config: each service defines a check (HTTP endpoint, TCP port, process name, or Docker container status). Poll every 60-120 seconds. Track uptime/downtime streaks. Alert (tier 1 URGENT) on service down. Track in state.json for digest and AI context. |
| T4 | **Revenue Intelligence** | The user explicitly prioritizes revenue projects. The orchestrator should know actual numbers, not just project status. | Medium-High | T3 (health checks for service availability) | Scrape/query revenue data from: RapidAPI analytics, Apify usage stats, Stripe (if applicable), Docker bandwidth container earnings. Aggregate into daily/weekly/monthly summaries. Feed into context assembler so AI can reason about "web-scraping-biz earned $X this week, bandwidth sharing earned $Y". Store in SQLite (already a dependency via better-sqlite3). |
| T5 | **Graduated Autonomy with Trust Building** | v3.0 has 4 levels but no mechanism to earn promotion. The user must manually set levels. v4.0 should recommend its own promotions based on track record. | Medium | T1 (evaluation provides track record data) | Track success metrics: sessions launched that scored 3+/5, errors caught and recovered, false positive rate on alerts. After N successful autonomous actions at level X, recommend promotion to X+1 via SMS. User confirms with "yes" or "level moderate". Never self-promote -- always ask. The 5-level framework (operator/collaborator/consultant/approver/observer) from Knight Columbia maps well, but our 4 levels are sufficient for a single user. |

### Table Stakes Rationale

These 5 features are non-negotiable because:
- **T1 + T2**: Without knowing if sessions accomplished anything, the AI is launching sessions into a void. Evaluation closes the feedback loop.
- **T3**: The Mac Mini IS the infrastructure. If a service goes down and nobody notices for hours, the orchestrator has failed its primary job.
- **T4**: "Prioritize revenue projects" is meaningless without revenue data. The AI needs numbers to reason about ROI.
- **T5**: The user wants autonomous operation. Graduated autonomy is the path from "observe mode that never acts" to "full autonomy that earns trust."

---

## Differentiators

Features that make ONE Claude best-in-class for this specific use case. Not expected, but each one meaningfully improves the system.

| # | Feature | Value Proposition | Complexity | Depends On | Notes |
|---|---------|-------------------|------------|------------|-------|
| D1 | **Personal Assistant via SMS** | Transform from "project manager" to "personal assistant." Handle reminders, scheduling, quick lookups, calculations, weather -- anything a PA would do. | Medium | v3.0 natural language SMS | The natural language routing is already built. Extend it with: (1) reminder scheduling via node-cron/setTimeout with persistence to disk, (2) calendar awareness via macOS Calendar.app AppleScript, (3) quick web lookups via `claude -p` with web search tools. The key insight: the user already texts this system for project stuff. Making it useful for everything else requires minimal new code. |
| D2 | **MCP Server Integration for Sessions** | Give managed Claude Code sessions access to GitHub, filesystem, and custom tools via MCP. Currently sessions run with `--dangerously-skip-permissions` but no MCP servers. | Medium | v3.0 session manager | Configure MCP servers at the project level (`.mcp.json`) or user level (`~/.claude.json`). Key integrations: GitHub MCP server (for PR creation, issue tracking), filesystem server (already built-in to Claude Code). The orchestrator's role: ensure MCP configs exist before launching sessions. Use `claude mcp add --scope user` for global tools. Per-project MCP configs via `.mcp.json` checked into repos. |
| D3 | **Session Continuation Intelligence** | When a session times out or completes partially, automatically resume with context about what was accomplished and what remains. | Medium | T1 (evaluation), T2 (git tracking) | Currently `_buildResumePrompt()` is generic ("read STATE.md and continue"). With evaluation data, the prompt becomes: "Last session scored 3/5. Completed: auth module refactor. Remaining: test coverage. Error encountered: port 8080 conflict. Continue from the test coverage step." This dramatically improves session-over-session progress. |
| D4 | **Weekly Revenue Report** | In addition to the daily morning digest, send a weekly revenue summary with trends. | Low | T4 (revenue intelligence) | Every Sunday morning: "This week: $47 revenue ($12 RapidAPI, $8 bandwidth, $27 MLX API). Up 15% vs last week. web-scraping-biz had 3 API calls fail (IP block). Suggest: investigate proxy service." Requires revenue data (T4) and a weekly cron job. Minimal new code -- reuse digest infrastructure. |
| D5 | **Proactive Service Recovery** | When a service goes down, don't just alert -- try to fix it. | Medium | T3 (health monitoring) | For launchd services: `launchctl kickstart -k gui/$(id -u)/<label>`. For Docker containers: `docker restart <name>`. For port conflicts: identify and optionally kill the conflicting process. Recovery actions gated by autonomy level (cautious: alert only, moderate: restart, full: restart + notify). Track recovery attempts to avoid restart loops (max 3 in 30 min). |
| D6 | **Cross-Session Learning** | Track which prompt styles, session durations, and project approaches yield the best evaluation scores. Adjust future sessions accordingly. | High | T1 (evaluation data over time) | After accumulating 50+ session evaluations, analyze: which projects benefit from longer sessions? Which prompt styles (specific vs. generic) score higher? Which time-of-day yields better results? Feed patterns back into session launching decisions. Requires significant data accumulation before it's useful. |
| D7 | **System Resource Dashboard in Context** | Add CPU, memory, disk, and GPU utilization to the AI's context so it can reason about resource constraints. | Low | None | Use `os.cpus()`, `os.freemem()`, `os.totalmem()`, `child_process` for `df -h` and GPU stats. Already partially exists (free memory check in ai-brain.js). Expand to: "Mac Mini: 68% memory used, 45% disk, XMR miner at 5.2 KH/s consuming 4 cores. 2 session slots available but memory is tight -- launch only low-memory projects." |
| D8 | **Conversation Memory for SMS** | Extend the current 10-message history to persistent conversation storage. Allow the AI to reference past decisions, user preferences expressed in conversation, and previous instructions. | Low-Medium | v3.0 commands.js conversation history | Store conversation history in SQLite (already a dependency). Keep last 100 exchanges. On each SMS, include relevant past context in the prompt. "User previously said 'focus on revenue this week' (3 days ago)." Enables: "remember to check on X tomorrow" and "what did I ask about Y last week?" |
| D9 | **Evening Wind-Down Digest** | Before quiet hours start, send a summary of the day's accomplishments and tomorrow's plan. | Low | T1 (evaluation), T2 (git tracking) | Complement the morning digest. At 9:45 PM (15 min before quiet hours): "Today: 5 sessions completed (4 successful), 12 commits across 3 projects. web-scraping-biz shipped new Yelp scraper. Tomorrow: resume crypto-trader grid trading, investigate youtube-automation OAuth." Reuses existing digest infrastructure. |

### Differentiator Prioritization

**Build first (high impact, moderate complexity):**
- D1 (Personal Assistant) -- transforms daily utility; natural language routing already exists
- D3 (Session Continuation Intelligence) -- immediate quality improvement per session
- D5 (Proactive Service Recovery) -- reduces mean-time-to-recovery from hours to seconds
- D7 (System Resource Dashboard) -- low complexity, improves every AI decision

**Build second (data-dependent or moderate complexity):**
- D2 (MCP Server Integration) -- requires per-project MCP configuration work
- D4 (Weekly Revenue Report) -- requires T4 revenue data first
- D8 (Conversation Memory) -- quality-of-life improvement
- D9 (Evening Digest) -- low complexity but dependent on T1/T2

**Build last (requires data accumulation):**
- D6 (Cross-Session Learning) -- needs 50+ evaluations, weeks of runtime

---

## Anti-Features

Things to deliberately NOT build for v4.0. These are tempting but wrong for this system.

| # | Anti-Feature | Why Avoid | What to Do Instead |
|---|--------------|-----------|-------------------|
| A1 | **Web Dashboard for Health Monitoring** | The user prefers SMS. A dashboard is already running at income-dashboard (port 8060) and site-monitor (port 8070). Building another dashboard is redundant work that won't get used. | Send health alerts via SMS. If visualization is needed, add health data to the existing income-dashboard or site-monitor. |
| A2 | **Revenue Data via Official APIs (Stripe, RapidAPI, etc.)** | Each platform has a different auth flow, rate limits, and API shape. Building 5 API integrations is a rabbit hole. | Start simple: scrape earnings pages with `claude -p` reading cached HTML, or parse email receipts/notifications. Graduate to official APIs only for high-value sources where scraping breaks. |
| A3 | **MCP Server AS the Orchestrator** | Tempting to expose the orchestrator itself as an MCP server so Claude Desktop or other tools can control it. Adds complexity for a feature nobody asked for. | The orchestrator controls sessions. Sessions don't control the orchestrator. Keep the hub-spoke model. `claude mcp serve` already exists if someone wants raw Claude tools. |
| A4 | **Complex Autonomy Level Granularity** | The Knight Columbia framework defines 5 levels with sub-levels. Our 4 levels (observe/cautious/moderate/full) are already nuanced enough. Adding per-project autonomy levels, per-action levels, or time-based levels is over-engineering. | Keep 4 global levels. If per-project control is needed, use the existing `protectedProjects` list and `block` list in priorities.json. |
| A5 | **Automated Financial Projections** | "Based on current trends, you'll earn $X this month." Financial projections from noisy, incomplete data are misleading. | Report actuals only. "This week: $47. Last week: $32." Let the human draw conclusions. |
| A6 | **Calendar Integration for Session Scheduling** | Scheduling sessions around calendar events ("don't run resource-heavy sessions during meetings") requires Calendar.app integration and adds scheduling complexity. The Mac Mini doesn't attend meetings. | Use quiet hours for scheduling constraints. The existing time-based controls (quiet hours, think interval) are sufficient. If the user is unavailable, the orchestrator should still be working. |
| A7 | **Persistent Vector Store for Project Knowledge** | v3.0 research already rejected this. Still true: 19 projects x ~1000 tokens each = ~19K tokens total. Fits easily in a single context window. No embeddings needed. | Continue using direct file reads: STATE.md + git log + signal files. Total context well within model limits. |
| A8 | **Multi-User Support** | Adding user accounts, auth, or role-based access. This is a single-user system on a single machine. | Keep it single-user. The iMessage integration inherently gates access to one phone number. |
| A9 | **Docker Container Orchestration** | The bandwidth-sharing containers are managed by their own docker-compose. The orchestrator should monitor health but not manage container lifecycle (create, scale, update images). | Monitor container health via `docker ps` / `docker inspect`. Alert on down containers. Let the user or a dedicated script handle container lifecycle. |
| A10 | **Automated Dependency Updates** | Running `npm update` or `pip install --upgrade` across 19 projects. High risk of breaking things, low value. | Track staleness (already done). If a project has outdated deps, flag it as a session task: "web-scraping-biz has 3 outdated npm packages. Start a session to update?" The session (Claude Code) handles the update safely. |

### Anti-Feature Rationale

The common thread: v4.0 should make the existing system deeper, not wider. Each anti-feature above either (1) duplicates something that already exists, (2) adds complexity for a single-user system that doesn't need it, or (3) turns the orchestrator into something it isn't (a container manager, a financial planner, a multi-user platform).

---

## Feature Dependencies

```
T2 (Git Progress Tracking) ─────────────────────┐
  |                                               |
  v                                               v
T1 (Session Output Evaluation) ──────> D3 (Session Continuation Intelligence)
  |                                    |
  v                                    v
T5 (Graduated Autonomy) ──────> D6 (Cross-Session Learning)
  |
  v
D9 (Evening Digest)

T3 (Service Health Monitoring) ──────> D5 (Proactive Service Recovery)
  |                                    |
  v                                    v
T4 (Revenue Intelligence) ──────────> D4 (Weekly Revenue Report)
  |
  v
D7 (System Resource Dashboard) [no hard deps, enhances everything]

v3.0 Natural Language SMS ──────────> D1 (Personal Assistant)
  |                                    |
  v                                    v
D8 (Conversation Memory) ─────────── D1 benefits from D8 but doesn't require it

v3.0 Session Manager ─────────────> D2 (MCP Server Integration)
```

### Critical Path

The critical path for v4.0 value delivery is:

```
T2 (Git Tracking) -> T1 (Evaluation) -> T5 (Graduated Autonomy)
```

This chain creates the feedback loop: track objective progress, evaluate it, use evaluations to build trust, earn higher autonomy. Without this chain, the orchestrator remains in observe mode forever.

The second critical path is:

```
T3 (Health Monitoring) -> T4 (Revenue Intelligence) -> D4 (Weekly Report)
```

This chain answers "is everything running and making money?" which is the primary concern for a passive income portfolio.

---

## Feature Detail: Session Output Evaluation (T1)

The most impactful new capability. Here's how it should work.

### Evaluation Trigger

When a session ends (tmux session disappears, completed.json signal, or timeout), the evaluator runs.

### Data Collection

```
1. Capture last 100 lines of tmux output (before session kill):
   tmux capture-pane -t "orch-<project>" -p -S -100

2. Run git diff in the project directory:
   git diff --stat HEAD~5..HEAD  (last 5 commits)
   git log --oneline -5

3. Read signal files:
   .orchestrator/completed.json (if exists)
   .orchestrator/error.json (if exists)

4. Read STATE.md for before/after comparison:
   (pre-session snapshot vs current)
```

### Evaluation Prompt

Feed collected data to `claude -p` with a structured rubric:

```
Score 1-5 based on:
- Did the session produce meaningful code changes? (git diff)
- Did it advance the project's stated goals? (STATE.md)
- Did it complete without errors? (signal files)
- Is the code likely correct? (tests passing, no obvious issues)

Output JSON:
{
  "score": 3,
  "accomplished": ["Implemented auth module", "Added 5 tests"],
  "failed": ["Port conflict prevented server startup"],
  "recommendation": "continue",  // continue | retry | escalate | complete
  "nextPrompt": "Resume from test coverage. Port 8080 was conflicting with MLX API."
}
```

### Integration Points

- Score feeds into T5 (graduated autonomy trust metrics)
- `nextPrompt` feeds into D3 (session continuation intelligence)
- Accomplished/failed feeds into morning/evening digests
- Recommendation drives the next AI think cycle decision

### Confidence: HIGH

The LLM-as-judge pattern is well-documented and achieves 80-90% agreement with human evaluators when given clear rubrics. The data collection (git diff, tmux capture, signal files) uses commands already available in the codebase. `claude -p --output-format json --json-schema` provides structured output natively.

---

## Feature Detail: Service Health Monitoring (T3)

### Health Check Registry

Add to `config.json`:

```json
{
  "healthChecks": {
    "web-scraping-api": {
      "type": "http",
      "url": "http://localhost:8002/health",
      "intervalMs": 120000,
      "timeoutMs": 5000
    },
    "mlx-inference-api": {
      "type": "http",
      "url": "http://localhost:8100/health",
      "intervalMs": 120000,
      "timeoutMs": 5000
    },
    "ssh-terminal": {
      "type": "tcp",
      "host": "localhost",
      "port": 7681,
      "intervalMs": 120000
    },
    "income-dashboard": {
      "type": "http",
      "url": "http://localhost:8060/",
      "intervalMs": 300000,
      "timeoutMs": 5000
    },
    "site-monitor": {
      "type": "http",
      "url": "http://localhost:8070/",
      "intervalMs": 300000,
      "timeoutMs": 5000
    },
    "xmr-miner": {
      "type": "process",
      "processName": "xmrig",
      "intervalMs": 300000
    },
    "cloudflared-tunnel": {
      "type": "process",
      "processName": "cloudflared",
      "intervalMs": 120000
    },
    "bandwidth-containers": {
      "type": "docker",
      "containerPrefix": "bandwidth",
      "intervalMs": 300000
    }
  }
}
```

### Implementation

New module: `lib/health-monitor.js`

```
- HTTP checks: native fetch() (Node 18+), check status 200
- TCP checks: net.createConnection, check connection success
- Process checks: ps aux | grep <processName>
- Docker checks: docker ps --filter name=<prefix> --format '{{.Status}}'
```

### State Tracking

Per-service: `{ status: "up"|"down", lastCheck, lastUp, lastDown, downStreak, uptimePercent24h }`

Store in `.state.json` alongside existing state.

### Alerting

- Service goes down: tier 1 URGENT (first occurrence), tier 2 ACTION (subsequent)
- Service recovers: tier 3 SUMMARY
- Multiple services down simultaneously: tier 1 URGENT with aggregate message
- Down > 30 minutes: re-alert once

### Context Integration

Feed health status into context assembler:

```
Services (8 monitored):
  web-scraping-api: UP (99.8% 24h)
  mlx-inference-api: DOWN 12min (restarted 2x)
  ssh-terminal: UP
  ...
```

### Confidence: HIGH

All check types use built-in Node.js capabilities (fetch, net, child_process). The pattern is standard daemon health monitoring. No external dependencies needed.

---

## Feature Detail: Revenue Intelligence (T4)

### Data Sources

| Source | What to Track | How to Get It | Frequency |
|--------|--------------|---------------|-----------|
| RapidAPI | API calls, revenue | Scrape dashboard or use analytics API | Daily |
| Apify | Actor runs, revenue | Apify API with API token | Daily |
| Bandwidth sharing | Earnings per container | Varies by service (EarnApp, Honeygain, etc.) | Weekly |
| MLX Inference API | Requests served | Parse access logs at port 8100 | Daily |
| XMR Mining | Hashrate, estimated earnings | Parse xmrig API (localhost:8080/1/summary) or pool stats | Daily |

### Storage

SQLite table (already have better-sqlite3):

```sql
CREATE TABLE revenue_snapshots (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,       -- 'rapidapi', 'apify', 'bandwidth', 'mlx', 'xmr'
  date TEXT NOT NULL,         -- '2026-02-16'
  amount_cents INTEGER,       -- revenue in cents (avoids float issues)
  metadata TEXT,              -- JSON: API calls, hashrate, etc.
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_revenue_source_date ON revenue_snapshots(source, date);
```

### Complexity Note

This is the hardest table stake because each revenue source has a different API/scraping approach. Recommend starting with the two easiest sources:
1. **XMR mining**: xmrig exposes a local API, trivial to query
2. **MLX API**: count requests in access logs (local file parsing)

Then add RapidAPI and Apify once the infrastructure works. Bandwidth sharing is lowest priority (smallest revenue, hardest to query across 9 containers).

### Confidence: MEDIUM

The collection mechanisms vary significantly per source. Some may require API keys not yet configured. Start simple and expand.

---

## Feature Detail: Personal Assistant (D1)

### What Makes an SMS-Based PA Genuinely Useful

Based on research into Toki, Dola, and Lindy (text-based AI assistants), the features that get daily use are:

1. **Reminders**: "Remind me to check youtube OAuth tomorrow at 10am"
2. **Quick lookups**: "What's the weather?" / "Convert 45 EUR to USD"
3. **Calculations**: "If I earn $47/week from APIs, what's that annually?"
4. **Notes**: "Remember that the proxy service costs $29/mo"
5. **Scheduling awareness**: "What's on my calendar today?"

### Implementation Approach

The natural language SMS routing already exists (`_handleNaturalLanguage` in commands.js). The AI already gets full project context. To add PA capabilities:

1. **Reminders**: Add a `reminders` array to state.json. On each scan interval, check for due reminders. When due, send SMS via existing messenger. The AI can add reminders by outputting structured JSON with a `setReminder` action. Persist across restarts.

2. **Web lookups**: `claude -p` already has access to tools when run with `--dangerously-skip-permissions`. For questions that need current info, the AI can invoke web tools during the natural language processing.

3. **Notes/Memory**: D8 (Conversation Memory) enables this. Store user-declared facts in SQLite. Query them when relevant.

4. **Calendar**: macOS Calendar.app is scriptable via JXA (JavaScript for Automation). `osascript -l JavaScript -e 'Application("Calendar").calendars...'`. The orchestrator already uses AppleScript for iMessage.

### What to Skip

- Complex scheduling (book meetings, coordinate with others) -- single user, no need
- Email management -- user explicitly prefers SMS
- App integrations (Slack, Notion, etc.) -- not in the user's workflow

### Confidence: MEDIUM-HIGH

Reminders and notes are straightforward. Calendar integration via JXA is feasible but may have edge cases. Web lookups work because `claude -p` with skip-permissions has tool access.

---

## Feature Detail: Graduated Autonomy Trust Building (T5)

### Trust Metrics

Track in state.json per autonomy level:

```json
{
  "trustMetrics": {
    "cautious": {
      "sessionsLaunched": 47,
      "evaluationScores": [4, 3, 5, 4, 2, 4, 3, 5, ...],
      "avgScore": 3.8,
      "errorsRecovered": 12,
      "falseAlerts": 2,
      "promotionThreshold": 30,
      "daysAtLevel": 14
    }
  }
}
```

### Promotion Criteria

| From | To | Criteria |
|------|----|----------|
| observe | cautious | User manually sets (no auto-promotion from observe) |
| cautious | moderate | 30+ sessions with avg score >= 3.5, < 10% false alert rate, 7+ days at level |
| moderate | full | 50+ sessions with avg score >= 4.0, successful stop/restart track record, 14+ days at level |

### Demotion Triggers

| Trigger | Action |
|---------|--------|
| 3 consecutive session scores <= 2 | Demote one level, notify user |
| Service outage caused by orchestrator action | Demote to observe, URGENT notify |
| User texts "ai level observe" or "ai off" | Immediate demotion (already works) |

### Promotion Flow

1. Trust metrics cross threshold
2. AI think cycle detects promotion opportunity
3. SMS: "I've successfully managed 35 sessions at cautious level (avg score 3.8). Ready to try moderate mode? This would let me stop stuck sessions automatically. Reply 'level moderate' to confirm."
4. User confirms (or doesn't)
5. Never auto-promote. Always ask.

### Confidence: HIGH

This is a state machine with numeric thresholds. The complexity is in choosing the right thresholds, not in the implementation. The 5-level framework from the Knight Columbia research validates the graduated approach. Our existing 4 levels map cleanly: observe=operator, cautious=collaborator, moderate=approver, full=observer.

---

## MVP Recommendation for v4.0

### Phase 1: Feedback Loop (highest priority)

1. **T2** - Git Progress Tracking (ground truth for evaluation)
2. **T1** - Session Output Evaluation (close the feedback loop)
3. **D7** - System Resource Dashboard (low complexity, enhances AI context)

**Why first:** Without evaluation, the orchestrator is flying blind. Every subsequent feature benefits from knowing "did that session actually work?"

### Phase 2: Infrastructure Awareness

4. **T3** - Service Health Monitoring (know when things break)
5. **D5** - Proactive Service Recovery (fix things automatically)
6. **D3** - Session Continuation Intelligence (better prompts from evaluation data)

**Why second:** The Mac Mini is the infrastructure. Health monitoring is the second most valuable feedback loop after session evaluation.

### Phase 3: Intelligence

7. **T4** - Revenue Intelligence (start with XMR + MLX, expand later)
8. **T5** - Graduated Autonomy (trust building from evaluation data)
9. **D4** - Weekly Revenue Report (requires T4 data)
10. **D9** - Evening Digest (low complexity, high daily value)

**Why third:** Revenue data collection takes time to stabilize. Graduated autonomy requires evaluation data to accumulate. Both benefit from Phase 1 and 2 being solid.

### Phase 4: Personal Assistant & Polish

11. **D1** - Personal Assistant (reminders, lookups, notes)
12. **D8** - Conversation Memory (persistent SMS history)
13. **D2** - MCP Server Integration (per-project tool access)
14. **D6** - Cross-Session Learning (requires weeks of data)

**Why last:** These are quality-of-life improvements that don't affect the core orchestration loop. D1 is high-value but not urgent. D6 requires data accumulation.

### Phase Ordering Rationale

The order follows two principles:
1. **Close feedback loops first** (evaluation before autonomy, health checks before recovery)
2. **Ground truth before intelligence** (git tracking before evaluation, health data before revenue)

Each phase builds on the previous: Phase 1 produces evaluation data, Phase 2 uses it for better sessions, Phase 3 adds revenue context and autonomy, Phase 4 extends to personal use.

---

## Sources

### HIGH Confidence (Official Documentation)
- [Claude Code Headless/Programmatic Mode](https://code.claude.com/docs/en/headless) - Verified: `claude -p --output-format json --json-schema` enables structured evaluation output
- [Claude Code MCP Integration](https://code.claude.com/docs/en/mcp) - Verified: MCP servers configurable at local/project/user scope, stdio/HTTP/SSE transports, works with `claude -p`
- [macOS launchd KeepAlive](https://www.launchd.info/) - Verified: KeepAlive with SuccessfulExit for auto-restart on crash

### MEDIUM Confidence (Multiple Sources Agree)
- [LLM-as-a-Judge Best Practices (Langfuse)](https://langfuse.com/docs/evaluation/evaluation-methods/llm-as-a-judge) - G-Eval pattern, 1-5 scoring rubrics, 80-90% human agreement
- [LLM-as-a-Judge Guide (Evidently AI)](https://www.evidentlyai.com/llm-guide/llm-as-a-judge) - Chain-of-thought evaluation, structured rubrics
- [Knight Columbia AI Autonomy Levels](https://knightcolumbia.org/content/levels-of-autonomy-for-ai-agents-1) - 5-level autonomy framework: operator/collaborator/consultant/approver/observer
- [AI Agent Evaluation Metrics 2026 (Master of Code)](https://masterofcode.com/blog/ai-agent-evaluation) - Task success, trajectory analysis, tool correctness metrics
- [Bounded Autonomy Pattern (Palo Alto Networks)](https://www.paloaltonetworks.com/cyberpedia/what-is-agentic-ai-governance) - Defined limits, escalation paths, audit trails
- [Taming AI Agents 2026 (CIO)](https://www.cio.com/article/4064998/taming-ai-agents-the-autonomous-workforce-of-2026.html) - Bounded autonomy with clear constraints
- [Docker Health Check Patterns (OneUptime)](https://oneuptime.com/blog/post/2026-01-23-docker-health-checks-effectively/view) - Liveness vs readiness, split endpoints
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) - Node.js MCP client/server implementation, stdio and HTTP transports

### LOW Confidence (Single Source, Verify During Implementation)
- [AI Personal Assistant Tools 2026 (Lindy)](https://www.lindy.ai/blog/ai-scheduling-assistant) - SMS-based scheduling patterns
- [Toki SMS Scheduling](https://yestoki.com/) - Conversational scheduling via messaging
- [Claude Code Usage Monitor](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor) - Session metrics and observability approach
- [Git AI Tracking](https://usegitai.com/) - Tracking AI-generated code per line (not needed for our use case, but validates the git-as-ground-truth approach)
