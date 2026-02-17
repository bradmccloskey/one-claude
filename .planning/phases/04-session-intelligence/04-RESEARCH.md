# Phase 04: Session Intelligence - Research

**Researched:** 2026-02-17
**Domain:** Session lifecycle tracking, git progress analysis, LLM-as-judge evaluation, system resource monitoring
**Confidence:** HIGH

## Summary

Phase 04 adds four capabilities to the orchestrator: (1) git progress tracking per project, (2) LLM-as-judge session evaluation, (3) evaluation-informed resume prompts, and (4) system resource data in AI context. All four requirements can be implemented with zero new dependencies using Node.js builtins (`child_process`, `os`, `fs`) and the existing `claudePWithSemaphore` infrastructure from Phase 03.

The technical domain is straightforward: git CLI provides machine-parseable output via `--numstat` and `--format`, tmux `capture-pane -p` extracts session output as text, `os.cpus()` / `os.freemem()` / `os.loadavg()` provide resource data, and `df -k` provides disk usage. The most complex component is SESS-02 (LLM-as-judge evaluation), which requires a structured prompt rubric and a new `--json-schema` call through the existing semaphore-gated `claudePWithSemaphore`.

**Primary recommendation:** Build four new modules (`lib/git-tracker.js`, `lib/session-evaluator.js`, `lib/resource-monitor.js`) plus modifications to existing modules (`context-assembler.js`, `session-manager.js`). Each module is independently testable. The LLM evaluation should combine objective signals (commit count, test pass/fail, diff size) with LLM judgment via a 5-point rubric using `claudePWithSemaphore`.

## Standard Stack

The established libraries/tools for this domain:

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Node.js `child_process` | builtin | Execute git, tmux, df commands | Already used throughout codebase |
| Node.js `os` | builtin | CPU, memory metrics | Already used in ai-brain.js `_checkResources()` |
| Node.js `fs` | builtin | Persist evaluation data | Already used throughout codebase |
| git CLI | 2.x | `--numstat`, `--format`, `rev-list` | Machine-parseable output formats, universal availability |
| tmux 3.6a | installed | `capture-pane -p` for session output | Already used for session management |
| `claudePWithSemaphore` | lib/exec.js | LLM-as-judge evaluation calls | Established Phase 03 pattern with semaphore gating |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `--json-schema` | claude CLI | Structured evaluation output | For the EVALUATION_SCHEMA on LLM judge responses |
| `df -k` | macOS builtin | Disk usage percentage | For SESS-04 resource monitoring |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| git CLI via execSync | simple-git npm package | Violates zero new deps constraint; execSync is fine for synchronous git queries |
| os.loadavg() | systeminformation npm | Violates zero new deps constraint; os module sufficient for load/memory |
| Custom eval rubric | OpenAI Evals framework | Massive overkill; single claude -p call with rubric prompt is sufficient |
| File-based eval storage | SQLite via better-sqlite3 | Could use existing better-sqlite3 dep, but JSON file matches state.js pattern; SQLite is better for Phase 06 when 50+ evaluations need querying |

**Installation:**
```bash
# No new dependencies required
# All functionality uses Node.js builtins + existing deps
```

## Architecture Patterns

### Recommended Project Structure
```
lib/
  git-tracker.js         # NEW: Git progress tracking per project (SESS-01)
  session-evaluator.js   # NEW: LLM-as-judge session quality scoring (SESS-02)
  resource-monitor.js    # NEW: System resource data collection (SESS-04)
  context-assembler.js   # MODIFY: Add git stats + resources + eval data sections
  session-manager.js     # MODIFY: Record session start/end timestamps for eval windows
  state.js               # MODIFY: Add evaluation history storage methods
test/
  git-tracker.test.js    # NEW
  session-evaluator.test.js # NEW
  resource-monitor.test.js  # NEW
```

