# Domain Pitfalls: v4.0 Feature Additions

**Domain:** Adding session evaluation, MCP integrations, service health monitoring, revenue intelligence, graduated autonomy, and personal assistant capabilities to an existing Node.js AI orchestrator daemon
**System:** 13-module Node.js daemon on Mac Mini (16 GB RAM), 2 npm dependencies, managing ~19 projects via tmux + iMessage
**Researched:** 2026-02-16
**Overall confidence:** HIGH (verified against MCP specification, GitHub API docs, codebase analysis, and real-world production patterns)

**Scope:** This document covers NEW pitfalls introduced by v4.0 features only. v3.0 pitfalls (runaway automation, stale state, hallucinated understanding, context bloat, parse failures, notification spam, model regression, main loop blocking, log growth) are documented in the v3.0 PITFALLS.md and are either resolved or carried forward as known issues.

---

## Critical Pitfalls

Mistakes that cause system instability, data loss, or require manual intervention to recover from. Must be addressed in the earliest phases or the feature fails.

---

### Pitfall 1: MCP Server Cascade Failure -- One Dead Server Stalls All AI Operations

**Severity:** CRITICAL

**What goes wrong:** v4.0 adds MCP server integrations (GitHub, Docker, Calendar, Reminders, Memory graph). The orchestrator's `claude -p` calls now depend on these MCP servers being available. When one MCP server hangs or crashes (e.g., Docker daemon is restarting, GitHub is rate-limited), the `claude -p` call itself hangs waiting for the MCP tool response. Since `ai-brain.js` uses `execSync` with a 30-second timeout, a single hung MCP server can block the entire think cycle. Worse: if the MCP server returns intermittently, the 30-second timeout may not trigger -- the call takes 28 seconds, returns partial garbage, and the orchestrator processes corrupted output.

**Why it happens in THIS system:**

1. **`execSync` is blocking.** The current `ai-brain.js` line 69-72 uses `execSync('claude -p ...')` with a 30-second timeout. MCP tool calls inside Claude Code happen within that subprocess. The orchestrator has zero visibility into which MCP server is slow.

2. **MCP timeout configuration is unreliable.** Per Claude Code GitHub issues #3033, #20335, and #424, MCP timeout settings configured in `settings.json` are frequently not respected. The MCP TypeScript SDK has a hardcoded ~60-second default that Claude Desktop/Code may use regardless of configuration. This means a timeout set to 10 seconds may actually be 60 seconds.

3. **Multiple MCP servers create combinatorial failure surface.** With 5 MCP servers (GitHub, Docker, Calendar, Reminders, Memory), the probability that at least one is unhealthy at any given time is significant. Docker daemon restarts, GitHub rate limits (5,000 req/hour per PAT, but only 30 req/min for search), Calendar API authentication expiry, and macOS Reminders access permission prompts can all cause individual server failures.

4. **No circuit breaker exists.** The current system has no way to "turn off" a failing MCP server temporarily. If the Docker MCP server is down, every think cycle that tries to use Docker tools will timeout.

**Consequences:**
- Think cycle blocked for 30-60 seconds instead of 3-5 seconds (10x slowdown)
- SMS command responsiveness degrades (natural language handler at commands.js:643 also uses `execSync` with 120-second timeout and `--dangerously-skip-permissions`)
- If multiple MCP servers fail, think cycles consume all available time and never produce useful output
- Cascading: blocked think cycles queue up, memory usage grows from pending claude processes

**Warning signs:**
- Think cycle `duration_ms` in state suddenly increases from ~5s to 25-30s
- AI decisions contain empty recommendations with error summaries mentioning "tool not available" or "server disconnected"
- MCP-related error messages in claude-p stderr output
- System memory increasing due to stuck child processes

**Prevention:**

1. **MCP health check before think cycle.** Before invoking `claude -p`, run a lightweight check on each MCP server. This can be a simple `claude -p "list tools"` or a direct health check per transport type (stdio: is process alive? HTTP: can we connect?). Skip MCP-dependent reasoning for any unhealthy server.

```javascript
// In ai-brain.js, before think()
const healthyServers = await this._checkMCPHealth();
const prompt = this.contextAssembler.assemble({
  availableMCPs: healthyServers
});
```

2. **Circuit breaker per MCP server.** Track consecutive failures per server. After 3 consecutive failures, disable that server for 5 minutes (exponential backoff up to 30 minutes). The ContextAssembler should tell the AI which tools are available vs. temporarily disabled.

```javascript
// Circuit breaker state
this._mcpCircuitBreakers = {
  github: { failures: 0, disabledUntil: null },
  docker: { failures: 0, disabledUntil: null },
  // ...
};
```

3. **Separate MCP-dependent and MCP-independent reasoning.** The basic think cycle (project scanning, priority scoring) should NOT require MCP servers. Only specific features need specific servers:
   - GitHub: session evaluation (git diff analysis)
   - Docker: service health monitoring
   - Calendar/Reminders: personal assistant
   - Memory: cross-session learning

   If GitHub is down, the orchestrator should still be able to scan projects, score priorities, and start sessions. Only session evaluation degrades.

4. **Use `execFile` instead of `execSync` where possible.** For MCP health checks, use async `exec` or `execFile` with strict per-check timeouts (5 seconds max). Do not let a health check itself become a blocking operation.

5. **MCP server process management.** For stdio-based MCP servers, the orchestrator should own the server lifecycle: start servers on boot, monitor their process health, and restart them on crash. Do NOT rely on Claude Code to manage MCP server processes -- the orchestrator must be the supervisor.

**Which phase should address this:** The FIRST phase that introduces any MCP server integration. The circuit breaker and health check patterns must be established before adding any MCP dependency to the think cycle.

**Concrete code location:** `lib/ai-brain.js` lines 66-72 (execSync call), `lib/context-assembler.js` (prompt building -- must communicate available tools)

---

### Pitfall 2: Graduated Autonomy Escalation Without Rollback -- AI Breaks Things at Higher Permission Levels

**Severity:** CRITICAL

**What goes wrong:** The user promotes the orchestrator from `observe` to `cautious` to `moderate`. At `moderate`, the AI can start, stop, and restart sessions. The AI restarts `web-scraping-biz` during a Fiverr order fulfillment because it detected a "stale" session -- but the session was actively serving a customer request. The user realizes the error and demotes back to `observe`, but the damage is done: the customer order failed, and there is no automatic rollback of the action the AI took.

**Why it happens in THIS system:**

1. **The existing autonomy matrix is one-way.** `DecisionExecutor.AUTONOMY_MATRIX` (decision-executor.js lines 27-32) maps autonomy levels to allowed actions, but there is no concept of "what happens when we demote." Demotion stops future actions but does NOT undo actions already taken.

