# Domain Pitfalls: Adding AI Decision-Making to a Process Manager

**Domain:** LLM-powered orchestrator for autonomous Claude Code session management
**System:** Node.js daemon managing ~18 projects via tmux on Mac Mini
**Researched:** 2026-02-15
**Updated:** 2026-02-16 — Revised for `claude -p` (Max plan). Cost-related pitfalls eliminated.
**Overall confidence:** HIGH (verified against Anthropic official docs, real-world incident reports, and existing codebase analysis)

---

## Critical Pitfalls

Mistakes that cause financial loss, system instability, or total loss of user trust. Address these in the earliest phases or the project fails.

---

### ~~Pitfall 1: API Cost Explosion~~ — ELIMINATED

**Status:** This pitfall is **eliminated** by using `claude -p` with a Max plan ($200/mo flat, unlimited usage). There are no per-token API charges, no daily/monthly billing to track, and no budget caps needed.

The original concern was valid for direct API usage ($6-1,600+/month depending on optimization). With Max plan, incremental cost is $0.

**Remaining consideration:** While cost is eliminated, excessive `claude -p` calls could still waste compute resources on the Mac Mini (each call spawns a process). The 5-minute think interval and change-detection gating are still good practices for efficiency, just not for cost control.

---

### Pitfall 2: Runaway Automation -- AI Starts/Stops Sessions It Should Not

**What goes wrong:** The AI brain decides to start a Claude Code session on a project that is deliberately paused, or stops a session that is mid-operation (e.g., in the middle of a git rebase or database migration). Worse: it decides ALL projects need work and tries to launch 18 sessions simultaneously, crashing the Mac Mini with 18 Claude Code instances each consuming 2-4 GB RAM.

**Why it happens in THIS system:** The current `maxConcurrentSessions` is 5, but that is a soft limit in `startSession()` -- an AI brain could try to circumvent it by stopping "idle" sessions to make room for "higher priority" ones, creating rapid start/stop churn. The AI has no understanding of what a Claude Code session is actually doing inside tmux -- it only sees signal files and session metadata. It might see "no signal file in 10 minutes" and conclude the session is stuck, when actually the session is running a 15-minute test suite.

