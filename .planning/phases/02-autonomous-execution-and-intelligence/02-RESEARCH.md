# Phase 02 Research: Autonomous Execution and Intelligence

**Researched:** 2026-02-16
**Phase goal:** Enable AI to act autonomously -- start/stop sessions, evaluate progress, recover from errors, generate intelligent digests -- with full safety guardrails.
**Prior phase:** Phase 01 (AI Brain Foundation) -- COMPLETE, 17/17 verified

---

## 1. What Exists Today (Phase 1 Foundation)

### 1.1 AI Modules Built

| Module | File | Lines | Key Methods | Phase 2 Extension Point |
|--------|------|-------|-------------|------------------------|
| AIBrain | `lib/ai-brain.js` | 255 | `think()`, `enable()`, `disable()`, `getStatus()`, `parseJSON()` | Think cycle works end-to-end. Needs: autonomy-level-aware execution dispatch after `evaluate()`. |
| ContextAssembler | `lib/context-assembler.js` | 347 | `assemble()`, `getProjectSummary()` | Produces 7-section prompt. Needs: session age/duration data, error history, staleness metrics, signal data for smarter prompts. |
| DecisionExecutor | `lib/decision-executor.js` | 205 | `evaluate()`, `formatForSMS()`, `execute()` (scaffold) | `execute()` is a no-op returning `{executed: false, reason: "observe mode"}`. This is THE primary wiring point for Phase 2. |
| StateManager | `lib/state.js` | 94 | `logDecision()`, `getRecentDecisions()` | Needs: optimistic locking (version field), session tracking, execution history. |
| CommandRouter | `lib/commands.js` | 627 | `route()`, 7 AI commands | Needs: `ai level <level>` set command, notification tier routing. |

### 1.2 Current Think Cycle Flow

```
[Timer fires every 5 min]
    |
    v
aiBrain.think()
    |
    +-- contextAssembler.assemble()         -- gathers all state
    +-- execSync('claude -p ...')           -- 30s timeout
    +-- parseJSON(response)                 -- 3-stage fallback
    +-- state.logDecision(decision)         -- persist to .state.json
    +-- decisionExecutor.evaluate(recs)     -- validate against allowlist/cooldowns/protected
    |
    v
[In index.js think cycle]
    +-- decisionExecutor.formatForSMS()     -- format for human
    +-- messenger.send(sms)                 -- send recommendation SMS
    |
    v
[END -- no execution happens]
```

### 1.3 What the Executor Can Already Do (Validation)

The `evaluate()` method already validates:
- Action is in allowlist: `["start", "stop", "restart", "notify", "skip"]`
- Project is not in `config.ai.protectedProjects`
- Cooldown check: `sameActionMs` (5 min) and `sameProjectMs` (10 min)
- Sets `observeOnly = true` when `autonomyLevel === "observe"`

What it does NOT do:
- Actually call `sessionManager.startSession()` / `stopSession()` / `restartSession()`
- Call `messenger.send()` for notify actions
- Record executed actions to cooldown tracker (`_recordAction()` exists but is never called)
- Check resource limits before start actions
- Verify preconditions (session not already running, project exists, etc.)

### 1.4 Existing v2.0 Capabilities Available to Wire

| Module | Method | What It Does | Notes for Phase 2 |
|--------|--------|-------------|-------------------|
| SessionManager | `startSession(project, prompt?)` | Creates tmux session, launches Claude Code with `--dangerously-skip-permissions`, sends prompt via tmux paste | Returns `{success, message}`. Already checks: dir exists, session not running, concurrent limit. 8-second startup wait. |
| SessionManager | `stopSession(project)` | Sends Ctrl-C, waits 2s, kills tmux session | Updates `session.json` status. |
| SessionManager | `restartSession(project, prompt?)` | stop + start | Sequential. |
| SessionManager | `sendInput(project, input)` | Sends text to running tmux session | For answering needs-input signals. |
| SessionManager | `getActiveSessions()` | Lists all `orch-*` tmux sessions | Returns `[{name, projectName, created}]`. |
| SessionManager | `getSessionStatuses()` | Active sessions + signal file data | Returns session + needsInput/error/completed/lastOutput. |
| Messenger | `send(text)` | Sends iMessage via JXA AppleScript | Auto-chunks at 1500 chars. |
| SignalProtocol | `injectClaudeMd(project)` | Appends orchestrator instructions to project's CLAUDE.md | Must be called BEFORE starting a session. |
| SignalProtocol | `clearSignal(project, type)` | Archives a signal file to history | Called after notification sent. |
| Scanner | `scanAll()` / `scanProject(name)` | Reads STATE.md files | Returns structured status objects. |
| ProcessMonitor | `checkProjects(names)` | Checks which projects have running Claude processes | Independent of tmux -- checks actual processes. |