2. **No action history with undo capability.** The `executionHistory` in state.js logs what happened but provides no mechanism to reverse it. If the AI stopped a session, the user must manually restart it. If the AI started 3 sessions simultaneously before demotion, those sessions continue running.

3. **Autonomy level changes are instant and unguarded.** The current `_handleAiLevel` in commands.js (lines 432-469) allows jumping directly from `observe` to `full` with a single SMS. There is no probation period, no confirmation for high-risk transitions, and no automatic demotion on failure.

4. **v4.0 introduces higher-stakes actions.** Beyond start/stop sessions, v4.0 may add actions like: restart Docker containers (service health), create GitHub issues/PRs (session evaluation), and modify calendar entries (personal assistant). These are harder to undo than session lifecycle changes.

**Consequences:**
- Revenue loss if AI disrupts active service processes
- Data corruption if AI restarts a project mid-write (e.g., mid-database migration)
- Trust erosion: user demotes to observe permanently, making the entire v4.0 autonomy stack useless
- No way to "undo the last 5 minutes" when something goes wrong

**Warning signs:**
- User promotes to a new level and immediately texts "stop" or "stop all" within minutes
- Execution history shows the AI took actions the user quickly overrode
- Same project gets started and stopped multiple times in a short period at higher autonomy levels

**Prevention:**

1. **Staged promotion with probation period.** When promoting from observe -> cautious, require 24 hours of successful operation before allowing cautious -> moderate. This can be configurable but defaults to a soak period.

```javascript
// In state.js
setAutonomyLevel(state, level) {
  const current = this.getAutonomyLevel(state, this.config);
  const levels = ['observe', 'cautious', 'moderate', 'full'];
  const currentIdx = levels.indexOf(current);
  const targetIdx = levels.indexOf(level);

  // Allow instant demotion, gated promotion
  if (targetIdx > currentIdx + 1) {
    throw new Error(`Cannot skip levels. Current: ${current}, max next: ${levels[currentIdx + 1]}`);
  }
  // ...
}
```

2. **Automatic demotion on failure.** If the AI takes an action at `moderate` level and the result is a failure (session crash, error signal within 5 minutes), automatically demote to `cautious` and notify the user. Do not wait for the user to notice.

```javascript
// After execution failure
if (!result.success && autonomyLevel !== 'observe') {
  const demotedLevel = this._demoteOneLevel(autonomyLevel);
  this.state.setAutonomyLevel(s, demotedLevel);
  this._notify(`Action failed. Auto-demoted to ${demotedLevel}`, 1); // URGENT
}
```

3. **Pre-action impact assessment.** Before any destructive action (stop, restart, container restart), check if the target is "hot" -- actively processing, recently received traffic, or has a running tmux session with recent output. If hot, require explicit confirmation regardless of autonomy level.

4. **Action undo registry.** For every action the AI takes, record the inverse action. If the AI stopped a session, the inverse is "start with same prompt." If the AI restarted a Docker container, the inverse is "the container was running fine before." Provide an SMS command: "undo" or "rollback last" that executes the inverse of the most recent AI action.

5. **Rate limiting at higher levels.** At `moderate` and `full`, impose a mandatory 15-minute minimum between consecutive destructive actions on the same project (beyond the existing cooldown). This prevents rapid-fire damage.

**Which phase should address this:** The phase that enables cautious mode in production. Must be fully implemented BEFORE the user moves beyond observe mode.

**Concrete code location:** `lib/decision-executor.js` (execute method, autonomy matrix), `lib/state.js` (setAutonomyLevel), `lib/commands.js` (_handleAiLevel)

---

### Pitfall 3: Session Evaluation False Confidence -- AI Judges Its Own Kind Too Generously

**Severity:** CRITICAL

**What goes wrong:** v4.0 adds session evaluation: when a Claude Code session completes, the orchestrator's AI brain reads the tmux output, checks git diffs, and judges whether the session produced quality work. The problem: LLM-as-judge has a well-documented bias toward favoring LLM-generated output over human-written code, and toward rating verbose responses higher than concise ones (verbosity bias). The orchestrator's AI evaluator will systematically rate mediocre Claude Code sessions as "good work" because the output looks like competent AI-generated code -- even when it introduced bugs, missed requirements, or made poor architectural decisions.

**Why it happens in THIS system:**

1. **Self-evaluation bias.** Research from Softtech/Medium (2026) and EvidentlyAI shows that LLM judges "systematically underrate human-written code because it feels less 'natural' to them than AI-generated code" and "the most common reason for rejecting valid code is the judge hallucinating a missing requirement or a bug that isn't there." The inverse is also true: the judge will accept AI-generated code that HAS bugs because it "looks" correct.

2. **No execution-based verification.** The orchestrator can read git diffs and tmux output, but it cannot RUN the code. It cannot execute tests, check if the build passes, or verify that an API endpoint returns correct data. It is judging a book by its cover -- literally reading the code without running it.

3. **Context window limitations.** A session that ran for 45 minutes may produce thousands of lines of changes. The evaluator will see a truncated view (tmux capture-pane gives limited scrollback, git diff can be massive). It will evaluate based on partial information and fill in the gaps with optimistic assumptions.

4. **Cascading trust.** If the evaluator says "session was successful," the orchestrator will advance to the next phase, potentially launching the next session with a faulty foundation. A chain of false-positive evaluations can result in a project that looks 80% complete but is actually broken.

**Consequences:**
- Projects advance phases based on false-positive evaluations (broken code gets marked as done)
- The orchestrator builds confidence in its evaluation ability, reducing human oversight
- Technical debt accumulates silently across multiple projects
- User discovers weeks later that sessions were producing garbage

**Warning signs:**
- All session evaluations come back positive (unrealistic -- some sessions should fail)
- Project phases advance but the project doesn't actually work when the user checks
- Evaluation scores cluster at the high end (80-95%) instead of spanning a range
- Sessions that are restarted due to errors still get positive evaluations on retry

**Prevention:**

1. **Ground truth signals over LLM judgment.** Use objective, measurable signals as primary evaluation criteria. LLM judgment is secondary.

```javascript
const evaluationSignals = {
  // Objective (HIGH confidence)
  testsExist: await this._checkTestsExist(projectDir),
  testsPass: await this._runTests(projectDir),      // if test suite exists
  buildPasses: await this._checkBuild(projectDir),    // if build step exists
  gitCommitsMade: await this._countNewCommits(projectDir, since),
  linesChanged: await this._gitDiffStats(projectDir, since),

  // Heuristic (MEDIUM confidence)
  signalFilePresent: fs.existsSync(completedJson),
  sessionDuration: durationMinutes,  // < 5 min is suspicious

  // LLM judgment (LOW confidence, supplementary only)
  aiAssessment: await this._llmEvaluate(diffOutput, tmuxOutput)
};
```