### Pattern 1: GitTracker - Stateless Git Query Module
**What:** A class that queries git state for any project directory using execSync. Stateless -- does not store data itself. Returns structured objects that callers persist.
**When to use:** Every time the orchestrator needs to know what happened in a project's git repo.
**Example:**
```javascript
// Source: Verified git CLI output on this machine (tmux 3.6a, macOS)
const { execSync } = require('child_process');

class GitTracker {
  /**
   * Get git progress since a given timestamp for a project.
   * @param {string} projectDir - Absolute path to project
   * @param {string} [since] - ISO timestamp or git date string (e.g., "2 hours ago")
   * @returns {{ commitCount, insertions, deletions, filesChanged, lastCommitHash, lastCommitMessage, lastCommitTimestamp, fileList }}
   */
  getProgress(projectDir, since) {
    // Count commits
    const sinceArg = since ? `--since="${since}"` : '';
    const count = parseInt(
      execSync(`git -C "${projectDir}" rev-list --count ${sinceArg} HEAD`,
        { encoding: 'utf-8', timeout: 5000 }).trim()
    , 10) || 0;

    // Aggregate diff stats via --numstat
    const numstat = execSync(
      `git -C "${projectDir}" log --numstat --format='' ${sinceArg}`,
      { encoding: 'utf-8', timeout: 10000 }
    ).trim();

    let insertions = 0, deletions = 0;
    const fileSet = new Set();
    for (const line of numstat.split('\n')) {
      const parts = line.trim().split('\t');
      if (parts.length === 3) {
        const add = parseInt(parts[0], 10) || 0;
        const del = parseInt(parts[1], 10) || 0;
        insertions += add;
        deletions += del;
        fileSet.add(parts[2]);
      }
    }

    // Last commit metadata
    const lastCommit = execSync(
      `git -C "${projectDir}" log --format='%H|%s|%aI' -1`,
      { encoding: 'utf-8', timeout: 5000 }
    ).trim();
    const [hash, message, timestamp] = lastCommit.split('|');

    return {
      commitCount: count,
      insertions,
      deletions,
      filesChanged: fileSet.size,
      fileList: [...fileSet],
      lastCommitHash: hash || null,
      lastCommitMessage: message || null,
      lastCommitTimestamp: timestamp || null,
    };
  }
}
```

### Pattern 2: SessionEvaluator - Hybrid Objective + LLM Scoring
**What:** Combines objective signals (git commits, diff stats, test output detection in tmux) with an LLM-as-judge call for nuanced quality assessment. Returns a structured evaluation with score 1-5 and recommendation.
**When to use:** After a session ends (timeout, completion signal, or manual stop).
**Example:**
```javascript
// Source: LLM-as-judge best practices (confident-ai.com, G-Eval pattern)
const EVALUATION_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    score: { type: 'integer', minimum: 1, maximum: 5 },
    recommendation: {
      type: 'string',
      enum: ['continue', 'retry', 'escalate', 'complete']
    },
    accomplishments: {
      type: 'array',
      items: { type: 'string' }
    },
    failures: {
      type: 'array',
      items: { type: 'string' }
    },
    reasoning: { type: 'string' },
  },
  required: ['score', 'recommendation', 'accomplishments', 'failures', 'reasoning'],
});

// Evaluation prompt rubric (5-point scale with concrete anchors)
const RUBRIC = `
Score 1 (Failed): No commits, no meaningful progress, errors in output
Score 2 (Minimal): Few commits but mostly config/setup, key objectives not addressed
Score 3 (Acceptable): Some commits with real changes, partial progress on objectives
Score 4 (Good): Multiple commits, clear progress on stated objectives, tests passing
Score 5 (Excellent): Completed all objectives, clean commits, tests passing, docs updated
`;
```

