# Milestones

## v2.0 — Process Manager (Shipped)

**Shipped:** 2026-02

**What was built:**
- Node.js daemon with iMessage/SMS bot interface
- tmux-based Claude Code session management (start/stop/restart)
- Signal protocol (.orchestrator/ files) for session-to-orchestrator communication
- Proactive scanning: STATE.md monitoring, signal file detection, session ended detection
- SMS command routing: status, priority, start/stop/restart, reply, sessions, quiet, pause
- Morning digest (7 AM cron)
- Quiet hours (10 PM - 7 AM)
- Conversation context tracking for natural SMS interaction
- CLAUDE.md injection for managed sessions
- Fuzzy project name matching with Levenshtein distance
- launchd service for auto-start on boot

**Phases:** 1-5 (pre-GSD, not formally tracked)

**Architecture:**
- `index.js` — Main loop (message polling, proactive scanning, digest scheduling)
- `lib/commands.js` — SMS command router with context awareness
- `lib/session-manager.js` — tmux session lifecycle management
- `lib/signal-protocol.js` — File-based session communication + CLAUDE.md injection
- `lib/scanner.js` — Project STATE.md scanner
- `lib/process-monitor.js` — Process health checking
- `lib/messenger.js` — iMessage send/receive via AppleScript JXA
- `lib/digest.js` — Morning digest formatter
- `lib/scheduler.js` — Cron scheduling + quiet hours
- `lib/state.js` — Orchestrator state persistence (.state.json)

**Config:** 18 projects tracked, 5 max concurrent sessions