2. **Negative signal detection.** Instead of asking "was this good?", ask "what went wrong?" Humans and LLMs are both better at finding specific problems than giving accurate overall assessments. Prompt the evaluator with a checklist of failure modes:
   - Were any files deleted that shouldn't have been?
   - Are there TODO/FIXME comments that indicate incomplete work?
   - Did the session touch files outside its project directory?
   - Are there obvious syntax errors in the diff?
   - Did the session undo work from a previous session?

3. **Evaluation calibration.** Track evaluation accuracy over time by comparing AI evaluations against user feedback. When the user manually checks a project and finds issues, record that as a calibration data point. If evaluations are consistently too optimistic, tighten the criteria.

4. **Default to skepticism.** The evaluation rubric should be biased toward "inconclusive" rather than "success." A session should be marked successful only when there is positive evidence (tests pass, meaningful commits, signal file confirms completion). Absence of negative signals is NOT sufficient for a positive evaluation.

5. **Separate "session completed" from "work is correct."** The session completing is a fact. Whether the work is correct is a judgment. Track these separately. A session can complete successfully (ran for 30 minutes, made commits, no errors) but the work quality may be unknown until verified.

**Which phase should address this:** The phase that adds session evaluation. Must implement objective signals BEFORE enabling LLM-as-judge, and must never use LLM judgment as the sole evaluation criterion.

**Concrete code location:** New module (e.g., `lib/session-evaluator.js`), integrates with `lib/signal-protocol.js` (completed.json handling) and `lib/ai-brain.js` (post-session think cycle)

---

## High Pitfalls

Mistakes that cause significant degradation, wasted resources, or user trust erosion. Important to address early but not immediately system-threatening.

---

### Pitfall 4: External Service Integration Creates New Failure Modes in the Main Loop

**Severity:** HIGH

**What goes wrong:** v4.0 adds GitHub API calls (check PRs, commits, issues), Docker API calls (container health), and potentially Calendar/Reminders API calls. Each of these is a network or IPC call that can fail, timeout, or return unexpected data. The existing main loop in `index.js` has three interval-based loops (message polling at 10s, proactive scan at 60s, think cycle at 300s). Adding external service calls to ANY of these loops introduces new failure modes that can block or crash the loop.

**Why it happens in THIS system:**

1. **The main loop uses `try/catch` around scan functions but not around individual service calls.** In `index.js` line 127-199, `proactiveScan()` catches errors at the top level, but if a new GitHub API call inside a scanner function throws an unhandled promise rejection or returns a Buffer instead of a string, the entire scan cycle crashes.

2. **GitHub API has strict rate limits.** Authenticated REST API: 5,000 requests/hour. Search API: 30 requests/minute. If the orchestrator polls all 19 projects for recent commits, PRs, and issues every scan cycle (60 seconds), it could exhaust the search limit in minutes. The rate limit is shared with `gh` CLI usage across all terminals.

3. **Docker socket calls can hang.** The Docker daemon API on macOS runs via socket at `/var/run/docker.sock`. If the Docker daemon is being updated, is overloaded (9 bandwidth-sharing containers), or is in a bad state, socket calls can hang indefinitely without a timeout unless explicitly configured.

4. **No dependency isolation.** Currently, the orchestrator has 2 npm dependencies (`better-sqlite3`, `node-cron`). Each external service integration potentially adds dependencies (e.g., `@octokit/rest` for GitHub, `dockerode` for Docker). This violates the user's preference for minimal dependencies and creates supply chain risk.

**Consequences:**
- Main loop crash stops all orchestrator functions (message polling, scanning, think cycle)
- GitHub rate limit exhaustion blocks all `gh` CLI usage across the entire Mac Mini
- Docker API hang blocks the scan loop, making the orchestrator unresponsive
- Dependency explosion from 2 to 10+ npm packages

**Warning signs:**
- Orchestrator log shows "unhandled promise rejection" or "TypeError: Cannot read properties of undefined"
- `gh` CLI commands from other terminals fail with "rate limit exceeded"
- Scan cycle duration jumps from ~100ms to multiple seconds
- `package.json` dependencies list growing

**Prevention:**

1. **Zero-dependency external service integration.** Use `child_process.exec` to call existing CLI tools (`gh`, `docker`, `osascript`) rather than adding npm packages. The `gh` CLI for GitHub, `docker` CLI for Docker, and JXA/osascript for Calendar/Reminders are already installed on the Mac Mini. This preserves the 2-dependency footprint.

```javascript
// GitHub: use gh CLI (already installed)
const { execFile } = require('child_process');
execFile('gh', ['pr', 'list', '--repo', repo, '--json', 'title,state'],
  { timeout: 10000, encoding: 'utf-8' }, callback);

// Docker: use docker CLI (already installed)
execFile('docker', ['ps', '--format', 'json'],
  { timeout: 10000, encoding: 'utf-8' }, callback);
```

2. **Service calls are NEVER in the main loop.** External service data should be gathered in a separate async function on its own interval (e.g., every 5 minutes for GitHub, every 2 minutes for Docker). Results are cached in memory. The main loop reads from the cache, never from the API directly.

```javascript
// Separate service data gathering (never blocks main loop)
class ServiceDataCache {
  constructor() {
    this._github = { data: null, fetchedAt: 0, error: null };
    this._docker = { data: null, fetchedAt: 0, error: null };
  }

  async refresh(service) {
    // Runs on its own interval, failures are isolated
  }

  get(service) {
    // Returns cached data or null, never blocks
    return this._cache[service]?.data || null;
  }
}
```

3. **Rate limit awareness for GitHub.** Budget GitHub API calls: 19 projects * 3 calls each (commits, PRs, issues) = 57 calls per refresh. At a 5-minute refresh interval, that is 57 * 12 = 684 calls/hour -- well within the 5,000/hour limit. But avoid the search API entirely (30/min limit). Use specific repo endpoints instead.

4. **Per-service timeout enforcement.** Every external call gets a 10-second timeout, enforced by the `timeout` option on `execFile`. No external call should ever block for more than 10 seconds. If it times out, return null and let the cache serve stale data.

5. **Graceful degradation per service.** Each external service must be independently optional. If GitHub is down, the orchestrator still monitors projects, manages sessions, and sends digests. It just cannot evaluate git diffs or check PRs. The ContextAssembler should note "GitHub data unavailable" in the AI prompt so the AI does not hallucinate GitHub state.

**Which phase should address this:** The FIRST phase that adds any external service call. The ServiceDataCache pattern and CLI-based approach must be established before any service is integrated.

