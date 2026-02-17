# Project Orchestrator

## Core Value

ONE Claude to rule all the Claudes — a central AI brain that autonomously manages, prioritizes, and coordinates all Claude Code sessions across ~19 projects on a Mac Mini. The ultimate personal AI agent orchestrator, project manager, and assistant.

## Current Milestone: v4.0 — Autonomous Agent with External Integrations

**Goal:** Transform ONE Claude from an observe-mode project monitor into a truly autonomous agent with session evaluation, external service integrations (GitHub, Docker, Calendar), revenue awareness, service health monitoring, and personal assistant capabilities.

**Target features:**
- Session output evaluation (read tmux output, check git diffs, judge quality)
- Git & GitHub integration (commits, PRs, issues as ground truth)
- MCP server integrations (Docker, Calendar, Reminders, Memory graph)
- Service health monitoring (HTTP pings for running services, auto-recovery)
- Revenue intelligence (track actual earnings, revenue-weighted priorities)
- Graduated autonomy rollout (cautious -> moderate -> full with guardrails)
- Personal assistant layer (smart briefings, proactive reminders, financial rollups)
- Foundation hardening (tests, conversation persistence, dedup fix, priorities)

## Tech Stack

- **Runtime:** Node.js (existing)
- **LLM:** `claude -p` via child_process (zero dependencies, covered by Max plan)
- **Messaging:** macOS iMessage via AppleScript JXA (existing)
- **Sessions:** tmux + Claude Code CLI (existing)
- **State:** File-based JSON + .planning/ STATE.md (existing)
- **Service:** launchd plist (existing)
- **MCP integrations:** GitHub, Docker, Google Calendar, Apple Reminders, Memory (new)

## Validated Requirements (v3.0)

- [x] SMS command interface with natural language routing
- [x] tmux session lifecycle management
- [x] Signal protocol for session communication
- [x] Proactive STATE.md and signal scanning
- [x] Morning digest and quiet hours
- [x] Conversation context for multi-turn SMS
- [x] CLAUDE.md injection for managed sessions
- [x] launchd auto-start service
- [x] AI brain with `claude -p` think cycles (5 min interval)
- [x] Context assembler (project state -> structured prompt)
- [x] Decision executor with action allowlist and cooldowns
- [x] 4 autonomy levels (observe/cautious/moderate/full)
- [x] 4-tier notification system (urgent/action/summary/debug)
- [x] AI-generated morning digest
- [x] Session time boxing (45 min cap)
- [x] Proactive staleness detection
- [x] Smart error recovery with retry counting
- [x] Session prompt engineering
- [x] Natural language SMS (all messages through AI when enabled)
- [x] priorities.json for user overrides

---

*Last updated: 2026-02-16*
