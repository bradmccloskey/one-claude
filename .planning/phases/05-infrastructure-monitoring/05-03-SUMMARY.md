---
phase: 05-infrastructure-monitoring
plan: 03
subsystem: mcp-integration
tags: [mcp, circuit-breaker, claude-p, allowed-tools, external-integrations]
completed: 2026-02-17
duration: ~2m
dependency_graph:
  requires: [05-01]
  provides: [mcp-bridge-module, circuit-breaker, mcp-context-awareness]
  affects: [06-01, 06-02, 07-01]
tech_stack:
  added: []
  patterns: [circuit-breaker, semaphore-gated-mcp, tool-prefix-routing]
key_files:
  created: [lib/mcp-bridge.js]
  modified: [lib/context-assembler.js]
decisions:
  - id: 05-03-01
    description: "Circuit breaker per MCP server name, not per tool"
    rationale: "Server-level granularity matches failure patterns (entire server goes down, not individual tools)"
  - id: 05-03-02
    description: "queryMCP checks breakers BEFORE acquiring semaphore"
    rationale: "Avoid wasting semaphore slots on calls that will be rejected"
  - id: 05-03-03
    description: "Unknown servers assumed available (no breaker created)"
    rationale: "Forward compatible - new MCP servers work without code changes"
metrics:
  tasks_completed: 2
  tasks_total: 2
  deviations: 0
---

# Phase 05 Plan 03: MCP Bridge with Circuit Breaker Summary

MCP bridge module enables claude -p --allowedTools calls to 6 known MCP servers (github, docker-mcp, google-calendar, apple-mcp, memory, filesystem) with per-server circuit breaker protection that opens after 3 consecutive failures and auto-recovers via half-open probe after 5-minute cooldown.

## Tasks Completed

### Task 1: Create lib/mcp-bridge.js
- **Commit:** 18d9d84
- **Files:** lib/mcp-bridge.js (created)
- CircuitBreaker class: closed/open/half-open state machine with configurable thresholds
- MCPBridge class: queryMCP() wraps claudePWithSemaphore with --allowedTools
- Pre-check circuit breakers before acquiring semaphore (no wasted slots)
- Server name extraction from MCP tool patterns (mcp__<server>__<tool>)
- formatForContext() shows server availability for AI brain
- getCircuitBreakerStates() returns all breaker states for debugging

### Task 2: Add MCP capability awareness to context-assembler.js
- **Commit:** 2e8ad27
- **Files:** lib/context-assembler.js (modified)
- Added optional mcpBridge dependency to constructor
- MCP capability list appended to response format section
- Includes performance warning (10-30s, semaphore-gated)
- Fully backward compatible (null check, no MCP info when omitted)

## Deviations from Plan

None - plan executed exactly as written.

## Decisions Made

1. **Circuit breaker per server, not per tool** - When a server fails, all its tools fail. Server-level breakers match real failure patterns.
2. **Check breakers before semaphore** - If a circuit is open, reject immediately without consuming a semaphore slot. Prevents resource waste.
3. **Unknown servers pass through** - Servers not in KNOWN_SERVERS are assumed available, enabling forward compatibility.

## Key Implementation Details

- `MCPBridge.queryMCP(prompt, tools, options)` is the primary API
- Tools use naming convention: `mcp__<server>__<toolname>` or `mcp__<server>__*` (glob)
- maxTurns defaults to 3 (minimum for MCP: tool call + result + response)
- timeout defaults to 60000ms (MCP calls are slower than direct claude -p)
- CircuitBreaker thresholds: 3 failures to open, 5-minute cooldown to half-open

## Next Phase Readiness

- MCP bridge is ready for use in Phases 06-07 where GitHub PR checks, Calendar events, Docker log queries, and memory graph operations will be implemented
- No blockers or concerns