**Concrete code location:** New module (e.g., `lib/service-cache.js`), `index.js` (new interval for service refresh), `lib/context-assembler.js` (include cached service data in prompt)

---

### Pitfall 5: Service Health Monitoring Creates Alert Storms and Cascading Restarts

**Severity:** HIGH

**What goes wrong:** v4.0 adds HTTP health monitoring for running services (income-dashboard on :8060, site-monitor on :8070, mlx-inference-api on :8100, web-scraping-biz API on :8002, SSH terminal on :7681). The orchestrator pings these endpoints and, at higher autonomy levels, automatically restarts failed services. The problem: a transient network hiccup or Cloudflare tunnel reconnection causes ALL health checks to fail simultaneously. The orchestrator interprets this as "everything is down" and attempts to restart all services at once, which actually CAUSES the outage it was trying to prevent.

**Why it happens in THIS system:**

1. **Shared infrastructure.** All services route through a single Cloudflare tunnel (ID: 87e54750). If the tunnel reconnects (which happens periodically), all external health checks via `*.mccloskey-api.com` fail simultaneously. But the services themselves are fine -- only the tunnel is temporarily down.

2. **localhost vs. external health checks.** Health checking via `http://localhost:8060` is more reliable than `https://dashboard.mccloskey-api.com`, but the latter tests the full path users experience. The orchestrator must decide which to check, and the wrong choice leads to either false alarms (external) or missed real failures (localhost).

3. **Docker container restart cascades.** The 9 bandwidth-sharing Docker containers share resources. Restarting one container can cause resource pressure that makes other containers fail their health checks, leading to a cascade of restarts. Docker's exponential backoff restart policy partially mitigates this, but orchestrator-initiated restarts bypass it.

4. **Mac Mini resource contention.** With 16 GB RAM shared across XMR miner, 9 Docker containers, multiple Node.js services, and Claude Code sessions, restarting a service temporarily spikes resource usage (old process dying + new process starting). Multiple simultaneous restarts can push the system into swap, causing everything to slow down.

**Consequences:**
- False alarm avalanche: user gets 5-10 SMS alerts about "services down" during a normal tunnel reconnection
- Cascading restart: orchestrator restarts services that were fine, causing actual downtime
- Resource exhaustion: simultaneous restarts push the Mac Mini into swap
- Alert fatigue: user mutes the orchestrator's notifications, missing real failures later

**Warning signs:**
- Multiple services fail health checks at the exact same timestamp (correlated failure = infrastructure issue, not service issue)
- Health check failures followed by immediate recovery (transient, not real outage)
- Services being restarted but they were already running (redundant restart)
- SMS notification volume spikes during tunnel reconnection events

**Prevention:**

1. **Correlated failure detection.** If more than 2 services fail health checks at the same time, treat it as an infrastructure issue (tunnel, network, system overload), not individual service failures. Do NOT restart anything. Instead, wait one cycle and re-check.

```javascript
const failures = healthResults.filter(r => !r.healthy);
if (failures.length >= 3) {
  // Infrastructure issue, not service issue
  log('HEALTH', `${failures.length} simultaneous failures - likely infrastructure, skipping restarts`);
  return; // Re-evaluate next cycle
}
```

2. **Consecutive failure threshold.** Never restart a service on a single health check failure. Require N consecutive failures (3 is standard) with at minimum 30 seconds between checks before declaring a service truly down.

3. **localhost-first, external-second.** Check `localhost:PORT` first. If localhost is healthy, the service is running -- any external failure is a tunnel/network issue. Only check external URLs if localhost succeeds (confirms the service is up but external access may be broken).

4. **Restart budget.** Maximum 2 service restarts per hour. After that, alert the user instead of restarting. This prevents cascade scenarios.

5. **Separate health check from restart authority.** Health monitoring should run at ALL autonomy levels (even observe). Restart authority should require `moderate` or higher. At `observe` and `cautious`, health failures generate SMS notifications only.

6. **Recovery verification.** After a restart, verify the service actually came back healthy within 60 seconds. If not, do not attempt another restart -- escalate to the user.

**Which phase should address this:** The phase that adds service health monitoring. The correlated failure detection and consecutive failure threshold must be implemented BEFORE any auto-restart capability.

---

### Pitfall 6: Revenue Tracking Produces Wrong Numbers That Inform Wrong Priorities

**Severity:** HIGH

**What goes wrong:** v4.0 adds revenue intelligence -- tracking actual earnings from web-scraping-biz (RapidAPI), mlx-inference-api (RapidAPI), bandwidth-sharing (multiple providers), and XMR mining. The orchestrator uses these numbers to weight project priority scoring. But revenue data is stale (RapidAPI payouts are monthly), incomplete (some providers report daily, others weekly), and fragile (API endpoint changes break data collection). The AI makes priority decisions based on incorrect revenue data, systematically deprioritizing a project that is actually earning well or prioritizing one that has stopped earning.

**Why it happens in THIS system:**

1. **Heterogeneous data sources.** Each revenue source has a different reporting cadence, API format, and reliability:
   - RapidAPI: monthly payouts, no real-time earnings API
   - Bandwidth sharing: each of 9 providers has different dashboards, most without APIs
   - XMR mining: pool API shows pending balance, actual payout is weekly
   - Gumroad: daily sales data but no push notification

2. **No single source of truth.** Revenue data must be scraped, polled, or manually entered. Each source can fail silently -- a scraper stops working and the orchestrator thinks revenue is zero rather than "data unavailable."

3. **Stale data looks like zero revenue.** If the RapidAPI data collector fails, the orchestrator sees "last revenue data: 30 days ago, $0 recent" and deprioritizes `web-scraping-biz` -- even though it might be earning $100/day that is just not being tracked.

4. **Currency of data affects decision quality.** A project earning $5/day consistently is more valuable than one that earned $50 last month but nothing this month. The orchestrator needs temporal awareness that goes beyond "sum of recent earnings."

**Consequences:**
- Orchestrator deprioritizes revenue-generating projects based on stale data
- Priority scoring becomes unreliable, undermining a core v4.0 value proposition
- User sees revenue reports that don't match their bank account, loses trust
- AI makes confident decisions ("crypto-trader is your top earner") that are factually wrong

**Prevention:**

1. **"Data unavailable" is NOT "zero revenue."** Treat missing revenue data as NULL, not as $0. The AI prompt should explicitly distinguish between "this project earned $0" and "we don't have revenue data for this project."

```javascript
// In revenue data structure
{
  project: 'web-scraping-biz',
  revenue: null,           // null = unknown, 0 = confirmed zero
  lastUpdated: '2026-02-10',
  dataAge: '6 days',
  status: 'stale',         // fresh (<24h) | stale (1-7d) | unknown (>7d)
  source: 'rapidapi'
}
```