### Pattern 3: ResourceMonitor - Lightweight System Metrics
**What:** Collects CPU load, free memory, total memory, and disk usage using Node.js `os` module plus `df -k`. Returns a flat object suitable for embedding in AI context.
**When to use:** Called during context assembly for every think cycle.
**Example:**
```javascript
// Source: Verified on this Mac Mini (Node.js os module + df -k)
const os = require('os');
const { execSync } = require('child_process');

class ResourceMonitor {
  getSnapshot() {
    const loadAvg = os.loadavg(); // [1min, 5min, 15min]
    const cpuCount = os.cpus().length;
    const freeMemMB = Math.round(os.freemem() / 1024 / 1024);
    const totalMemMB = Math.round(os.totalmem() / 1024 / 1024);
    const memUsedPct = Math.round((1 - os.freemem() / os.totalmem()) * 100);

    // Disk usage
    let diskUsedPct = null;
    try {
      const dfOutput = execSync("df -k / | tail -1", { encoding: 'utf-8', timeout: 3000 });
      const parts = dfOutput.trim().split(/\s+/);
      diskUsedPct = parseInt(parts[4], 10) || null; // "1%" -> 1
    } catch {}

    return {
      cpuLoadAvg1m: loadAvg[0],
      cpuLoadAvg5m: loadAvg[1],
      cpuCount,
      freeMemMB,
      totalMemMB,
      memUsedPct,
      diskUsedPct,
      uptimeHours: Math.round(os.uptime() / 3600),
    };
  }

  /**
   * Format for AI context (compact text, not JSON)
   */
  formatForContext(snapshot) {
    return (
      `System: CPU ${snapshot.cpuLoadAvg1m.toFixed(1)}/${snapshot.cpuCount} cores | ` +
      `RAM ${snapshot.freeMemMB}MB free/${snapshot.totalMemMB}MB (${snapshot.memUsedPct}% used) | ` +
      `Disk ${snapshot.diskUsedPct}% used | ` +
      `Uptime ${snapshot.uptimeHours}h`
    );
  }
}
```

### Pattern 4: Session Lifecycle Timestamps for Eval Windows
**What:** The session-manager already writes `session.json` with `startedAt`. On stop/timeout, it should also write `stoppedAt` and `lastCommitBefore` (commit hash at session start). This defines the evaluation window.
**When to use:** Modified session start/stop methods.
**Example:**
```javascript
// In session-manager.js startSession():
// Before starting, capture the current HEAD commit
let headBefore = null;
try {
  headBefore = execSync(`git -C "${projectDir}" rev-parse HEAD`,
    { encoding: 'utf-8', timeout: 3000 }).trim();
} catch {} // Repo may not exist or have no commits

fs.writeFileSync(path.join(signalDir, 'session.json'), JSON.stringify({
  projectName,
  sessionName,
  startedAt: new Date().toISOString(),
  headBefore,  // NEW: commit hash at session start
  prompt: resumePrompt.substring(0, 200),
  status: 'running',
}, null, 2));
```

### Pattern 5: Evaluation Data in Resume Prompts
**What:** When `_buildResumePrompt` constructs the session prompt, it reads the last evaluation from the project's `.orchestrator/evaluation.json` and includes it.
**When to use:** Every session start/restart.
**Example:**
```javascript
// In session-manager.js _buildResumePrompt() or context injection:
const evalFile = path.join(projectDir, '.orchestrator', 'evaluation.json');
if (fs.existsSync(evalFile)) {
  const evalData = JSON.parse(fs.readFileSync(evalFile, 'utf-8'));
  resumeParts.push(
    `Last session scored ${evalData.score}/5 (${evalData.recommendation}).`,
    `Completed: ${(evalData.accomplishments || []).join(', ') || 'Nothing noted'}.`,
    `Failed: ${(evalData.failures || []).join(', ') || 'Nothing noted'}.`,
    `Continue from where the last session left off.`
  );
}
```

### Anti-Patterns to Avoid
- **Polling git in the think cycle:** Do not run git queries every 5 minutes for all 19 projects. Only query git for projects that have/had active sessions. Cache results in `.orchestrator/git-progress.json`.
- **Storing raw tmux output:** The full tmux buffer can be thousands of lines. Capture only the last ~200 lines for evaluation, and summarize key signals (test output, error messages, completion markers).
- **Blocking on LLM evaluation:** The evaluation call uses `claudePWithSemaphore` which is semaphore-gated. Do not evaluate synchronously during session stop -- trigger evaluation asynchronously after the session is stopped.
- **Over-engineered scoring:** Use a simple 5-point integer scale, not 0.0-1.0 floats or 10-point scales. Research shows LLMs are more consistent with coarser scales (3 or 5 points).

## Don't Hand-Roll