**Real-world precedent:** Orphaned child processes from killed tmux sessions can consume ~200MB each and accumulate, causing memory exhaustion when sessions are repeatedly restarted. tmux `kill-session` only sends SIGHUP to the foreground process; subagents that fork or reparent escape cleanup. [Source: tmux GitHub issues #1167, gastown #29]

**Consequences:**
- Mac Mini runs out of RAM (16 GB shared across XMR miner, Docker bandwidth containers, income dashboard, AND Claude Code sessions)
- Projects get corrupted mid-operation (killed during git operations, file writes)
- Orphaned node/claude processes accumulate silently

**Warning signs:**
- AI starts a session, it fails or ends quickly, AI starts it again (restart loop)
- Session count approaches or exceeds 5 frequently
- System memory usage climbing over days
- AI making start/stop decisions faster than sessions can actually boot (8-second startup wait in current code)

**Prevention:**
1. **Action allowlist, not natural language:** The AI outputs structured decisions from a fixed set: `{action: "start", project: "X"}`, `{action: "wait"}`, `{action: "notify_human", message: "..."}`. It cannot invent new actions.
2. **Cooldown timers:** Minimum 5 minutes between start/stop actions on the same project. Minimum 2 minutes between any session lifecycle action. Track in state.
3. **Resource awareness:** Before starting a session, check system memory (`os.freemem()`) and refuse if below 2 GB free. Check existing session count. Make both checks mandatory gates, not AI suggestions.
4. **Protected sessions:** Mark sessions as "do not touch" for a configurable period after launch (e.g., 30 minutes). The AI cannot stop a session it just started.
5. **Human confirmation for destructive actions:** Starting a session is fine. Stopping a running session should require human confirmation via SMS (or at minimum, a 5-minute warning: "Will stop X in 5 min unless you reply 'keep'").
6. **Orphan cleanup:** On every scan cycle, check for orphaned `orch-*` tmux sessions that have no corresponding tracking in state. Kill and log them.

**Which phase should address this:** Phase 1 (guardrails framework) and Phase 2 (session lifecycle decisions). The guardrails MUST exist before the AI gets permission to manage sessions.

**Severity:** CRITICAL. Memory exhaustion crashes the Mac Mini, kills all passive income streams, and requires manual SSH intervention.

---

### Pitfall 3: Stale State Decisions -- AI Acts on Outdated Information

**What goes wrong:** The orchestrator reads STATE.md at scan time, feeds it to the AI, and the AI makes a decision. But between the scan and the action, a running Claude Code session has already changed the state. Result: the AI starts a second session for a project that just completed, or prioritizes a project whose blocker was just resolved, or ignores a project that just hit an error.

**Why it happens in THIS system:** The scan interval is 60 seconds. Claude Code sessions write signal files asynchronously. The `proactiveScan()` function reads state, then later the AI would process that state. The window between "read" and "act" can be 30+ seconds. During that window, a Claude Code session running in tmux can: complete work, write a `completed.json` signal, update STATE.md, and exit. The AI never sees any of this because it is reasoning about the stale snapshot.

**Specific race conditions in the existing code:**
- `scanner.scanAll()` reads all STATE.md files synchronously but sessions write them asynchronously
- Signal files (`needs-input.json`, `completed.json`) can appear between scan and AI decision
- `lastScanResults` deduplication means a change that happens during AI reasoning gets suppressed in the next scan
- `sessionManager.getActiveSessions()` checks tmux but a session can end between the check and the AI's action

**Consequences:**
- Duplicate sessions launched for same project (wastes resources, potential file conflicts)
- AI ignores genuine errors because it is still processing the pre-error state
- Flickering decisions: "start X" then immediately "stop X" on next cycle
- User sees contradictory SMS messages 60 seconds apart

**Warning signs:**
- AI decisions that are immediately contradicted by the next scan
- "Session already running" errors in logs
- Duplicate SMS notifications about the same event
- AI reasoning that references project state inconsistent with reality

**Prevention:**
1. **Atomic state snapshot:** Collect ALL state (projects, sessions, signals, memory) into a single snapshot object. Pass the entire snapshot to the AI. Timestamp it. Do not re-read state between snapshot and action execution.
2. **Optimistic locking:** Before executing an AI decision, re-verify the specific preconditions. "AI says start project X" -- before starting, confirm X has no running session AND the STATE.md has not changed since the snapshot.
3. **Decision expiry:** AI decisions are valid for 30 seconds max. If not executed within that window, discard and re-evaluate on the next cycle.
4. **Debounce rapid changes:** If a project's state changed in the last 30 seconds, defer AI reasoning about it until the next cycle. Let the dust settle.
5. **Signal-first architecture:** Instead of periodic scanning + AI reasoning, make the AI event-driven. Only invoke the AI when a signal file appears or STATE.md actually changes (use `fs.watch` or file hashing).

**Which phase should address this:** Phase 2 (decision engine). The state snapshot pattern should be established when the decision loop is built.

**Severity:** HIGH. Leads to wasted resources, contradictory behavior, and eroded trust. Not as immediately catastrophic as cost explosion or memory exhaustion, but degrades the system steadily.

---

### Pitfall 4: Hallucinated Project Understanding -- AI Misreads What a Project Needs

**What goes wrong:** The AI reads a STATE.md that says "Phase: 3 of 5 - API Integration" and "Status: In progress" and concludes the project needs an API session started. But the project is actually blocked on an external dependency (Fiverr W-9 form, Apple signing certificate) that is not in the STATE.md -- it is only in the user's head or in MEMORY.md. The AI confidently launches a session that spins up Claude Code, which then wastes 30 minutes trying to do something impossible.

**Why it happens in THIS system:** The AI only sees what is in the files it is given. The user's MEMORY.md has context like "BLOCKED: Keychain was reset, need to re-create Apple Development cert in Xcode" for democrat-dollar, but this is not in the project's STATE.md. Projects like `web-scraping-biz` show "25 tests passing" but the real next step is "publish Fiverr gig, blocked on W-9" -- a human context the AI cannot infer from code state.

**Hallucination-specific risks:**
- AI invents a project status from partial information ("tests are passing, therefore project is complete")
- AI confuses two similarly-named projects or conflates their states
- AI generates plausible-sounding but wrong reasoning about project dependencies
- AI misinterprets STATE.md formatting (e.g., reading a blocker as a completed item)

**Consequences:**
- Wasted Claude Code sessions (API cost + compute) doing impossible work
- Claude Code sessions that make changes to projects that should be left alone
- AI sends confident SMS summaries that are factually wrong
- User stops trusting AI summaries and disables the feature

**Warning signs:**
- AI launches sessions for projects the user knows are blocked
- AI progress summaries that do not match reality
- Sessions that end within 5 minutes with no useful output
- AI recommends work on projects marked as COMPLETE

**Prevention:**
1. **Explicit blocker field enforcement:** Require STATE.md to have a structured `**Blockers:**` field. If blockers exist, the AI MUST NOT start a session for that project. Hard rule, not a suggestion to the AI.
2. **User-maintained priority overrides:** A simple `priorities.json` file where the user can mark projects as `"blocked"`, `"skip"`, `"focus"`, or `"auto"`. The AI reads this but cannot modify it. This is the human's veto power.
3. **Session outcome tracking:** Track what happened when a session was launched. If a project's sessions consistently end quickly with no meaningful commits, flag it as "AI may be misjudging this project" and stop auto-launching.
4. **Confidence scoring in AI output:** Require the AI to output a confidence score with each decision. If confidence is below threshold, notify human instead of acting.
5. **Compact but complete state representation:** When building the AI's context, include a structured summary that covers: current phase, status, blockers, last activity date, last session outcome, and user overrides. Do not rely on the AI parsing raw markdown correctly.

**Which phase should address this:** Phase 2 (decision engine context building) and Phase 3 (session evaluation). The priority overrides file should exist from Phase 1.

**Severity:** HIGH. Does not crash the system, but burns money on useless sessions and destroys user trust in AI judgment.

---

## Moderate Pitfalls

Mistakes that cause delays, technical debt, or degraded experience. Important but not system-threatening.

---

### Pitfall 5: Token Context Bloat -- Trying to Give the AI "Full Awareness"

**What goes wrong:** The developer (you) tries to give the AI "complete awareness" of all 18 projects by including every STATE.md, every recent git log, every session status, and every signal file in the API context. This creates a 30,000+ token prompt on every call. At Haiku rates, this is $0.03/call; at Sonnet rates, $0.09/call; running every 60 seconds, $130-390/month just for input tokens.

**Why it happens:** It feels necessary. "How can the AI make good decisions without seeing everything?" But the AI does not need to see the full STATE.md for 18 projects to decide that only 2 have changed since last scan. 90% of the context is unchanged between calls.

**Prevention:**
1. **Two-stage reasoning:** Stage 1 (Haiku, cheap): "Here are 18 one-line project summaries. Which need attention?" Stage 2 (Sonnet, for selected projects only): "Here is the full state for projects A and B. What should we do?"
2. **Delta-only context:** Only include projects whose state has changed since last AI call. "Projects unchanged since last decision: [list]. Changed: [full details for changed projects only]."
3. **Prompt caching:** Use Anthropic's prompt caching for the system prompt and stable context. Cache reads cost 10% of input ($0.10/MTok for Haiku). The system prompt, tool definitions, and project list rarely change -- cache them with 1-hour TTL.
4. **Summarized project state:** Pre-compute a compact representation: `{name, phase, status, hasBlockers, lastActivity, daysSinceActivity, isRunning}` -- roughly 50 tokens per project vs 500+ for raw STATE.md.

**Which phase should address this:** Phase 1 (context building). Get the compact representation right before the first API call.

**Severity:** MODERATE. Inflates costs 5-10x unnecessarily. Not catastrophic with budget caps, but wasteful.

---

### Pitfall 6: Structured Output Parsing Failures

**What goes wrong:** The AI is asked to return a JSON decision like `{action: "start", project: "web-scraping-biz", reason: "..."}` but instead returns natural language, malformed JSON, extra commentary around the JSON, or valid JSON with unexpected field names. The orchestrator's JSON.parse() crashes, the decision is lost, and the cycle is wasted.

**Real-world data:** Free-form prompts lead to 15-20% failure rates in structured data tasks -- not because the LLM misunderstood, but because the output is not parseable. Production systems see field renaming, type mismatches, trailing commas, and truncated output. [Source: agenta.ai, decodingai.com]

**Why it happens in THIS system:** Node.js `JSON.parse()` is strict. A single trailing comma, a comment, or an unquoted key crashes it. The AI might "helpfully" add explanatory text before or after the JSON. Under high load or rate limiting, the AI response might be truncated, producing incomplete JSON.

**Prevention:**
1. **Use Anthropic's tool use / function calling:** Instead of asking for raw JSON, define tools with schemas. The API guarantees structured output matching the schema. This is the single most important mitigation.
2. **Fallback parsing:** If raw JSON is used, implement a robust parser: strip markdown code fences, extract JSON from surrounding text, handle trailing commas. Libraries like `json5` parse relaxed JSON.
3. **Validation layer:** Even with tool use, validate the response against expected values. If `action` is not in the allowlist, treat it as a no-op, not a crash.
4. **Safe failure mode:** If parsing fails, log the raw response, skip this cycle, and try again next cycle. Never crash the daemon on a parse error.

**Which phase should address this:** Phase 1 (API integration). Use tool use from day one. Do not start with raw JSON prompting.

**Severity:** MODERATE. Causes skipped cycles and wasted API calls, not system crashes (if handled correctly). But if not handled, crashes the entire daemon.

---

### Pitfall 7: Notification Spam -- AI Over-Communicates via SMS

**What goes wrong:** The AI brain generates insights and wants to share them. Every scan cycle produces an SMS: "Started session for X", "Session X completed", "Evaluating Y", "Decided to skip Z because...". The user gets 50+ texts per day and mutes the conversation entirely, defeating the purpose of SMS integration.

**iMessage-specific risk:** After sending ~200 iMessages/hour for sustained periods, macOS throttles iMessage sending. The throttle resolves after ~24 hours but during that window, ALL messages fail -- including legitimate alerts. [Source: Apple Community forums, ZekeSnider/Jared #65]

**Why it happens in THIS system:** The current system already has a careful alerting pattern with cooldowns (`wasRecentlyAlerted()` with 1-hour default) and quiet hours. But an AI brain that is "thinking" every 60 seconds generates far more events than the current rule-based scanner. The AI might classify every decision as noteworthy.

**Prevention:**
1. **Notification tiers:** URGENT (errors, human decisions needed) -- send immediately. SUMMARY (session completed, progress made) -- batch into hourly or 4-hour digests. DEBUG (AI reasoning, skipped decisions) -- log only, never SMS.
2. **Daily message budget:** Cap at 10-15 SMS per day during non-quiet hours. If budget is exhausted, queue remaining messages for the next morning digest.
3. **AI does not control send:** The AI outputs a `notifications` array with priorities. A separate notification manager decides what actually gets sent based on budgets, cooldowns, and user preferences.
4. **Aggregate similar messages:** "3 sessions completed in the last hour: X, Y, Z" instead of three separate messages.
5. **User-configurable verbosity:** SMS command like "verbose on/off" that controls whether routine decisions get reported or only exceptions.

**Which phase should address this:** Phase 3 (intelligent SMS). But the notification manager pattern should be designed in Phase 1.

**Severity:** MODERATE. Does not crash anything, but if the user mutes the SMS thread, the entire human-in-the-loop safety net disappears.

---

### Pitfall 8: Decision Quality Regression When Model Changes

**What goes wrong:** The orchestrator is tuned and tested with Claude Haiku 4.5. It works well. Anthropic updates Haiku or deprecates it (as they did with Haiku 3.5 and Sonnet 3.7). The new model interprets the system prompt differently, produces different JSON structures, or makes different prioritization choices. The orchestrator breaks silently -- decisions get worse but nothing crashes.

**Real-world precedent:** Anthropic deprecated Claude Sonnet 3.7 and Haiku 3.5. Model behavior can shift between versions. Prompts that work perfectly in testing start failing after a model update. [Source: Anthropic model deprecations page, agenta.ai]

**Prevention:**
1. **Pin model versions:** Use `claude-haiku-4-5-20250710` (or whatever the latest dated version is) not `claude-haiku-latest`. This prevents surprise behavior changes.
2. **Decision logging:** Log every AI decision with the model version, input hash, and output. This creates a dataset for regression testing.
3. **Evaluation suite:** Build a set of 10-20 test scenarios with known-good decisions. Run them against the model periodically (weekly batch job). Alert if decisions diverge.
4. **Model version in state:** Track which model version made each decision. When upgrading, run parallel decisions with old and new model for a week before switching.

**Which phase should address this:** Phase 2 (decision engine). Pin versions from day one. Build eval suite before moving to Phase 3.

**Severity:** MODERATE. Gradual degradation is hard to detect but does not cause immediate failures.

---

## Minor Pitfalls

Mistakes that cause annoyance or minor inefficiency. Fixable but worth knowing about.

---

### Pitfall 9: AI Decision Latency Blocking the Main Loop

**What goes wrong:** The Claude API call takes 2-5 seconds for Haiku, 5-15 seconds for Sonnet/Opus. If the AI decision is made synchronously in the scan loop, it blocks message polling, signal detection, and other time-sensitive operations. The user sends an SMS, and it takes 15+ seconds to get a response because the system is waiting for an AI API call to complete.

**Why it happens in THIS system:** The current `index.js` runs `pollMessages()` and `proactiveScan()` on separate intervals, but they share the Node.js event loop. A long synchronous operation in scan blocks polling. The current code uses `execSync` in session manager which already blocks -- adding a 5-second API call on top makes it worse.

**Prevention:**
1. **Async AI calls:** Never `await` the AI call in the scan loop. Fire it off, and process the result in a callback or a separate handler. Message polling must never be blocked by AI reasoning.
2. **Separate AI decision queue:** AI calls go into a queue. A worker processes them one at a time. The main loop continues scanning and polling independently.
3. **Timeout on API calls:** Set a 10-second timeout on every API request. If it does not return in time, skip this cycle. Use the Anthropic SDK's built-in timeout parameter.
4. **SMS priority:** Message polling should always run unblocked. If the user texts "stop X", that should execute immediately, not wait behind an AI decision about whether to start Y.

**Which phase should address this:** Phase 1 (API integration architecture). The async pattern must be established from the first API call.

**Severity:** LOW-MODERATE. Degraded responsiveness, not a crash. But if SMS commands are delayed by 15 seconds, the user loses confidence in the system's reliability.

---

### ~~Pitfall 10: Anthropic API Rate Limits and 429 Errors~~ — ELIMINATED

**Status:** This pitfall is **eliminated** by using `claude -p` with a Max plan. Claude Code CLI handles its own rate limiting and queuing internally. No API keys, no 429 errors, no rate limit headers to check.

**Remaining consideration:** If too many `claude -p` processes run simultaneously (e.g., 5 active sessions + orchestrator think cycle), there may be resource contention. Mitigation: run only one `claude -p` at a time from the orchestrator, and let the existing session manager handle session concurrency.

---

### Pitfall 11: Log and State File Growth

**What goes wrong:** Decision logging, AI reasoning traces, session output captures, and token usage tracking all write to disk continuously. Over weeks, these files grow to gigabytes. The Mac Mini's disk fills up, or reading large log files for AI context slows down scans.

**Prevention:**
1. **Log rotation:** Rotate logs daily. Keep 7 days of detailed logs, 30 days of summaries.
2. **State file pruning:** The `alertHistory` in `.state.json` grows unbounded. Prune entries older than 7 days.
3. **Decision history cap:** Keep last 100 AI decisions, not all of them. Write older decisions to a monthly archive.
4. **Disk space check:** On each scan, check available disk space. Alert if below 5 GB.

**Which phase should address this:** Phase 2 (decision engine). Set up log rotation when decision logging is built.

**Severity:** LOW. Takes weeks/months to become a problem. Easy to fix retroactively.

---

## Phase-Specific Warnings

Summary of which pitfalls each phase must address, ordered by the likely phase structure.

| Phase Topic | Likely Pitfall | Mitigation | Priority |
|---|---|---|---|
| ~~API Integration (Phase 1)~~ | ~~Cost explosion (#1)~~ | ~~Daily budget, Haiku-first~~ | ~~ELIMINATED (Max plan)~~ |
| CLI Integration (Phase 1) | Structured output parsing (#6) | JSON-in-prompt with robust parser, validation | MUST HAVE |
| CLI Integration (Phase 1) | Main loop blocking (#9) | Async child_process, 30s timeout | MUST HAVE |
| ~~API Integration (Phase 1)~~ | ~~Rate limits (#10)~~ | ~~Separate API key, backoff~~ | ~~ELIMINATED (Max plan)~~ |
| Guardrails Framework (Phase 1) | Runaway automation (#2) | Action allowlist, cooldowns, resource checks | MUST HAVE |
| Decision Engine (Phase 2) | Stale state (#3) | Atomic snapshots, optimistic locking, debounce | MUST HAVE |
| Decision Engine (Phase 2) | Hallucinated understanding (#4) | Priority overrides, confidence scoring, outcome tracking | SHOULD HAVE |
| Decision Engine (Phase 2) | Context bloat (#5) | Compact summaries, delta-only context | SHOULD HAVE |
| Decision Engine (Phase 2) | Model regression (#8) | Pin model flags, decision logging | SHOULD HAVE |
| Intelligent SMS (Phase 2) | Notification spam (#7) | Tier system, daily budget, aggregate messages | MUST HAVE |
| Operations (Ongoing) | Log growth (#11) | Rotation, pruning, disk checks | NICE TO HAVE |

---

## Cost Modeling

Concrete cost estimates for different architectures, based on verified Anthropic pricing.

### Cost Modeling — ELIMINATED

**With Max plan ($200/mo flat, unlimited `claude -p`):**
- All scenarios cost $0 incremental
- No budget caps needed
- No cost tracking needed
- Model selection is about quality, not cost

The original cost modeling (Scenario A: $1,620/mo naive, Scenario B: $8.70/mo optimized) is retained for reference in case the user ever switches away from Max plan, but is not relevant to the current implementation.

---

## Sources

### Anthropic Official (HIGH confidence)
- [Anthropic Pricing](https://platform.claude.com/docs/en/about-claude/pricing) -- verified token prices for all models
- [Anthropic Rate Limits](https://platform.claude.com/docs/en/api/rate-limits) -- tier-specific RPM/ITPM/OTPM limits
- [Building Effective Agents](https://www.anthropic.com/research/building-effective-agents) -- Anthropic's official agent design guidance
- [Claude Code Cost Management](https://code.claude.com/docs/en/costs) -- prompt caching, auto-compaction strategies

### Real-World Incidents (MEDIUM confidence)
- [Claude Code Subagent Cost Explosion](https://www.aicosts.ai/blog/claude-code-subagent-cost-explosion-887k-tokens-minute-crisis) -- 887K tokens/min incident
- [tmux Memory Issues](https://github.com/tmux/tmux/issues/1167) -- memory growth in long-running sessions
- [tmux Orphan Process Cleanup](https://github.com/steveyegge/gastown/issues/29) -- orphaned processes from killed sessions
- [iMessage Rate Limiting](https://github.com/ZekeSnider/Jared/issues/65) -- ~200 msg/hour throttling observation

### Industry Research (MEDIUM confidence)
- [Why Multi-Agent LLM Systems Fail](https://arxiv.org/pdf/2503.13657) -- 50% task completion rate, failure taxonomy
- [AI Agent Guardrails Production Guide 2026](https://authoritypartners.com/insights/ai-agent-guardrails-production-guide-for-2026/) -- defense-in-depth, budget caps
- [Building Production-Ready Guardrails for Agentic AI](https://ssahuupgrad-93226.medium.com/building-production-ready-guardrails-for-agentic-ai-a-defense-in-depth-framework-4ab7151be1fe) -- multiple independent guardrail layers
- [Structured Outputs Guide](https://agenta.ai/blog/the-guide-to-structured-outputs-and-function-calling-with-llms) -- 15-20% failure rate without structured outputs
- [LLM Hallucinations in Production](https://portkey.ai/blog/llm-hallucinations-in-production/) -- mitigation strategies

### Codebase Analysis (HIGH confidence)
- `/Users/claude/projects/project-orchestrator/index.js` -- main loop architecture, timing
- `/Users/claude/projects/project-orchestrator/lib/session-manager.js` -- tmux lifecycle, 8s startup wait
- `/Users/claude/projects/project-orchestrator/lib/scanner.js` -- STATE.md parsing, attention assessment
- `/Users/claude/projects/project-orchestrator/config.json` -- 18 projects, 60s scan, 5 max sessions