2. **Revenue data freshness in AI context.** When including revenue data in the AI's context prompt, always include the data age. "web-scraping-biz revenue: $47/week (data 2 days old)" vs. "crypto-trader revenue: unknown (no data in 14 days)."

3. **Manual override capability.** Allow the user to set revenue hints via `priorities.json` or SMS: "web-scraping-biz earns about $200/month." These manual hints are used when automated data is unavailable.

4. **Conservative default.** Until automated revenue tracking is proven reliable (at least 2 weeks of consistent data), do NOT use revenue to weight priority scores. Use the user's manual priority list (`priorities.json`) instead. Revenue intelligence should start as informational (shown in digests) before becoming decisional (affecting priority).

5. **Revenue data validation.** If revenue data shows a sudden change (was $50/week, now $0), flag it as "anomaly" rather than using it directly. Sudden drops are more likely data collection failures than actual revenue drops.

**Which phase should address this:** Revenue intelligence should be one of the LATER phases, after service monitoring and session evaluation are stable. Data collection should be built and validated for at least 2 weeks before being connected to priority scoring.

---

### Pitfall 7: `--dangerously-skip-permissions` in Natural Language Handler Enables Arbitrary Code Execution

**Severity:** HIGH

**What goes wrong:** The current `_handleNaturalLanguage` in commands.js line 643 runs `claude -p --dangerously-skip-permissions` with a 120-second timeout and no `--max-turns` limit. This means any SMS message routed through the natural language handler can trigger Claude Code to read/write arbitrary files, execute shell commands, and make network requests -- all with zero human confirmation. v4.0 adds MORE features that go through this handler (personal assistant queries, revenue questions, health check requests). The attack surface expands with every new natural language capability.

**Why this matters for v4.0 specifically:**

1. **Current risk is contained.** In v3.0, the natural language handler is mostly used for status queries and simple commands. The AI is prompted to respond conversationally, not to take actions. But it CAN take actions because `--dangerously-skip-permissions` is set.

2. **v4.0 expands scope.** When the user asks "restart the bandwidth containers" or "check why mlx-api is slow," the AI has the permissions to actually DO these things through the natural language handler -- not through the audited DecisionExecutor path, but through an unaudited, unlogged `claude -p` call.

3. **No action logging.** Actions taken by the natural language handler are NOT logged in `executionHistory`. They bypass the `DecisionExecutor` entirely. If the AI reads a sensitive file or restarts a service through this path, there is no audit trail.

4. **No `--max-turns` limit.** The natural language handler does not pass `--max-turns`. Claude Code can potentially run for the full 120-second timeout, executing multiple actions in sequence without any human check.

**Consequences:**
- SMS message could trigger unintended file modifications or service restarts
- No audit trail for actions taken through natural language path
- Potential for prompt injection via crafted SMS messages
- Claude Code sessions spawned by natural language could run for 2 minutes doing arbitrary things

**Prevention:**

1. **Add `--max-turns 1` to natural language handler.** This already exists in the think cycle (ai-brain.js line 70) but is missing from the natural language handler (commands.js line 643). Single-turn prevents multi-step action chains.

2. **Remove `--dangerously-skip-permissions` from natural language handler.** The natural language handler should be conversational only. If the user wants to take an action, route it through the DecisionExecutor path which has logging, cooldowns, and autonomy gating.

3. **Split natural language into "read" and "write" paths.** Read queries (status, revenue, health) can use `claude -p` with `--max-turns 1` and restricted prompting. Write actions (restart, deploy, update) must go through DecisionExecutor.

4. **Log all natural language interactions.** Even if no action is taken, log the user message, AI response, and whether any tools were invoked. This creates an audit trail for debugging.

**Which phase should address this:** Phase 1 (foundation hardening). This is a pre-existing risk that becomes more dangerous as v4.0 adds capabilities. Fix it before adding new features.

**Concrete code location:** `lib/commands.js` line 643 (`execSync` call with `--dangerously-skip-permissions`)

---

## Moderate Pitfalls

Mistakes that cause degraded experience, wasted resources, or technical debt. Important but not system-threatening.

---

### Pitfall 8: Personal Assistant Notification Overload -- Too Helpful Becomes Annoying

**Severity:** MODERATE

**What goes wrong:** v4.0 adds personal assistant features: smart briefings, proactive reminders, calendar awareness, financial rollups. The orchestrator now has many MORE reasons to send SMS messages: "Good morning, here's your briefing," "Reminder: you said you'd fix the signing certs today," "Revenue update: bandwidth sharing earned $3.47 yesterday," "3 projects have been stale for a week." Each feature adds 1-3 daily messages. Combined, the orchestrator sends 15-20 messages/day and the user mutes the thread.

**Why it happens in THIS system:**

1. **The existing 20 SMS/day budget (config.json line 61) was sized for v3.0.** v3.0 has one morning digest plus occasional alerts. v4.0 adds 5+ new notification sources, each of which would independently seem reasonable.

2. **Separate features, no shared budget.** The morning digest, health alerts, revenue updates, personal reminders, session evaluations, and proactive suggestions each have their own logic. None of them "knows" how much the others have already sent today.

3. **The NotificationManager already exists but is tier-based, not content-aware.** It tracks daily send count (notification-manager.js line 36) but treats all tier-2 (ACTION) messages as equal. A revenue update and a critical health alert both count the same against the budget.

**Consequences:**
- User mutes the iMessage conversation, losing the human-in-the-loop safety net
- Important alerts (service down, session needs input) get buried in informational messages
- The user texts "shh" and forgets to text "wake," effectively disabling the orchestrator

**Prevention:**

1. **Content-type budgets within the daily budget.** Allocate the 20 SMS/day budget across categories:
   - Critical/urgent: unlimited (bypass budget)
   - Session alerts (needs-input, errors): 5/day
   - Digest/briefing: 1/day
   - Health monitoring: 3/day
   - Revenue/informational: 2/day
   - Reminders: 2/day
   - AI recommendations: 3/day

2. **Consolidate into fewer, richer messages.** Instead of separate messages for revenue, health, and reminders, consolidate into the morning briefing and an optional evening summary. Two rich messages per day beats ten sparse ones.

3. **User-configurable verbosity levels.** Beyond the existing tier system, add verbosity: "minimal" (errors + needs-input only), "normal" (+ digest + health), "verbose" (everything). Default to "normal." Controllable via SMS: "verbosity minimal."

4. **Adaptive sending.** If the user has not responded to any message in 24 hours, reduce to "minimal" automatically. If the user is actively texting, allow "normal." Track user engagement as a signal for notification frequency.

**Which phase should address this:** Before the personal assistant phase. The notification budget must be expanded and category-aware BEFORE adding new notification sources.