Problems that look simple but have existing solutions:

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Git diff parsing | Custom diff parser | `git log --numstat --format=''` | Machine-friendly output, handles renames, binary files correctly |
| Commit counting | Parse git log and count | `git rev-list --count --since=X HEAD` | One command, handles merge commits correctly |
| Memory/CPU metrics | Read /proc/ files | `os.freemem()`, `os.loadavg()`, `os.cpus()` | Cross-platform (though only macOS matters here), no parsing |
| Disk usage | Parse /dev/disk mounts | `df -k / | tail -1` | Standard POSIX, works on macOS |
| JSON schema validation | Manual field checking | `--json-schema` flag on `claudePWithSemaphore` | Already proven in Phase 03; constrained decoding guarantees valid output |
| Concurrent eval protection | Custom locking | Existing `ClaudeSemaphore(2)` | Phase 03 infrastructure, already battle-tested |
| Session window tracking | Complex timestamp logic | `git log --since="ISO-timestamp"` | Git handles timezone conversion, commit ordering |

**Key insight:** Every technical challenge in this phase maps to an existing CLI tool or Node.js builtin. The complexity is in orchestration (when to evaluate, how to store results, how to format for context) not in raw data collection.

## Common Pitfalls

### Pitfall 1: Git Operations on Non-Git Projects
**What goes wrong:** `git -C` throws on directories without `.git/`, crashing the tracker.
**Why it happens:** Not all 19 projects may be git repos (new/empty projects, external tools).
**How to avoid:** Wrap every git operation in try/catch. Return a "no git" sentinel object: `{ commitCount: 0, noGit: true }`. The tracker should never throw.
**Warning signs:** Uncaught exception in session evaluation, orchestrator crash during think cycle.

### Pitfall 2: tmux Buffer Includes ANSI Escape Codes
**What goes wrong:** `tmux capture-pane -p` output includes color/formatting escape sequences that confuse LLM evaluation.
**Why it happens:** Claude Code terminal output includes ANSI colors for syntax highlighting, progress bars, etc.
**How to avoid:** Strip ANSI codes before feeding to evaluator: `output.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')`. Do NOT use the `-e` flag on capture-pane (that preserves escapes).
**Warning signs:** LLM evaluation mentions "garbled text" or escape sequences in reasoning.

### Pitfall 3: Session Evaluation Timing
**What goes wrong:** Evaluation runs before the session has fully stopped, or runs on a session that was already evaluated.
**Why it happens:** There's a race between `stopSession()` and the evaluation trigger. Also, sessions can end naturally (Claude finishes) vs being force-stopped (timeout).
**How to avoid:** Evaluate in `checkSessionTimeouts()` and when processing completion signals. Write `evaluation.json` atomically. Check if evaluation already exists before running.
**Warning signs:** Duplicate evaluations, evaluations with 0 commits on productive sessions.

### Pitfall 4: Context Prompt Too Long
**What goes wrong:** Adding git stats + resource data + evaluation history causes the context prompt to exceed the 8000-char `maxPromptLength` limit.
**Why it happens:** 19 projects x git stats + resource snapshot + evaluation summaries = lots of text.
**How to avoid:** Keep git stats compact (one line per project with stats). Only include eval data for projects with recent sessions (last 24h). Resource snapshot is a single line. The existing truncation logic in `context-assembler.js` will handle overflow, but design sections to be compact from the start.
**Warning signs:** `[Context truncated]` appearing in AI brain logs.

### Pitfall 5: Evaluation Prompt Sends Too Much tmux Output
**What goes wrong:** Sending 500+ lines of tmux output to the evaluator LLM wastes tokens and may confuse the assessment.
**Why it happens:** Long sessions generate lots of terminal output.
**How to avoid:** Capture last 100 lines of tmux output. Look for key signals programmatically first (test results, error messages, completion markers), and send only a summary + the last 50 lines to the LLM. Total evaluation prompt should be under 3000 chars.
**Warning signs:** Evaluation calls timing out (30s limit), high token costs on evaluation.

### Pitfall 6: Stale Session Metadata
**What goes wrong:** `session.json` says "running" but tmux session is gone, or `headBefore` is null because repo had no commits.
**Why it happens:** Sessions can die without the orchestrator knowing (OOM kill, power loss).
**How to avoid:** Always verify tmux session existence before trusting `session.json` status. Handle `headBefore: null` as "no baseline, evaluate absolute state only."
**Warning signs:** Evaluations running on sessions that ended hours ago.

## Code Examples

Verified patterns from official sources and tested on this machine:

### Git Commit Count Since Timestamp
```javascript
// Source: Verified on this machine, git 2.x
// Returns: integer
const count = parseInt(
  execSync(`git -C "${dir}" rev-list --count --since="${isoTimestamp}" HEAD`,
    { encoding: 'utf-8', timeout: 5000 }).trim(),
  10) || 0;
```

### Git Diff Stats (Machine-Parseable)
```javascript
// Source: git-scm.com/docs/git-diff (--numstat documentation)
// Format: "added\tdeleted\tfilename" per line
const numstat = execSync(
  `git -C "${dir}" log --numstat --format='' --since="${since}"`,
  { encoding: 'utf-8', timeout: 10000 }
).trim();

// Parse: aggregate insertions/deletions/files
let add = 0, del = 0;
const files = new Set();
for (const line of numstat.split('\n')) {
  const [a, d, f] = line.trim().split('\t');
  if (f) { add += parseInt(a, 10) || 0; del += parseInt(d, 10) || 0; files.add(f); }
}
```

### Last Commit Metadata
```javascript
// Source: git-scm.com/docs/git-log (--format documentation)
// Pipe-delimited: hash|subject|authorDateISO
const raw = execSync(
  `git -C "${dir}" log --format='%H|%s|%aI' -1`,
  { encoding: 'utf-8', timeout: 5000 }
).trim();
const [hash, subject, dateISO] = raw.split('|');
```

### tmux Session Output Capture
```javascript
// Source: tmux 3.6a man page, verified on this machine
// -p: output to stdout
// -S -200: start from 200 lines back in scrollback
// -J: join wrapped lines
const sessionName = `orch-${projectShortName}`;
let output = '';
try {
  output = execSync(
    `tmux capture-pane -t "${sessionName}" -p -S -200 -J`,
    { encoding: 'utf-8', timeout: 5000 }
  );
  // Strip ANSI escape codes
  output = output.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
} catch {
  output = ''; // Session may already be gone
}
```

### System Resource Snapshot
```javascript
// Source: Node.js os module docs, verified on this Mac Mini
const os = require('os');
const { execSync } = require('child_process');

const snapshot = {
  cpuLoadAvg1m: os.loadavg()[0],          // e.g., 9.06 on this machine
  cpuLoadAvg5m: os.loadavg()[1],          // e.g., 8.88
  cpuCount: os.cpus().length,              // 12 on this Mac Mini
  freeMemMB: Math.round(os.freemem() / 1024 / 1024),  // e.g., 1544
  totalMemMB: Math.round(os.totalmem() / 1024 / 1024), // 49152 (48GB)
  memUsedPct: Math.round((1 - os.freemem() / os.totalmem()) * 100),
  diskUsedPct: parseInt(
    execSync("df -k / | tail -1", { encoding: 'utf-8', timeout: 3000 })
      .trim().split(/\s+/)[4], 10) || null,  // e.g., 1
  uptimeHours: Math.round(os.uptime() / 3600),
};
```

### LLM-as-Judge Evaluation Prompt Structure
```javascript
// Source: G-Eval pattern (confident-ai.com, LLM-as-judge research 2025)
// Uses chain-of-thought + concrete rubric anchors + structured output
const evalPrompt = [
  'You are evaluating the quality of an automated coding session.',
  'Analyze the objective evidence and terminal output, then score the session.',
  '',
  'RUBRIC:',
  'Score 1 (Failed): No commits, no meaningful changes, or only errors in output.',
  'Score 2 (Minimal): Some activity but key objectives not addressed. Mostly setup/config.',
  'Score 3 (Acceptable): Partial progress. Some real code changes toward objectives.',
  'Score 4 (Good): Clear progress on objectives. Multiple meaningful commits. Tests pass.',
  'Score 5 (Excellent): All stated objectives completed. Clean commits, tests pass, docs updated.',
  '',
  'OBJECTIVE EVIDENCE:',
  `- Commits since session start: ${gitProgress.commitCount}`,
  `- Files changed: ${gitProgress.filesChanged}`,
  `- Lines added: ${gitProgress.insertions}, Lines removed: ${gitProgress.deletions}`,
  `- Last commit: "${gitProgress.lastCommitMessage}"`,
  `- Session duration: ${durationMin} minutes`,
  '',
  'SESSION PROMPT (what was asked):',
  sessionPrompt.substring(0, 500),
  '',
  'TERMINAL OUTPUT (last 50 lines):',
  tmuxOutput.substring(0, 2000),
  '',
  'Think step by step: What did this session accomplish relative to its objectives?',
  'Then provide your evaluation.',
].join('\n');
```