---

## 2. What Phase 2 Must Build

### 2.1 Decision Executor Wiring (Core Deliverable)

The `execute()` method must be replaced from a no-op to a real executor. Based on the existing `evaluate()` output and the session-manager API:

**Action mapping:**

| AI Action | Executor Method | Pre-checks Needed | Post-action |
|-----------|----------------|-------------------|-------------|
| `start` | `sessionManager.startSession(project, prompt)` | 1. Session not already running 2. Under concurrent limit 3. Memory >= 2GB 4. Not in block list 5. Signal protocol injected | Record cooldown, log execution, notify if `notifyOnMajorActions` |
| `stop` | `sessionManager.stopSession(project)` | 1. Session IS running 2. Not recently started (<30 min, unless error) | Record cooldown, log execution |
| `restart` | `sessionManager.restartSession(project, prompt)` | 1. Session IS running 2. Cooldown passed | Record cooldown, log execution |
| `notify` | `messenger.send(message)` | 1. Not quiet hours 2. Under daily SMS budget | Record notification |
| `skip` | No-op | None | Log skip reason |

**Autonomy level gating:**

| Level | start | stop | restart | notify | skip |
|-------|-------|------|---------|--------|------|
| `observe` | SMS only | SMS only | SMS only | SMS only | log |
| `cautious` | EXECUTE (notify after) | SMS only (needs confirmation) | SMS only | EXECUTE | log |
| `moderate` | EXECUTE | EXECUTE (notify after) | EXECUTE | EXECUTE | log |
| `full` | EXECUTE | EXECUTE | EXECUTE | EXECUTE | log |

**Key finding:** The existing `evaluate()` already marks `observeOnly` based on autonomy level. The new `execute()` should check `evaluatedRecommendation.observeOnly` and branch accordingly. For non-observe levels, the gate matrix above determines what gets auto-executed vs. what gets SMS-only notification.

**SMS command for setting level:** The current `_handleAiLevel()` in commands.js only READS the level. Phase 2 needs `ai level cautious` / `ai level moderate` / `ai level full` to SET it at runtime, persisting to config or state.

### 2.2 Atomic State Snapshots + Optimistic Locking