---

### Pitfall 9: fs.watch Event Storms on macOS Corrupt State Detection

**Severity:** MODERATE

**What goes wrong:** v4.0 may add event-driven state detection using `fs.watch` or FSEvents to replace or supplement the 60-second polling scan. On macOS, `fs.watch` has well-documented reliability issues: it fires duplicate events, fires on access-time changes (not just content changes), and can miss events entirely under high I/O load. An event storm from a Claude Code session writing files rapidly can generate hundreds of fs.watch events per second, overwhelming the orchestrator's event handler and potentially causing the process to spend all its CPU time processing file events instead of doing useful work.

**Why it happens in THIS system:**

1. **Claude Code sessions write many files.** A session working on a project may modify dozens of files, write `.claude/` conversation files, update `.planning/STATE.md`, and create signal files -- all within seconds. Each file write triggers 1-3 fs.watch events (macOS often fires both `rename` and `change` for a single write).

2. **19 project directories to watch.** Watching all project directories means watching 19 top-level directories plus their subdirectories. On macOS, this can hit the FSEvents watcher limit (~4,099 file descriptors based on Node.js testing), especially if Claude Code sessions also create watchers.

3. **Duplicate events.** Node.js GitHub issue #49916 confirms that `fs.watch` on macOS emits `change` events when access timestamps are updated, not just when file content changes. A `scanner.scanAll()` that reads STATE.md files would itself trigger change events, creating a feedback loop.

4. **No reliable "ready" signal.** Node.js GitHub issue #52601 notes that on macOS, there is no way to know when `fs.watch` has actually started capturing events. Events that occur between watch creation and actual capture start are silently dropped.

**Prevention:**

1. **Stick with polling.** The current 60-second scan interval works. It is predictable, testable, and does not have platform-specific edge cases. Do not replace it with fs.watch for v4.0.

2. **If event-driven is needed, use file hashing.** Instead of trusting fs.watch events, poll files on a timer but use content hashing (MD5 of first 200 bytes) to detect actual changes. Only process files whose hash changed since last scan. This is still polling but avoids re-processing unchanged files.

```javascript
// Content-hash based change detection
const fileHashes = {};
function hasFileChanged(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8').substring(0, 200);
  const hash = crypto.createHash('md5').update(content).digest('hex');
  const changed = fileHashes[filePath] !== hash;
  fileHashes[filePath] = hash;
  return changed;
}
```

3. **If fs.watch is used, debounce aggressively.** Process events in 5-second batches, not individually. Deduplicate by file path within each batch. Set a maximum of 10 events per batch -- if more arrive, just run a full scan instead.

4. **Never watch node_modules or .git directories.** These generate enormous event volumes during npm install or git operations. Use explicit watch paths: only `.planning/STATE.md`, `.orchestrator/*.json`, and specific config files.

**Which phase should address this:** Any phase that considers replacing polling with event-driven detection. Recommendation: do NOT add fs.watch in v4.0. If scan optimization is needed, use content hashing with the existing polling interval.

---

### Pitfall 10: Conversation Persistence Introduces State Size and Privacy Issues

**Severity:** MODERATE

**What goes wrong:** v3.0 has a known issue: conversation history is lost on restart (in-memory only, `commands.js` line 24: `this._conversationHistory = []`). v4.0 fixes this by persisting conversation history. But persisting SMS conversations to disk introduces new problems: the state file grows (each message is 200-1000 bytes, 50 messages/day = 10-50 KB/day), and the conversation history contains user messages that may include sensitive information (credentials, personal details, financial data).

**Why it happens in THIS system:**

1. **User communicates via SMS.** The user might text "my RapidAPI key is abc123" or "the password for X is Y." These messages get stored in conversation history. If the orchestrator's state file or conversation log is included in a git commit or exposed through any means, credentials are leaked.

2. **Conversation history is fed to `claude -p`.** The `_handleNaturalLanguage` method includes recent conversation history in the prompt (commands.js lines 616-617). This means persisted conversations are sent to Claude's API on every natural language request, increasing token usage and potentially exposing old sensitive data in new AI contexts.

3. **The `.state.json` file is not gitignored explicitly.** While it is in the project root (not a tracked file), if the user runs `git add .` they could accidentally commit conversation history containing sensitive data.

**Prevention:**

1. **Separate conversation store from orchestrator state.** Do not put conversation history in `.state.json`. Use a separate file (e.g., `.conversation-history.json`) that is explicitly in `.gitignore`.

2. **TTL on conversation entries.** Automatically prune conversations older than 24 hours. The purpose is multi-turn context, not long-term memory.

3. **Sensitive data filtering.** Before persisting a message, strip patterns that look like credentials: API keys (alphanumeric strings 20+ chars), URLs with passwords, `password`/`secret`/`key` followed by values. Replace with `[REDACTED]`.

4. **Limit history size.** Cap at 20 messages (10 exchanges). The existing in-memory limit is 10 messages (commands.js line 672). Keep this limit when persisting.

5. **Do NOT include old conversation history in AI prompts.** Only include the last 4 messages for context (already the current behavior at commands.js line 616). Persisted history is for session resume, not for enriching every AI call.

**Which phase should address this:** Phase 1 (foundation hardening), as conversation persistence is a known v3.0 issue fix.

---

### Pitfall 11: Test Suite Addition Reveals Breaking Changes in Tightly Coupled Modules

**Severity:** MODERATE

**What goes wrong:** v3.0 has no test suite (known issue). v4.0 adds tests. When you start writing tests for the existing 13 modules, you discover that many modules are tightly coupled (e.g., `DecisionExecutor` directly imports and calls `sessionManager.startSession`, `ContextAssembler` directly reads `priorities.json` from a hardcoded path). Writing unit tests requires either refactoring to support dependency injection or writing integration tests that need real tmux sessions, iMessage access, and file system setup.

**Why it happens in THIS system:**

1. **Constructor dependency injection is already used** (good) -- `AIBrain`, `DecisionExecutor`, and `ContextAssembler` all take `deps` objects. But some modules have hardcoded paths (e.g., `ContextAssembler.prioritiesPath` at line 26 is `path.join(__dirname, '..', 'priorities.json')`).

2. **`execSync` calls throughout.** `ProcessMonitor` calls `ps aux`, `SessionManager` calls `tmux`, `Messenger` calls `osascript`, `AIBrain` calls `claude -p`. Each of these is an implicit external dependency that cannot be mocked without wrapping.

3. **State file location is hardcoded.** `StateManager` defaults to a hardcoded path (`path.join(__dirname, '..', '.state.json')`). Tests that create a `StateManager` will read/write the production state file unless the test explicitly provides an alternative path.

**Prevention:**