### Evaluation Storage Format
```javascript
// Written to .orchestrator/evaluation.json per project
const evaluation = {
  sessionId: sessionName,           // e.g., "orch-web-scraping-biz"
  projectName: 'revenue/web-scraping-biz',
  startedAt: '2026-02-17T10:00:00Z',
  stoppedAt: '2026-02-17T10:45:00Z',
  durationMinutes: 45,
  gitProgress: {
    commitCount: 5,
    insertions: 342,
    deletions: 28,
    filesChanged: 12,
    lastCommitMessage: 'feat: add retry logic to scraper',
  },
  score: 4,                         // 1-5 LLM judge score
  recommendation: 'continue',       // continue/retry/escalate/complete
  accomplishments: ['Added retry logic', 'Fixed selector bug'],
  failures: [],
  reasoning: 'Session made 5 commits with substantial code changes...',
  evaluatedAt: '2026-02-17T10:46:00Z',
};
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| No session tracking | Git + tmux + LLM evaluation | Phase 04 (new) | Closes the feedback loop |
| Generic resume prompts | Evaluation-informed prompts | Phase 04 (new) | Sessions know previous context |
| Memory check only | Full resource snapshot | Phase 04 (expands ai-brain.js) | AI can reason about load, disk, memory |
| tmux capture last 5 lines | Structured capture + ANSI strip | Phase 04 (improves index.js timeout handler) | Better session end detection |

**Deprecated/outdated:**
- `--stat` for programmatic parsing: Use `--numstat` instead (tab-delimited, no graph characters)
- `os.cpus()` for CPU usage percentage: loadavg is more useful for "is the system overloaded" decisions
- Manual JSON parsing of claude output: Use `--json-schema` with `EVALUATION_SCHEMA` (Phase 03 pattern)

## Integration Points

### Where New Code Hooks Into Existing Code

| New Module | Integrates With | How | Hookpoint |
|------------|----------------|-----|-----------|
| `git-tracker.js` | `context-assembler.js` | Called during `assemble()` to add git stats section | New section between projects and history |
| `git-tracker.js` | `session-evaluator.js` | Provides git progress data for evaluation | Called at evaluation time with session window |
| `session-evaluator.js` | `index.js` | Triggered in `checkSessionTimeouts()` and signal scan | After `stopSession()` call, before notification |
| `session-evaluator.js` | `lib/exec.js` | Uses `claudePWithSemaphore` for LLM judge call | Same semaphore as think cycle |
| `resource-monitor.js` | `context-assembler.js` | Called during `assemble()` to add resource line | New section after time section |
| Evaluation data | `session-manager.js` | `_buildResumePrompt()` reads `.orchestrator/evaluation.json` | Existing prompt builder, new data source |
| Session timestamps | `session-manager.js` | `startSession()` records `headBefore`, `stopSession()` records `stoppedAt` | Existing methods, add fields |
| Evaluation history | `state.js` | New methods: `logEvaluation()`, `getRecentEvaluations()` | Same pattern as `logDecision()` |

### Dependency Injection Pattern
All new modules should follow the existing DI pattern used by `AIBrain`, `ContextAssembler`, etc.:
```javascript
class SessionEvaluator {
  constructor({ gitTracker, sessionManager, state, config }) {
    this.gitTracker = gitTracker;
    this.sessionManager = sessionManager;
    this.state = state;
    this.config = config;
  }
}
```

This enables the same test mocking pattern from `test/helpers.js` (`createMockDeps`).

## Data Flow

### Session Evaluation Flow
```
Session ends (timeout/signal/manual)
  |
  v
Capture tmux output (last 200 lines, strip ANSI)
  |
  v
Read session.json (startedAt, headBefore, prompt)
  |
  v
Run GitTracker.getProgress(projectDir, since=startedAt)
  |
  v
Build evaluation prompt (rubric + git stats + tmux output)
  |
  v
claudePWithSemaphore(prompt, { jsonSchema: EVALUATION_SCHEMA })
  |
  v
Write .orchestrator/evaluation.json
  |
  v
