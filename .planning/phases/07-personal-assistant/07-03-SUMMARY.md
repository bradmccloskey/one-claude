---
phase: "07"
plan: "03"
subsystem: "mcp-session-awareness"
tags: ["mcp", "session-manager", "context-assembler", "tools"]
dependency_graph:
  requires: ["07-02"]
  provides: ["mcp-aware-sessions", "mcp-context-in-prompts", "project-specific-mcp-config"]
  affects: ["07-04"]
tech_stack:
  added: []
  patterns: ["optional-mcp-config", "user-scope-mcp-inheritance"]
key_files:
  created: []
  modified:
    - "lib/session-manager.js"
    - "lib/context-assembler.js"
decisions:
  - id: "07-03-01"
    description: "User-scope MCP servers already inherited by managed sessions; no extra config needed"
  - id: "07-03-02"
    description: "--mcp-config flag only added when project-specific MCP servers are needed beyond user scope"
  - id: "07-03-03"
    description: "MCP tool list in resume prompts sourced from MCPBridge.KNOWN_SERVERS static property"
  - id: "07-03-04"
    description: "Session MCP summary is one line after session list, not per-session"
metrics:
  duration: "~1.5m"
  completed: "2026-02-17"
---

# Phase 07 Plan 03: MCP Session Awareness Summary

MCP-aware session launching with optional --mcp-config for project-specific servers, plus AI context awareness that sessions have GitHub, filesystem, Docker, Calendar, Apple, and Memory tool access.

## What Was Done

### Task 1: Add MCP Config Support to session-manager.js
- Updated `startSession()` signature to accept optional third parameter `options = {}`
- When `options.mcpConfig` provided, writes JSON to `.orchestrator/mcp-config.json` and appends `--mcp-config` flag to tmux launch command
- Existing 2-argument callers unaffected (default empty object)
- Updated `_buildResumePrompt()` to include MCP tool awareness context
- Pulls available server list from `MCPBridge.KNOWN_SERVERS` static property
- Format: "You have MCP tool access to: github (GitHub repos, PRs, issues), ..."
- MCP context included in both return paths (STATE.md path and no-state path)
- Wrapped in try/catch -- graceful degradation if mcp-bridge unavailable

### Task 2: Add Session MCP Awareness to ContextAssembler
- Updated `_buildSessionsSection()` to include MCP capability summary when sessions exist
- Single summary line: "Sessions have MCP tool access: GitHub, filesystem, Docker, Calendar, Apple (Reminders/Notes), Memory."
- Only shown when active sessions exist (not when "None running")
- Does not query MCPBridge at runtime (static knowledge, no performance cost)

## Deviations from Plan

None -- plan executed exactly as written.

## Decisions Made

1. **User-scope MCP inheritance** -- User-scope MCP servers (configured in `~/.claude.json`) are already available to all managed sessions automatically; no extra configuration needed
2. **--mcp-config for extensibility** -- The flag is only added when project-specific MCP servers are needed beyond what user-scope provides
3. **MCPBridge.KNOWN_SERVERS as source** -- Resume prompts pull tool descriptions from the static KNOWN_SERVERS array, keeping the list consistent with the rest of the system
4. **One summary line** -- Session MCP capability is a single line after the session list, not repeated per-session (avoids context bloat)

## Verification

- `node -e "require('./lib/session-manager')"` -- loads without error
- `node -e "require('./lib/context-assembler')"` -- loads without error
- `startSession()` accepts 3 arguments without breaking existing callers
- Resume prompts include "MCP tool access" context
- Session section includes MCP capability summary when sessions exist
- No new npm dependencies added

## Next Phase Readiness

- Sessions now aware of MCP tool capabilities
- AI brain knows managed sessions have tool access
- Project-specific MCP config support ready for future use
- Ready for 07-04 (final PA plan)
