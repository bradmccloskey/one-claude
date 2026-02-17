# Phase 04 Plan 01: Git Tracker and Resource Monitor

**One-liner:** Stateless GitTracker (commit count, diff stats, last commit metadata via git CLI) and ResourceMonitor (CPU, memory, disk, uptime via Node.js os module) -- two leaf data-collection modules that unblock all Phase 04 downstream plans

## Metadata

- **Phase:** 04-session-intelligence
- **Plan:** 01
- **Completed:** 2026-02-17
- **Duration:** ~3m
- **Tasks:** 2/2

## What Was Built

### lib/git-tracker.js (new file, 111 lines)

Stateless git progress tracking per project directory. Single public method:

**getProgress(projectDir, since)** -- queries git CLI via `execSync` with `git -C`:
- `commitCount`: via `git rev-list --count [--since=X] HEAD`
- `insertions`, `deletions`, `filesChanged`, `fileList`: via `git log --numstat --format=''` with tab-delimited parsing
- `lastCommitHash`, `lastCommitMessage`, `lastCommitTimestamp`: via `git log --format='%H|%s|%aI' -1` with split-on-pipe parsing (handles `|` in commit messages via lastIndexOf)
- `noGit`: false for valid repos, true for non-git directories
- All execSync calls have timeouts (5s default, 10s for numstat)
- Entire method wrapped in try/catch -- never throws

### lib/resource-monitor.js (new file, 70 lines)

System resource data collection with two public methods:

**getSnapshot()** -- returns current system metrics:
- `cpuLoadAvg1m`, `cpuLoadAvg5m`: from `os.loadavg()`
- `cpuCount`: from `os.cpus().length`
- `freeMemMB`, `totalMemMB`, `memUsedPct`: from `os.freemem()` / `os.totalmem()`
- `diskUsedPct`: parsed from `df -k / | tail -1` (try/catch, null on failure)
- `uptimeHours`: from `os.uptime()`

**formatForContext(snapshot)** -- compact single-line format for AI prompt context:
`System: CPU 7.8/12 cores | RAM 1340MB free/49152MB (97% used) | Disk 1% used | Uptime 43h`

## Decisions Made

| Decision | Rationale |
|----------|-----------|
| GitTracker is stateless (no constructor deps) | Pure query module -- callers persist results as needed |
| lastIndexOf for pipe-split in commit parsing | Handles commit messages containing `|` (timestamp is always last) |
| Disk usage null fallback | df command may fail on some systems; null signals unavailability |
| toFixed(1) for CPU load in formatForContext | Balances precision with compactness for AI context |

## Deviations from Plan

None -- plan executed exactly as written.

## Commits

| Hash | Type | Description |
|------|------|-------------|
| f4d75e6 | feat | Create GitTracker for stateless git progress tracking |
| a197553 | feat | Create ResourceMonitor for system metrics collection |

## Verification Results

| Check | Result |
|-------|--------|
| `require('./lib/git-tracker')` loads | PASS |
| `require('./lib/resource-monitor')` loads | PASS |
| GitTracker returns valid data for this repo | PASS -- 58+ commits, insertions, deletions, file list |
| GitTracker returns noGit sentinel for /tmp/not-a-repo | PASS -- { noGit: true, commitCount: 0, ... } |
| GitTracker with --since parameter | PASS -- filtered results returned |
| ResourceMonitor returns numeric values | PASS -- all fields are numbers |
| ResourceMonitor.formatForContext() | PASS -- compact single-line string starting with "System:" |
| No new npm dependencies | PASS -- only Node.js builtins used |

## Key Files

### Created
- `lib/git-tracker.js` -- Stateless git progress tracking per project directory
- `lib/resource-monitor.js` -- System resource data collection

### Modified
- None

## Next Phase Readiness

Plans 04-02 (session evaluator), 04-03 (resume prompts), 04-04 (context enrichment), and 04-05 (resource context) are unblocked. GitTracker feeds into session evaluation (04-02) and context assembly (04-04). ResourceMonitor feeds into context enrichment (04-04/04-05).