1. **Test with the existing dependency injection pattern.** Most modules already accept deps in their constructor. For tests, pass mock objects. Do not refactor the module structure just to add tests.

2. **Wrap `execSync` calls for testability.** Create a thin `lib/exec.js` wrapper that modules use instead of `require('child_process').execSync`. In tests, replace this wrapper with a mock. This is a minimal change that enables testing without restructuring.

3. **Use temporary directories for state.** Tests should create a temp directory, pass it to `StateManager(tempPath)`, and clean up after. Never touch production state files.

4. **Start with integration tests, not unit tests.** Given the tightly coupled architecture, integration tests that exercise the full flow (assemble context -> think -> evaluate -> format SMS) are more valuable than isolated unit tests. Mock only the external boundaries (execSync, file system paths).

5. **Add tests incrementally alongside v4.0 features.** Do not try to achieve 100% coverage of v3.0 code before building v4.0 features. Instead, write tests for each new module as it is built, and add tests for existing modules only when they are being modified.

**Which phase should address this:** Phase 1 (foundation hardening). Test infrastructure should exist before new features are built.

---

## Minor Pitfalls

Mistakes that cause annoyance or minor inefficiency. Fixable but worth knowing about.

---

### Pitfall 12: Process Accumulation from Multiple claude -p Invocations

**Severity:** LOW-MODERATE

**What goes wrong:** v4.0 adds more `claude -p` call sites: session evaluation, health check enrichment, revenue analysis, personal assistant queries -- in addition to the existing think cycle, digest generation, and natural language SMS handler. Each `claude -p` spawns a separate Node.js process (Claude Code CLI). If calls overlap (think cycle running while user sends SMS while a health check is enriching), multiple claude processes run simultaneously. On the 16 GB Mac Mini, each Claude Code process consumes 200-500 MB RAM.

**Why it happens in THIS system:**

1. **No global process limiter.** The `_thinking` mutex in `ai-brain.js` prevents concurrent think cycles, but it does not prevent a think cycle from running concurrently with a natural language SMS handler call, which does not prevent concurrent with a session evaluation call.

2. **The existing `maxConcurrentThinks: 1` (config.json line 56) only applies to the think cycle.** It does not limit total `claude -p` processes.

