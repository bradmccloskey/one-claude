# Project Orchestrator

## Core Value

ONE Claude to rule all the Claudes — a central AI brain that autonomously manages, prioritizes, and coordinates all Claude Code sessions across ~18 projects on a Mac Mini.

## Current State (v2.0)

The orchestrator is a **process manager** — it can start/stop/restart Claude Code sessions, detect signal files, and relay SMS commands. But it has **no intelligence**. It doesn't decide what to work on, evaluate progress, or make autonomous decisions. The human is still the brain.

**What works:**
- iMessage/SMS bot reads commands, routes to handlers
- tmux session management (start/stop/restart Claude Code instances)
- Signal protocol: sessions write needs-input.json, completed.json, error.json
- Proactive scanning: STATE.md changes, signal files, session ended
- Morning digest, quiet hours, pause/unpause per project
- Conversation context tracking for natural text interaction
- launchd auto-start on boot

**What's missing:**
- No AI decision-making (Anthropic API not integrated)
- No autonomous prioritization (doesn't decide what to work on)
- No session output evaluation (can't judge if work is good)
- No cross-project awareness (doesn't prevent conflicts)
- No revenue/impact-based ranking
- No proactive session launching (waits for user "start" command)

## Current Milestone: v3.0 — AI-Powered Orchestrator

**Goal:** Transform the process manager into an intelligent orchestrator with Claude as the central brain, capable of autonomous decision-making about what to work on, evaluating session progress, and only involving the human for real decisions.

**Target features:**
- Claude CLI integration via `claude -p` (zero cost with Max plan, zero dependencies)
- Autonomous work prioritization based on project state, revenue impact, deadlines
- Session output evaluation and progress judgment
- Proactive session launching (doesn't wait for user command)
- Cross-project awareness to prevent conflicts and optimize throughput
- Intelligent SMS — sends summaries and decisions, not raw data
- Human-in-the-loop only for genuine decisions, not routine approvals

## Tech Stack

- **Runtime:** Node.js (existing)
- **LLM:** `claude -p` via child_process (new — zero dependencies, covered by Max plan)
- **Messaging:** macOS iMessage via AppleScript JXA (existing)
- **Sessions:** tmux + Claude Code CLI (existing)
- **State:** File-based JSON + .planning/ STATE.md (existing)
- **Service:** launchd plist (existing)

## Validated Requirements (v2.0)

- [x] SMS command interface with natural language routing
- [x] tmux session lifecycle management
- [x] Signal protocol for session communication
- [x] Proactive STATE.md and signal scanning
- [x] Morning digest and quiet hours
- [x] Conversation context for multi-turn SMS
- [x] CLAUDE.md injection for managed sessions
- [x] launchd auto-start service

---

*Last updated: 2026-02-16*