Log to state (evaluationHistory)
  |
  v
Notify user if score <= 2 (escalation)
```

### Context Assembly Flow (Modified)
```
assemble()
  |
  +-- _buildPreamble()
  +-- _buildTimeSection()
  +-- _buildResourceSection()     # NEW (SESS-04)
  +-- _buildPrioritiesSection()
  +-- _buildSessionsSection()
  +-- _buildProjectsSection()     # MODIFIED: include git stats inline
  +-- _buildEvaluationSection()   # NEW: recent eval summaries (SESS-01/02)
  +-- _buildHistorySection()
  +-- _buildResponseFormat()
```

## Open Questions

Things that couldn't be fully resolved:

1. **Evaluation timing for naturally-ending sessions**
   - What we know: Sessions launched via tmux can end on their own (Claude completes work, writes completed.json). The orchestrator detects this via `session.ended` check in the scan loop.
   - What's unclear: The tmux session may already be destroyed by the time the orchestrator runs its next scan (60s interval). Can we still `capture-pane` on a dead session?
   - Recommendation: Capture tmux output BEFORE checking if the session ended. If session is gone, use the last captured output. Consider capturing output periodically (every scan) and caching it.

2. **Evaluation of sessions without git repos**
   - What we know: Some projects may not have git initialized. GitTracker will return `{ noGit: true }`.
   - What's unclear: How should the LLM judge score sessions with no git data? Only tmux output is available.
   - Recommendation: Rubric should handle this case: "If no git data available, evaluate based on terminal output only. Score based on visible progress and absence of errors."

3. **Evaluation storage: file vs state.js vs SQLite**
   - What we know: Phase 06 (REV-02 trust metrics) needs to query 50+ evaluations for trends. State.js caps arrays at 50-100 entries.
   - What's unclear: Should we store evaluations in SQLite now (better-sqlite3 is already a dep) or use JSON files and migrate later?
   - Recommendation: Store per-project evaluation in `.orchestrator/evaluation.json` (latest only, for resume prompts) AND append to state.js `evaluationHistory[]` (capped at 100, for AI context). Phase 06 can migrate to SQLite when it needs trend queries.

## Sources

### Primary (HIGH confidence)
- Node.js `os` module -- verified on this Mac Mini: `os.loadavg()` returns `[9.06, 8.88, 9.11]`, `os.cpus().length` returns 12, `os.freemem()` returns ~1.5GB, `os.totalmem()` returns ~48GB
- Git CLI `--numstat` format -- verified: `git log --numstat --format=''` produces tab-delimited `added\tdeleted\tfilename` lines
- Git CLI `--format` placeholders -- verified: `%H|%s|%aI` produces `hash|subject|ISO-date`
- Git CLI `rev-list --count --since` -- verified: returns integer commit count
- tmux 3.6a `capture-pane` -- verified from man page: `-p` (stdout), `-S -N` (scrollback), `-J` (join wrapped), no `-e` (exclude escapes)
- `df -k /` output format -- verified: 5th field is usage percentage with `%` suffix
- Existing codebase: `lib/exec.js`, `lib/ai-brain.js`, `lib/context-assembler.js`, `lib/session-manager.js`, `lib/state.js`, `test/helpers.js` -- all read and analyzed

### Secondary (MEDIUM confidence)
- LLM-as-judge rubric design: G-Eval pattern, 5-point scale with concrete anchors, chain-of-thought reasoning -- from confident-ai.com and multiple research papers (2025)
- ANSI escape stripping regex: `\x1B\[[0-9;]*[a-zA-Z]` -- standard pattern, covers common sequences but not all edge cases (e.g., OSC sequences)

### Tertiary (LOW confidence)
- None. All findings verified against actual system state or official documentation.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - All tools are Node.js builtins or already-installed CLIs, verified on this machine
- Architecture: HIGH - Follows established patterns from phases 01-03 (DI, semaphore, json-schema, state persistence)
- Pitfalls: HIGH - Derived from actual codebase analysis (e.g., ANSI in tmux output, session lifecycle race conditions)
- Code examples: HIGH - All git/tmux/os commands verified on this Mac Mini with actual output

**Research date:** 2026-02-17
**Valid until:** 2026-03-17 (30 days - stable domain, no fast-moving dependencies)