3. **macOS has significantly slower stdout stream performance for child_process.spawn** (Node.js issue #3429), meaning claude processes may take longer to complete on macOS than expected, increasing overlap window.

**Prevention:**

1. **Global claude -p semaphore.** Create a shared semaphore that limits total concurrent `claude -p` processes to 2 (one for think cycle, one for interactive SMS).

```javascript
class ClaudeSemaphore {
  constructor(maxConcurrent = 2) {
    this._running = 0;
    this._max = maxConcurrent;
    this._queue = [];
  }

  async acquire() {
    if (this._running < this._max) {
      this._running++;
      return;
    }
    return new Promise(resolve => this._queue.push(resolve));
  }

  release() {
    this._running--;
    if (this._queue.length > 0) {
      this._running++;
      this._queue.shift()();
    }
  }
}
```

2. **Priority-based queuing.** SMS responses should preempt background tasks (think cycle, evaluation). If the user sends a message, their response should not wait behind a 30-second think cycle.

3. **Monitor total claude process count.** Add a check to `_checkResources()` in `ai-brain.js`: count running claude processes (`pgrep -c claude`) and refuse to start a new one if count exceeds threshold.

**Which phase should address this:** Phase 1 (foundation), before adding new claude -p call sites.

---

### Pitfall 13: Calendar and Reminders Integration Requires macOS Permissions That May Break

**Severity:** LOW

**What goes wrong:** v4.0 adds Calendar and Reminders integration for the personal assistant layer. On macOS, accessing Calendar and Reminders via AppleScript/JXA requires explicit user permissions (System Settings > Privacy & Security > Automation). These permissions can be reset by macOS updates, and the permission prompt is GUI-only -- it cannot be granted programmatically. If the orchestrator runs via launchd (headless), the permission prompt never appears, and Calendar/Reminders access silently fails.

**Why it matters:**

1. **The orchestrator runs as a launchd service** (com.claude.orchestrator.plist). launchd processes may not be able to display GUI permission prompts.

2. **macOS resets automation permissions after major updates.** After a macOS update, the orchestrator would silently lose Calendar/Reminders access.

3. **This is the same class of issue as the Messages database access.** The existing messenger.js already handles `authorization denied` for chat.db access (index.js lines 286-295). Calendar/Reminders will need the same pattern.

**Prevention:**

1. **Check permissions on boot.** When the orchestrator starts, try a lightweight Calendar/Reminders query. If it fails with authorization error, log a warning and disable those features gracefully -- do not crash.

2. **Grant permissions before installing.** Add a step to `install.sh` that triggers the permission prompt by running a one-time Calendar/Reminders query while the user is at the GUI terminal.

3. **Make personal assistant features independently optional.** If Calendar access fails, the personal assistant still works (minus calendar awareness). If Reminders access fails, it still works (minus reminder creation). Degrade gracefully per capability.

**Which phase should address this:** The phase that adds Calendar/Reminders MCP servers.

---

## Phase-Specific Warnings

Summary of which v4.0 pitfalls each phase must address, ordered by the likely phase structure.

| Phase Topic | Likely Pitfall | Mitigation | Priority |
|---|---|---|---|
| Foundation Hardening | NL handler skip-permissions (#7) | Add --max-turns 1, remove --dangerously-skip-permissions from NL handler | MUST HAVE |
| Foundation Hardening | Process accumulation (#12) | Global claude -p semaphore | MUST HAVE |
| Foundation Hardening | Test infrastructure (#11) | Exec wrapper, temp dirs, integration test framework | MUST HAVE |
| Foundation Hardening | Conversation persistence (#10) | Separate store, TTL, sensitive data filtering | SHOULD HAVE |
| Session Evaluation | False confidence (#3) | Ground truth signals first, LLM judgment second | MUST HAVE |
| External Service Integration | MCP cascade failure (#1) | Circuit breaker, health checks, CLI-based approach | MUST HAVE |
| External Service Integration | Main loop failure modes (#4) | ServiceDataCache, async refresh, zero new dependencies | MUST HAVE |
| Service Health Monitoring | Alert storms (#5) | Correlated failure detection, consecutive threshold, restart budget | MUST HAVE |
| Revenue Intelligence | Wrong numbers (#6) | Null vs zero, data freshness, conservative defaults | SHOULD HAVE |
| Graduated Autonomy | Escalation without rollback (#2) | Staged promotion, auto-demotion, undo registry | MUST HAVE |
| Personal Assistant | Notification overload (#8) | Category budgets, consolidation, verbosity levels | SHOULD HAVE |
| Personal Assistant | macOS permissions (#13) | Boot-time check, graceful degradation | SHOULD HAVE |
| Event-Driven Detection | fs.watch storms (#9) | Stick with polling, use content hashing if optimization needed | RECOMMENDATION |

---

## Cross-Cutting Concerns

These concerns span multiple features and should be addressed as architectural decisions, not per-feature fixes.

### Concern A: Dependency Explosion

v4.0 tempts adding npm packages: `@octokit/rest` (GitHub), `dockerode` (Docker), `ical.js` (Calendar), `node-fetch` (HTTP health checks). Each dependency adds supply chain risk, maintenance burden, and potential breakage.

**Recommendation:** Use CLI tools via `child_process.execFile` for ALL external integrations. `gh` for GitHub, `docker` for Docker, `osascript` for Calendar/Reminders, `curl` for HTTP health checks. The orchestrator's 2-dependency constraint is a feature, not a limitation.

### Concern B: State File Growth

v4.0 adds: conversation history, revenue data cache, health check history, evaluation results, MCP circuit breaker state. All of these want to persist to disk. If all go into `.state.json`, the file grows from ~2 KB to potentially 100+ KB, and every `state.save()` rewrites the entire file.

**Recommendation:** Split state into domain-specific files:
- `.state.json` -- core orchestrator state (ROWID, alerts, autonomy level)
- `.state-ai.json` -- decision history, execution history
- `.state-health.json` -- service health history, circuit breakers
- `.state-revenue.json` -- revenue data cache
- `.conversation-history.json` -- SMS conversation persistence

Each file has its own TTL and size limits.

### Concern C: Total claude -p Process Budget

v3.0 has 2 call sites for `claude -p` (think cycle, natural language SMS). v4.0 potentially adds: session evaluation, health check enrichment, revenue analysis, digest generation (already exists), personal assistant queries. Total could be 7+ call sites. On a 16 GB Mac Mini already running Claude Code sessions, this must be capped.

**Recommendation:** As detailed in Pitfall #12, implement a global semaphore. But also: identify which v4.0 features truly need `claude -p` vs. which can use deterministic logic. Health checks don't need AI. Revenue aggregation doesn't need AI. Only evaluation, prioritization, and natural language responses need LLM reasoning.

---

## Sources

### MCP Specification (HIGH confidence)
- [MCP Lifecycle Specification](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle) -- Timeout handling, shutdown, error codes
- [MCP Error Handling Guide](https://mcpcat.io/guides/error-handling-custom-mcp-servers/) -- Retry patterns, circuit breaker, graceful degradation
- [Claude Code MCP Configuration](https://code.claude.com/docs/en/mcp) -- MCP_TIMEOUT environment variable, settings.json

### Claude Code Issues (HIGH confidence)
- [Claude Code #3033](https://github.com/anthropics/claude-code/issues/3033) -- MCP timeout config ignored in SSE
- [Claude Code #20335](https://github.com/anthropics/claude-code/issues/20335) -- MCP timeout config ignored
- [Claude Code #424](https://github.com/anthropics/claude-code/issues/424) -- MCP timeout not configurable
- [Claude Code #5615](https://github.com/anthropics/claude-code/issues/5615) -- Timeout configuration guide

### GitHub API (HIGH confidence)
- [GitHub REST API Rate Limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) -- 5,000 req/hr PAT, 30 req/min search

### Node.js / macOS (HIGH confidence)
- [Node.js #49916](https://github.com/nodejs/node/issues/49916) -- fs.watch macOS fires on access timestamp
- [Node.js #52601](https://github.com/nodejs/node/issues/52601) -- fs.watch ready signal missing on macOS
- [Node.js #3429](https://github.com/nodejs/node/issues/3429) -- Slow spawn stdout on macOS
- [Watchexec macOS FSEvents Limitations](https://watchexec.github.io/docs/macos-fsevents.html) -- FSEvents design limitations
- [TypeScript #47546](https://github.com/microsoft/TypeScript/issues/47546) -- FSEvents watcher limit ~4,099

### LLM Evaluation (MEDIUM confidence)
- [HoneyHive: Common Pitfalls in LLM Evaluation](https://www.honeyhive.ai/post/avoiding-common-pitfalls-in-llm-evaluation) -- Verbosity bias, position bias
- [Softtech: LLM-as-Judge for Code](https://medium.com/softtechas/utilising-llm-as-a-judge-to-evaluate-llm-generated-code-451e9631c713) -- LLM judges underrate human code
- [EvidentlyAI: LLM-as-Judge Guide](https://www.evidentlyai.com/llm-guide/llm-as-a-judge) -- Bias taxonomy, pair-wise comparison failures

### AI Agent Patterns (MEDIUM confidence)
- [Smashing Magazine: Agentic AI UX Patterns](https://www.smashingmagazine.com/2026/02/designing-agentic-ai-practical-ux-patterns/) -- Autonomy dial, action audit, escalation pathway
- [AI Agent Patterns Reference](https://aiagentpatterns.surge.sh) -- Minimal authority agent, self-correcting agent
- [OWASP AI Agent Security Top 10 2026](https://medium.com/@oracle_43885/owasps-ai-agent-security-top-10-agent-security-risks-2026-fc5c435e86eb) -- Security risk taxonomy

### Alert Fatigue (MEDIUM confidence)
- [Datadog: Prevent Alert Fatigue](https://www.datadoghq.com/blog/best-practices-to-prevent-alert-fatigue/) -- Dynamic thresholds, deduplication
- [IBM: Alert Fatigue](https://www.ibm.com/think/topics/alert-fatigue) -- Cascading effects, notification overload
- [Docker: Restart Policies](https://docs.docker.com/engine/containers/start-containers-automatically/) -- Exponential backoff, restart loop prevention

### Codebase Analysis (HIGH confidence)
- `/Users/claude/projects/infra/project-orchestrator/lib/ai-brain.js` -- execSync call, 30s timeout, think mutex
- `/Users/claude/projects/infra/project-orchestrator/lib/commands.js` -- NL handler with --dangerously-skip-permissions, no --max-turns
- `/Users/claude/projects/infra/project-orchestrator/lib/decision-executor.js` -- Autonomy matrix, no rollback
- `/Users/claude/projects/infra/project-orchestrator/lib/session-manager.js` -- execSync tmux calls, 8s startup wait
- `/Users/claude/projects/infra/project-orchestrator/lib/notification-manager.js` -- Tier-based, 20/day budget
- `/Users/claude/projects/infra/project-orchestrator/lib/state.js` -- Single .state.json, no state splitting
- `/Users/claude/projects/infra/project-orchestrator/config.json` -- 19 projects, 5 max sessions, 16 GB RAM constraint