**Problem identified in PITFALLS.md (Pitfall #3):** Between context assembly and action execution, state can change. AI decides to start project X, but by execution time, X already has a running session (started by user via SMS or by another scan cycle).

**Current vulnerability:** `contextAssembler.assemble()` calls `scanner.scanAll()` and `sessionManager.getActiveSessions()` at the start of the think cycle. By the time `execute()` runs (potentially 2-30 seconds later after the `claude -p` call), the world may have changed.

**Solution design:**

1. **State snapshot object:** Create a `StateSnapshot` that captures ALL mutable state at a single point in time:
   ```
   {
     version: incrementing integer,
     timestamp: ISO string,
     sessions: [...active sessions],
     projectStates: {...per-project data},
     signals: [...pending signals],
     systemMemory: os.freemem(),
     recentHumanCommands: [...last 5 min of SMS commands]
   }
   ```

2. **Optimistic lock check:** Before executing any action, re-verify specific preconditions:
   - For `start`: confirm `!sessionManager._tmuxSessionExists(sessionName)` AND session count < max
   - For `stop`: confirm `sessionManager._tmuxSessionExists(sessionName)`
   - For `restart`: same as stop

3. **Implementation approach:** Rather than building a separate snapshot system, the simplest approach is **re-check at execution time**. The `execute()` method should call `sessionManager.getActiveSessions()` right before acting and validate preconditions. This is a "just-in-time check" pattern, not a full MVCC system.

4. **State version for logging:** Add a monotonically increasing `stateVersion` counter to `.state.json`. Increment on every state mutation. Log the stateVersion with each decision so we can correlate "which state snapshot did the AI see when it made this decision?"

**Key finding:** Full optimistic locking with rollback is over-engineering. Just-in-time precondition checks before each `execute()` call are sufficient given the 5-minute think interval. The window for stale state is the `claude -p` execution time (~2-10 seconds), during which a concurrent SMS command could change things. Just-in-time checks close this window.

### 2.3 Session Prompt Engineering

**Current state:** `SessionManager._buildResumePrompt()` produces generic prompts:
- With STATE.md: "Resume work on this project. Read .planning/STATE.md for where we left off..."
- Without STATE.md: "Read the existing code, README, and any docs..."

**Phase 2 improvement:** The AI brain should craft context-rich prompts for each session it launches. The think cycle already has access to all project context. The AI's recommendation can include a `prompt` field with a targeted instruction.

**Design approach:**

1. **Include prompt in AI recommendation format.** Extend the response schema in `_buildResponseFormat()`:
   ```json
   {
     "project": "web-scraping-biz",
     "action": "start",
     "reason": "Highest revenue project, idle 2 days, has pending Apify actor update",
     "priority": 2,
     "prompt": "Resume work on the Apify actor. The last session completed the scraper fix. Now focus on updating build 1.0.7 with the new selector logic. Check git log for recent changes."
   }
   ```

2. **Prompt construction in the context assembler.** Add a method `getSessionPrompt(projectName, action, reason)` that reads:
   - Latest STATE.md
   - Last completed.json summary (if exists in history)
   - Last error.json (if exists) for retry context
   - priorities.json notes for the project
   - Recent git log (last 3 commits)

3. **Fallback:** If the AI doesn't provide a prompt, fall back to the existing `_buildResumePrompt()`.

**Key finding:** The prompt field should be OPTIONAL in the AI response. The AI is good at crafting prompts when it has context, but should not be required to -- the fallback is already good enough. This is an enhancement, not a gate.

### 2.4 Smart Error Recovery

**Current error handling:** When a session writes `.orchestrator/error.json`, the `proactiveScan()` in index.js detects it, sends an SMS notification, archives the signal, and sets conversation context. The human must then decide what to do (restart, investigate, etc.).

**Phase 2 improvement:** The AI brain should evaluate errors and decide if they're retryable:

**Error classification:**

| Error Type | AI Assessment | Likely Action |
|------------|--------------|---------------|
| Transient (network timeout, rate limit) | Retryable | Restart session with same prompt |
| Dependency missing (npm install fail) | Retryable with fix | Restart with "run npm install first, then..." |
| Permission/auth (API key missing, certs) | Needs human | Notify via SMS, do NOT retry |
| Logic error (test failures, build errors) | Evaluate | Restart with "fix the failing test in..." |
| Unknown/ambiguous | Conservative | Notify human, suggest action |

**Implementation approach:**

1. When the think cycle sees a pending error signal (already available in context from signals scan), the AI includes it in its reasoning context.
2. The AI recommends either `restart` (with a recovery-aware prompt) or `notify` (escalate to human).
3. Add an `errorRecoveryAttempts` counter per project to prevent infinite retry loops. Cap at 3 retries before mandatory human escalation.

**Integration with existing flow:** The `proactiveScan()` in index.js already detects and notifies about error signals. In Phase 2, the AI brain should ALSO see these errors in its context and make a recovery decision. The proactive scan still fires first (60s interval) for immediate notification, and the AI think cycle (5 min) makes the strategic recovery decision.

**Key finding:** Error recovery is really just "AI recommends restart with a smarter prompt." The mechanism is the same as any other start action -- the intelligence is in the prompt crafting and the decision about whether to retry. No new module needed, just smarter context in the think cycle prompt.

### 2.5 Proactive Staleness Detection

**Definition:** A project is "stale" if it:
- Has a STATE.md with active status (not "complete") but no activity for N days
- Has no running session and no recent session completions
- Is not blocked (no blockers listed)
- Is not in the `skip` list

**Current gap:** The scanner reads `lastActivity` from STATE.md but the AI doesn't use this for staleness analysis. The context assembler includes `lastActivity` in the prompt, so the AI could theoretically reason about it, but there's no explicit staleness trigger.

**Implementation approach:**

1. Add a `_detectStaleness()` method to the context assembler or as a utility.
2. Compute staleness: `daysSinceActivity = (now - lastActivityDate) / 86400000`
3. Flag projects as stale if `daysSinceActivity > threshold` (configurable, default 3 days).
4. Include staleness flags in the AI prompt context: `"STALE (5 days idle)"` in the project summary.
5. The AI naturally prioritizes stale projects that have pending work.

**Key finding:** This is almost free to implement. The data is already in the scanner output. Just compute the delta and add it to the context prompt. The AI handles the prioritization logic.

### 2.6 Intelligent Morning Digest

**Current state:** `digest.js` uses a template-based `formatMorningDigest()`:
```
Good morning! Here's your project update:
Needs your attention: [list]
In progress: [list]
Done: [list]
N projects, M active sessions, K need attention
```

**Phase 2 improvement:** Replace the template with an AI-generated narrative via `claude -p`:

**Implementation approach:**

1. Add a `generateDigest()` method to AIBrain (or a new thin module).
2. At digest time (7 AM cron), gather context via `contextAssembler.assemble()` plus:
   - What happened since last digest (session completions, errors, state changes)
   - Any overnight session activity
   - Current priorities
3. Call `claude -p` with a digest-specific prompt: "Summarize overnight activity, highlight what needs attention, suggest today's priorities. Keep it under 1000 chars."
4. Send the AI-generated digest via SMS.
5. Fallback: if `claude -p` fails, use the existing template digest.

**Integration point:** In `index.js`, the `sendDigest()` function calls `digest.formatMorningDigest()`. Phase 2 replaces this call with `aiBrain.generateDigest()` (with template fallback).

**Key finding:** The digest prompt should include the decision history from overnight. This tells the AI what it did while the user was asleep, enabling a genuine "overnight report." The `.state.json` `aiDecisionHistory` already captures this data.

### 2.7 Time Boxing (45-Minute Session Cap)

**Problem:** A Claude Code session could run indefinitely, consuming a tmux slot and system resources. If 5 sessions each run for 2+ hours, no new work can start.

**Current gap:** `session.json` records `startedAt` but nothing checks session duration. `sessionManager.getActiveSessions()` returns `created` timestamp but no duration check.

**Implementation approach:**

1. Add a `_checkSessionTimeouts()` method called during the proactive scan interval (60s).
2. For each active session, compute `duration = now - session.created`.
3. If `duration > maxSessionDurationMs` (configurable, default 45 min / 2700000ms):
   a. Capture last output from tmux (`tmux capture-pane`).
   b. Stop the session.
   c. Write a `timeout.json` signal file (or just a completed.json with timeout flag).
   d. Notify via SMS: "Session X timed out after 45 min. Last output: ..."
4. The AI can then decide whether to restart with a continuation prompt or yield the slot.

**Config addition:**
```json
"ai": {
  "maxSessionDurationMs": 2700000,
  "timeoutAction": "stop"  // or "warn" (SMS warning, 5 more min)
}
```

**Alternative: tmux-level timeout.** Could use `tmux set-option -t session remain-on-exit off` combined with a shell timeout wrapper. But the application-level approach is simpler and gives more control (can capture output before killing).

**Key finding:** Time boxing is critical for autonomous operation. Without it, a stuck session blocks a slot forever. The 45-minute default is based on the observation that most Claude Code sessions complete meaningful work within 20-30 minutes, and sessions running longer are usually stuck or in a loop.

### 2.8 Notification Tier System

**Current state:** All notifications go through `messenger.send()` immediately. No priority levels, no batching, no budgeting.

**Problem from PITFALLS.md (Pitfall #7):** AI-driven orchestration generates far more events than human-driven. Risk of SMS spam (50+ messages/day) or iMessage throttling (~200 msgs/hour).

**Tier design:**

| Tier | Name | Behavior | Examples |
|------|------|----------|---------|
| 1 | URGENT | Send immediately, even during quiet hours override | Session error needing human, security issue, system resource critical |
| 2 | ACTION | Send immediately during non-quiet hours | Needs-input signal, session completed, AI executed an action |
| 3 | SUMMARY | Batch into hourly or 4-hour digest | Session started/stopped by AI, routine completions |
| 4 | DEBUG | Log only, never SMS | AI reasoning, skipped decisions, routine scans |

**Implementation approach:**

1. Create a `NotificationManager` class (or extend Messenger):
   ```
   notify(text, tier)
   - tier 1: messenger.send() immediately
   - tier 2: messenger.send() if !quietHours, else queue for wake
   - tier 3: add to batch queue, flush every 4 hours or with next tier-1/2 message
   - tier 4: console.log() only
   ```

2. **Daily SMS budget:** Cap at 20 SMS/day (configurable). Once budget exhausted:
   - Tier 1: still sends (bypasses budget)
   - Tier 2-3: queued for next morning digest
   - Log a warning when budget is 80% used

3. **Batch format for tier 3:**
   ```
   Batch update (4 items):
   - Started web-scraping-biz (AI decision)
   - crypto-trader completed phase 2
   - youtube-automation session timed out
   - Stopped NetworkProbe (idle)
   ```

**Integration points:**
- `proactiveScan()` in index.js: change `messenger.send()` calls to `notificationManager.notify(text, tier)`
- `decisionExecutor.execute()`: use tier 2 for action confirmations, tier 3 for routine starts/stops
- `aiBrain.think()` result notifications: tier 3 for observe-mode recommendations
- Error signals: tier 1 if error count > 2, tier 2 for first error
- Morning digest: separate from tier system (always sends at scheduled time)

**Key finding:** The notification manager should be a WRAPPER around the existing messenger, not a replacement. Messenger.send() still handles the actual iMessage delivery. NotificationManager handles prioritization, batching, and budgeting.

---

## 3. Configuration Additions

Phase 2 requires extending `config.json`'s `ai` section:

```json
{
  "ai": {
    "enabled": false,
    "model": "sonnet",
    "thinkIntervalMs": 300000,
    "maxPromptLength": 8000,
    "autonomyLevel": "observe",
    "protectedProjects": [],
    "cooldowns": {
      "sameProjectMs": 600000,
      "sameActionMs": 300000
    },
    "resourceLimits": {
      "minFreeMemoryMB": 2048,
      "maxConcurrentThinks": 1
    },
    "maxSessionDurationMs": 2700000,
    "maxErrorRetries": 3,
    "stalenessDays": 3,
    "notifications": {
      "dailyBudget": 20,
      "batchIntervalMs": 14400000,
      "urgentBypassQuiet": true
    }
  }
}
```

New fields: `maxSessionDurationMs`, `maxErrorRetries`, `stalenessDays`, `notifications` subsection.

---

## 4. Risk Analysis for Phase 2

### 4.1 Risks Inherited from Research (PITFALLS.md)

| Pitfall | Severity | Phase 2 Mitigation | Status |
|---------|----------|-------------------|--------|
| #2 Runaway Automation | CRITICAL | Allowlist (DONE in P1), cooldowns (DONE in P1), resource checks (DONE in P1), just-in-time precondition checks (NEW), protected session window (NEW) | Core guardrails exist. Phase 2 adds execution-time checks. |
| #3 Stale State Decisions | HIGH | Just-in-time precondition re-verification before each execute() | Design above is sufficient. |
| #4 Hallucinated Understanding | HIGH | priorities.json (DONE in P1), blocker enforcement (DONE in scanner), error retry cap (NEW) | Mostly mitigated. Error retry cap prevents infinite loops. |
| #7 Notification Spam | MODERATE | Tier system + daily budget + batching (NEW) | Not yet built. Critical for autonomous mode. |
| #8 Model Regression | MODERATE | Decision logging (DONE in P1), model field in decisions | Low risk with `claude -p --model sonnet` pinning. |
| #11 Log Growth | LOW | Decision history capped at 50 (DONE in P1), alertHistory pruning (NEW) | Minor. Add age-based pruning for alertHistory. |

### 4.2 New Risks Specific to Phase 2

| Risk | Severity | Description | Mitigation |
|------|----------|-------------|------------|
| Session startup race | MODERATE | Two think cycles both decide to start the same project. Or AI and human start same project simultaneously. | SessionManager.startSession() already returns `{success: false}` for duplicates. Just-in-time check before execute(). |
| Autonomy level escalation | MODERATE | User sets "full" autonomy too early before observing AI behavior. | Default to "observe". Require explicit SMS command. Log all level changes. Consider requiring N successful observe cycles before allowing escalation. |
| Infinite restart loop | HIGH | AI sees error, restarts, same error, restarts again... | `maxErrorRetries` counter per project. After N retries, force-notify human and stop auto-restarting. |
| Claude -p concurrent execution | LOW | Think cycle `claude -p` + digest `claude -p` + user-triggered `ai think` could overlap. | `_thinking` flag already prevents concurrent think cycles. Digest generation should check this flag too. |
| tmux orphan accumulation | MODERATE | Over weeks, killed sessions leave orphan processes. | Add orphan detection in proactive scan: find `orch-*` tmux sessions not in tracking state. |
| Prompt injection via STATE.md | LOW | A Claude Code session writes malicious content to STATE.md that manipulates the orchestrator's AI brain. | The AI brain's prompt is constructed by the context assembler, which summarizes STATE.md content. The response is validated against the action allowlist. Low risk because the sessions are also Claude instances without adversarial intent. |

### 4.3 Testing Strategy

Phase 1 had ZERO tests. Phase 2 should establish a test foundation for the execution path:

| Test Type | What to Test | Approach |
|-----------|-------------|----------|
| Unit: DecisionExecutor.execute() | Each action type calls correct sessionManager method | Mock sessionManager, verify method calls |
| Unit: Autonomy level gating | Correct actions allowed/blocked per level | Test evaluate() + execute() with different autonomy levels |
| Unit: Just-in-time preconditions | execute() re-checks session state before acting | Mock stale state, verify rejection |
| Unit: Cooldown enforcement | Actions rejected within cooldown window | Fast-forward time, test cooldown behavior |
| Unit: Error retry cap | Retry stops after maxErrorRetries | Count retries, verify escalation |
| Unit: Notification tiers | Correct routing per tier | Mock messenger, verify send/queue behavior |
| Unit: Time boxing | Sessions stopped after max duration | Mock session creation time, verify stop call |
| Integration: Think-to-execute | Full think cycle produces valid execute() calls | Mock claude -p response, verify end-to-end flow |

---

## 5. Dependency Map

```
2.1 Decision Executor Wiring
  |
  +-- 2.2 Atomic State / Just-in-Time Checks (execute needs preconditions)
  |
  +-- 2.3 Session Prompt Engineering (execute needs prompts for start actions)
  |
  +-- 2.8 Notification Tier System (execute needs to notify appropriately)

2.4 Smart Error Recovery
  |
  +-- 2.1 Decision Executor (error recovery IS a restart action)
  |
  +-- 2.3 Session Prompt Engineering (recovery prompts need context)

2.5 Proactive Staleness Detection
  |
  +-- (no code deps, just context assembler enhancement)

2.6 Intelligent Morning Digest
  |
  +-- 2.1 Decision Executor (digest reports on overnight executions)
  |
  +-- (needs claude -p, already available)

2.7 Time Boxing
  |
  +-- 2.1 Decision Executor (time-box stop uses same stop mechanism)
  |
  +-- 2.8 Notification Tier System (timeout notifications)
```

**Recommended build order:**

1. **Notification Tier System** (2.8) -- needed by everything else
2. **Decision Executor Wiring** (2.1) + Just-in-Time Checks (2.2) -- the core deliverable
3. **Session Prompt Engineering** (2.3) -- enhances start actions
4. **Time Boxing** (2.7) -- safety mechanism for autonomous sessions
5. **Smart Error Recovery** (2.4) -- builds on top of executor wiring
6. **Staleness Detection** (2.5) -- context enhancement, low effort
7. **Intelligent Morning Digest** (2.6) -- replaces template, can be last

---

## 6. Interface Contracts

### 6.1 Enhanced AI Response Schema

Current schema (from `_buildResponseFormat()`):
```json
{
  "recommendations": [
    {
      "project": "project-name",
      "action": "start|stop|restart|notify|skip",
      "reason": "why this action",
      "priority": 1-5,
      "message": "SMS text if action is notify"
    }
  ],
  "summary": "One-line overall assessment",
  "nextThinkIn": "suggested seconds until next think cycle"
}
```

Phase 2 additions to recommendation objects:
```json
{
  "project": "web-scraping-biz",
  "action": "start",
  "reason": "Revenue project idle 3 days, has pending Apify update",
  "priority": 2,
  "prompt": "Continue work on Apify actor build 1.0.8. Focus on the selector fix from last session.",
  "confidence": 0.85,
  "notificationTier": 2
}
```

New fields: `prompt` (optional, for start/restart), `confidence` (0-1, for future gating), `notificationTier` (1-4).

### 6.2 Execute Result Schema

```json
{
  "executed": true,
  "action": "start",
  "project": "web-scraping-biz",
  "result": { "success": true, "message": "Started session for web-scraping-biz" },
  "timestamp": "2026-02-16T15:30:00Z",
  "stateVersion": 42,
  "autonomyLevel": "cautious"
}
```

Or on rejection:
```json
{
  "executed": false,
  "action": "start",
  "project": "web-scraping-biz",
  "rejected": "precondition_failed",
  "reason": "Session already running (started 2 min ago by user)",
  "timestamp": "2026-02-16T15:30:00Z"
}
```

### 6.3 SMS Command Extensions

| Command | Action | Notes |
|---------|--------|-------|
| `ai level observe` | Set autonomy to observe | Default, SMS-only recommendations |
| `ai level cautious` | Set autonomy to cautious | AI can start sessions, notifies for stops |
| `ai level moderate` | Set autonomy to moderate | AI can start/stop/restart, notifies on multi-project |
| `ai level full` | Set autonomy to full | Full autonomy, notifies only on errors/human-needed |

---

## 7. Module-Level Change Summary

| File | Changes Needed | Estimated Effort |
|------|---------------|-----------------|
| `lib/decision-executor.js` | Replace `execute()` scaffold with real executor, add precondition checks, autonomy gating, error retry tracking | HIGH |
| `lib/notification-manager.js` | NEW: tier routing, batching, daily budget, wraps messenger | MEDIUM |
| `lib/context-assembler.js` | Add staleness computation, error history, session duration to prompt context | LOW |
| `lib/ai-brain.js` | Add `generateDigest()`, integrate notification manager, pass prompts through to executor | MEDIUM |
| `lib/state.js` | Add stateVersion counter, execution history, error retry counters | LOW |
| `lib/commands.js` | Add `ai level <set>` command, possibly `ai verbose on/off` | LOW |
| `lib/session-manager.js` | No changes needed (executor calls existing methods) | NONE |
| `lib/messenger.js` | No changes needed (notification manager wraps it) | NONE |
| `index.js` | Wire notification manager, add timeout scan to proactive loop, use AI digest | MEDIUM |
| `config.json` | Add Phase 2 config fields | LOW |

---

## 8. Open Questions for Planning

1. **Should autonomy level persist across restarts?** Currently in config.json (file-level), but runtime changes via SMS only affect memory. Options: (a) write to config.json, (b) write to .state.json, (c) separate runtime-settings.json.

   **Recommendation:** Write to `.state.json` (already gitignored, already loaded on startup). Config.json stays as the default, .state.json overrides at runtime.

2. **Should the AI be allowed to set its own think interval?** The `nextThinkIn` field in the response suggests a delay. Should the orchestrator honor this?

   **Recommendation:** Yes, within bounds (min 60s, max 30min). This lets the AI back off during idle periods and speed up during active ones. Store as `_nextThinkOverride` in AIBrain, reset each cycle.

3. **Should there be a "dry run" mode between observe and cautious?** Where the AI shows "I WOULD have executed: start web-scraping-biz" but doesn't.

   **Recommendation:** This IS observe mode. The current observe implementation already formats "what I would do" as SMS. No additional mode needed.

4. **What happens to the existing `proactiveScan()` notifications when AI is in moderate/full mode?** The scan sends notifications about signals -- but the AI might also respond to those signals autonomously.

   **Recommendation:** Keep proactive scan for immediate notification (tier 2). Let AI handle the response decision. If AI restarts a session in response to an error, the notification says "Error in X -- AI restarting with fix" instead of just "Error in X."

5. **Should there be a confirmation step for destructive actions?** e.g., "AI wants to stop crypto-trader. Reply 'ok' within 5 min or it will proceed."

   **Recommendation:** Only for `cautious` level stops. At `moderate` and `full`, the AI acts without confirmation. This is the entire point of the autonomy level system.

---

## 9. Success Criteria Mapping

| Success Criterion (from ROADMAP.md) | Implementation | Verification |
|--------------------------------------|---------------|--------------|
| AI autonomously launches sessions for high-priority work | DecisionExecutor.execute() wired to SessionManager.startSession() | Trigger think cycle with idle slots + high-priority project, verify tmux session created |
| No duplicate sessions or memory exhaustion | Just-in-time precondition checks, resource limit checks | Attempt to start already-running project, verify rejection |
| User can override via priorities.json or SMS | priorities.json block/skip (exists), `ai level` command (new) | Block a project, trigger think, verify AI skips it |
| Morning digest is AI-written and valuable | AIBrain.generateDigest() replaces template | Compare AI digest vs template digest for same state |
| Sessions time-boxed to prevent runaway usage | Timeout scan in proactive loop | Start a session, wait > timeout, verify stop + notification |

---

## 10. Key Architectural Decision: Where Does Execution Live?

**Option A: Execute in DecisionExecutor (recommended)**
- `execute()` method handles all action dispatch
- AIBrain calls `this.decisionExecutor.execute(evaluatedRec)` after evaluate
- DecisionExecutor has sessionManager, messenger, signalProtocol refs (already in constructor)

**Option B: Execute in AIBrain**
- Brain.think() handles execution directly after evaluate
- DecisionExecutor stays validation-only

**Option C: Execute in index.js**
- think() returns evaluated decisions, index.js dispatches

**Recommendation: Option A.** It follows the existing architecture (executor already has all deps injected), keeps AIBrain focused on reasoning, and matches the Phase 1 scaffold design where `execute()` was explicitly left as the Phase 2 wiring point. The DecisionExecutor constructor already receives `sessionManager` and `messenger` -- these were provided anticipating Phase 2.

The flow becomes:
```
aiBrain.think()
  |-- contextAssembler.assemble()
  |-- claude -p
  |-- parseJSON()
  |-- decisionExecutor.evaluate(recs)
  |-- FOR EACH validated rec:
  |     |-- IF autonomyLevel allows execution for this action:
  |     |     decisionExecutor.execute(rec)   <-- NEW
  |     |-- ELSE:
  |     |     notificationManager.notify(formatForSMS(rec), tier)
  |-- state.logDecision(decision)
```

---

*Research complete. This document provides sufficient context and analysis to plan Phase 02 implementation.*
