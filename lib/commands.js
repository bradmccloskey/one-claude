/**
 * CommandRouter - Handles incoming SMS commands for the orchestrator.
 * All responses are formatted as clean, natural text messages.
 */
class CommandRouter {
  constructor(deps) {
    this.scanner = deps.scanner;
    this.processMonitor = deps.processMonitor;
    this.digest = deps.digest;
    this.scheduler = deps.scheduler;
    this.sessionManager = deps.sessionManager;
    this.signalProtocol = deps.signalProtocol;
    this.state = deps.state;
    this.projectNames = deps.projectNames;
    this.aiBrain = deps.aiBrain;                 // may be null if AI not configured
    this.decisionExecutor = deps.decisionExecutor;  // may be null
    this.messenger = deps.messenger;              // for async think results
    this._pausedProjects = new Set();
    // Conversation context - tracks the last project referenced
    this._context = { project: null, type: null, timestamp: null };
  }

  /**
   * Set conversation context (called by index.js when sending notifications)
   * @param {string} project - Project name
   * @param {string} type - 'needs-input', 'completed', 'error', 'command'
   */
  setContext(project, type = "command") {
    this._context = { project, type, timestamp: Date.now() };
  }

  /**
   * Get recent context (within maxAge), or null if stale/empty
   */
  _getContext(maxAgeMs = 30 * 60 * 1000) {
    if (!this._context.project) return null;
    if (Date.now() - this._context.timestamp > maxAgeMs) return null;
    return this._context;
  }

  route(text) {
    const trimmed = text.trim();
    const lower = trimmed.toLowerCase();

    // Exact/keyword commands (stateless)
    if (lower === "status") return this._handleStatusAll();
    if (/^status\s+(on\s+)?(all|everything|overview)/.test(lower)) return this._handleStatusAll();
    if (lower.startsWith("status ")) {
      const projectName = lower.slice(7).replace(/^(on|for|of)\s+/, "").trim();
      return this._handleStatusProject(projectName);
    }
    if (lower === "priority" || lower === "pri") return this._handlePriority();
    if (lower.startsWith("start ")) return this._handleStart(trimmed.slice(6).trim());
    if (lower.startsWith("stop ")) return this._handleStop(lower.slice(5).trim());
    if (lower.startsWith("restart ")) return this._handleRestart(lower.slice(8).trim());
    if (lower === "startall") return this._handleStartAll();
    if (lower === "stopall") return this._handleStopAll();
    if (lower === "sessions") return this._handleSessions();
    if (lower.startsWith("reply ")) return this._handleReply(trimmed.slice(6));
    if (lower.startsWith("pause ")) return this._handlePause(lower.slice(6).trim());
    if (lower.startsWith("unpause ") || lower.startsWith("resume ")) {
      return this._handleUnpause(lower.replace(/^(unpause|resume)\s+/, "").trim());
    }
    if (lower === "quiet on" || lower === "shh") return this._handleQuietOn();
    if (lower === "quiet off" || lower === "wake") return this._handleQuietOff();
    if (lower === "help" || lower === "?") return this._handleHelp();
    if (lower === "projects" || lower === "list") return this._handleList();

    // AI commands
    if (lower === "ai on" || lower === "ai enable") return this._handleAiOn();
    if (lower === "ai off" || lower === "ai disable") return this._handleAiOff();
    if (lower === "ai status") return this._handleAiStatus();
    if (lower === "ai think" || lower === "ai go") return this._handleAiThink();
    if (lower === "ai explain" || lower === "ai last") return this._handleAiExplain();
    if (lower === "ai level") return this._handleAiLevel();
    if (lower === "ai" || lower === "ai help") return this._handleAiHelp();

    // Context-aware shortcuts
    if (/^(go|continue|do it|proceed|yes|ok|yep|yeah|sure)$/i.test(lower)) {
      return this._handleGo();
    }
    if (/^stop$/i.test(lower)) return this._handleStopContext();

    // Nothing matched - try contextual interpretation
    return this._handleContextual(trimmed, lower);
  }

  // ── Status ──────────────────────────────────────────────────────────────

  _handleStatusAll() {
    const projects = this.scanner.scanAll();
    const processStatus = this.processMonitor.checkProjects(this.projectNames);
    return this.digest.formatMorningDigest(projects, processStatus);
  }

  _handleStatusProject(name) {
    const match = this._matchProjectName(name);
    if (!match) return `Don't know a project called "${name}". Text "list" to see all projects.`;

    this.setContext(match, "command");
    const project = this.scanner.scanProject(match);
    const processStatus = this.processMonitor.checkProjects([match]);
    return this.digest.formatProjectDetail(project, processStatus[match]);
  }

  _handlePriority() {
    const projects = this.scanner.scanAll();
    const processStatus = this.processMonitor.checkProjects(this.projectNames);
    return this.digest.formatPriority(projects, processStatus);
  }

  // ── Sessions ────────────────────────────────────────────────────────────

  _handleStart(input) {
    // 1. Direct project name match
    const match = this._matchProjectName(input);
    if (match) {
      this.setContext(match, "command");
      this.signalProtocol.injectClaudeMd(match);
      const result = this.sessionManager.startSession(match);
      return result.message;
    }

    // 2. Try to find a project name embedded in the input (e.g., "phase 5 land speculation")
    const embedded = this._findEmbeddedProject(input);
    if (embedded) {
      this.setContext(embedded.project, "command");
      this.signalProtocol.injectClaudeMd(embedded.project);
      const prompt = embedded.instruction
        ? `The user wants you to: ${embedded.instruction}. Check .planning/STATE.md for context and work autonomously.`
        : undefined;
      const result = this.sessionManager.startSession(embedded.project, prompt);
      return result.message;
    }

    // 3. Fall back to conversation context
    const ctx = this._getContext();
    if (ctx) {
      this.setContext(ctx.project, "command");
      this.signalProtocol.injectClaudeMd(ctx.project);
      const prompt = `The user wants you to: ${input}. Check .planning/STATE.md for context and work autonomously.`;
      const result = this.sessionManager.startSession(ctx.project, prompt);
      return `(Using context: ${ctx.project})\n${result.message}`;
    }

    return `Don't know a project called "${input}". Text "list" to see all projects.`;
  }

  _handleStop(name) {
    const match = this._matchProjectName(name);
    if (!match) {
      const ctx = this._getContext();
      if (ctx) {
        this.setContext(ctx.project, "command");
        const result = this.sessionManager.stopSession(ctx.project);
        return `(Using context: ${ctx.project})\n${result.message}`;
      }
      return `Don't know a project called "${name}".`;
    }

    this.setContext(match, "command");
    const result = this.sessionManager.stopSession(match);
    return result.message;
  }

  _handleRestart(name) {
    const match = this._matchProjectName(name);
    if (!match) {
      const ctx = this._getContext();
      if (ctx) {
        this.setContext(ctx.project, "command");
        this.signalProtocol.injectClaudeMd(ctx.project);
        const result = this.sessionManager.restartSession(ctx.project);
        return `(Using context: ${ctx.project})\n${result.message}`;
      }
      return `Don't know a project called "${name}".`;
    }

    this.setContext(match, "command");
    this.signalProtocol.injectClaudeMd(match);
    const result = this.sessionManager.restartSession(match);
    return result.message;
  }

  _handleStartAll() {
    const projects = this.scanner.scanAll();
    const active = projects.filter(
      (p) => p.hasState && p.status && !p.status.toLowerCase().includes("complete")
    );

    if (active.length === 0) {
      return "No active projects to start. All tracked projects are either complete or have no state.";
    }

    const results = [];
    for (const p of active) {
      this.signalProtocol.injectClaudeMd(p.name);
      const r = this.sessionManager.startSession(p.name);
      results.push(`- ${p.name}: ${r.message}`);
    }
    return "Starting all active projects:\n" + results.join("\n");
  }

  _handleStopAll() {
    const sessions = this.sessionManager.getActiveSessions();
    if (sessions.length === 0) return "No sessions running.";

    const results = [];
    for (const s of sessions) {
      const r = this.sessionManager.stopSession(s.projectName);
      results.push(`- ${s.projectName}: ${r.message}`);
    }
    return "Stopping all sessions:\n" + results.join("\n");
  }

  _handleSessions() {
    const sessions = this.sessionManager.getSessionStatuses();

    if (sessions.length === 0) {
      return "No active sessions. Text \"start <project>\" to launch one.";
    }

    const lines = [`${sessions.length} active session${sessions.length > 1 ? "s" : ""}:`];
    for (const s of sessions) {
      let status = "running";
      if (s.ended) status = "ended";
      if (s.needsInput) status = "needs input";
      if (s.error) status = "error";
      if (s.completed) status = "done";

      lines.push(`\n${s.projectName} - ${status}`);
      if (s.needsInput) {
        lines.push(`  "${s.needsInput.question?.substring(0, 80) || "?"}"`);
      }
      if (s.error) {
        lines.push(`  ${s.error.error?.substring(0, 80) || "unknown error"}`);
      }
    }
    return lines.join("\n");
  }

  // ── Reply routing ───────────────────────────────────────────────────────

  _handleReply(input) {
    const colonIdx = input.indexOf(":");
    if (colonIdx === -1) {
      // No colon - check if there's a context project to reply to
      const ctx = this._getContext();
      if (ctx && (ctx.type === "needs-input" || ctx.type === "error")) {
        return this._sendReply(ctx.project, input.trim());
      }
      return "To reply, use: reply <project>: <your message>";
    }

    const projectInput = input.substring(0, colonIdx).trim().toLowerCase();
    const message = input.substring(colonIdx + 1).trim();

    const match = this._matchProjectName(projectInput);
    if (!match) return `Don't know a project called "${projectInput}".`;
    if (!message) return "Empty reply. Use: reply <project>: <your message>";

    return this._sendReply(match, message);
  }

  /**
   * Send a reply to a project's running session
   */
  _sendReply(projectName, message) {
    this.setContext(projectName, "command");
    this.signalProtocol.clearSignal(projectName, "needs-input");
    const result = this.sessionManager.sendInput(projectName, message);

    if (result.success) {
      const preview = message.length > 50 ? message.substring(0, 50) + "..." : message;
      return `Sent to ${projectName}: "${preview}"`;
    }

    // Session not running - restart with the reply as context
    const prompt =
      `The user responded to your question with: "${message}". ` +
      "Continue working with this input. " +
      "Check .planning/STATE.md for current status and .orchestrator/ for previous context.";

    this.signalProtocol.injectClaudeMd(projectName);
    this.sessionManager.startSession(projectName, prompt);
    return `Session wasn't running. Restarted ${projectName} with your input.`;
  }

  // ── Alerts ──────────────────────────────────────────────────────────────

  _handlePause(name) {
    const match = this._matchProjectName(name);
    if (!match) return `Don't know a project called "${name}".`;
    this._pausedProjects.add(match);
    return `Paused alerts for ${match}. Text "unpause ${match}" to resume.`;
  }

  _handleUnpause(name) {
    const match = this._matchProjectName(name);
    if (!match) return `Don't know a project called "${name}".`;
    this._pausedProjects.delete(match);
    return `Resumed alerts for ${match}.`;
  }

  _handleQuietOn() {
    this.scheduler.setQuietOverride(true);
    return "Quiet mode on. No alerts until you text \"wake\" or \"quiet off\".";
  }

  _handleQuietOff() {
    this.scheduler.setQuietOverride(false);
    return "Quiet mode off. Alerts resumed.";
  }

  // ── Info ────────────────────────────────────────────────────────────────

  _handleList() {
    const projects = this.scanner.scanAll();
    const sessions = this.sessionManager.getActiveSessions();
    const sessionNames = new Set(sessions.map((s) => s.projectName));

    const lines = ["All projects:"];
    for (const p of projects) {
      if (!p.exists) continue;
      const icon = sessionNames.has(p.name) ? ">" : " ";
      const state = p.hasState
        ? p.progress != null ? `${p.progress}%` : p.status || "has state"
        : "no state";
      lines.push(`${icon} ${p.name} - ${state}`);
    }
    return lines.join("\n");
  }

  _handleHelp() {
    const ctx = this._getContext();
    const lines = [
      "Commands:",
      "",
      "status - all projects overview",
      "status <name> - one project detail",
      "priority - what needs attention",
      "list - all projects",
      "sessions - active Claude sessions",
      "",
      "start <name> - launch Claude session",
      "stop <name> - stop a session",
      "restart <name> - restart a session",
      "startall / stopall - all at once",
      "reply <name>: <text> - send input",
      "",
      "go / continue / yes - act on last project",
      "pause / unpause <name> - mute alerts",
      "shh / wake - quiet mode on/off",
    ];

    if (this.aiBrain) {
      lines.push("");
      lines.push("AI: ai on/off | think | status | explain | level");
    }

    if (ctx) {
      lines.push("");
      lines.push(`Context: ${ctx.project} (${ctx.type})`);
    }

    return lines.join("\n");
  }

  // ── AI Commands ────────────────────────────────────────────────────────

  _handleAiOn() {
    if (!this.aiBrain) return "AI brain not configured.";
    this.aiBrain.enable();
    return "AI brain enabled (observe mode). I'll analyze your projects every 5 minutes and send recommendations.\n\nText 'ai think' to trigger now, 'ai off' to disable.";
  }

  _handleAiOff() {
    if (!this.aiBrain) return "AI brain not configured.";
    this.aiBrain.disable();
    return "AI brain disabled. No more automatic analysis.\n\nText 'ai on' to re-enable.";
  }

  _handleAiStatus() {
    if (!this.aiBrain) return "AI brain not configured.";
    const status = this.aiBrain.getStatus();
    return [
      `AI Brain: ${status.enabled ? "enabled" : "disabled"}`,
      `Mode: ${status.autonomyLevel}`,
      `Last think: ${status.lastThinkTime || "never"}`,
      `Thinking: ${status.thinking ? "yes" : "no"}`,
      `Decisions logged: ${status.recentDecisions}`,
    ].join("\n");
  }

  _handleAiThink() {
    if (!this.aiBrain) return "AI brain not configured.";

    // Trigger async think cycle, send results when done
    setTimeout(async () => {
      try {
        // Temporarily enable for this one-shot think if disabled
        const wasEnabled = this.aiBrain.isEnabled();
        if (!wasEnabled) this.aiBrain.enable();

        const decision = await this.aiBrain.think();

        if (!wasEnabled) this.aiBrain.disable();

        if (decision && decision.recommendations?.length > 0) {
          const evaluated = decision.evaluated || this.decisionExecutor.evaluate(decision.recommendations);
          const sms = this.decisionExecutor.formatForSMS(evaluated, decision.summary);
          this.messenger.send(sms);
        } else if (decision && decision.error) {
          this.messenger.send(`AI think error: ${decision.summary || decision.error}`);
        } else {
          this.messenger.send("AI think complete: no recommendations right now.");
        }
      } catch (e) {
        this.messenger.send(`AI think failed: ${e.message}`);
      }
    }, 100);

    return "Thinking... I'll send results shortly.";
  }

  _handleAiExplain() {
    if (!this.aiBrain) return "AI brain not configured.";
    const decision = this.aiBrain.getLastDecision();
    if (!decision) return "No AI decisions yet. Text 'ai think' to trigger one.";

    const lines = [
      "Last AI decision:",
      decision.timestamp,
      "",
      `Summary: ${decision.summary}`,
    ];

    if (decision.recommendations && decision.recommendations.length > 0) {
      lines.push("");
      lines.push("Recommendations:");
      decision.recommendations.forEach((r, i) => {
        lines.push(`${i + 1}. ${r.project} -> ${r.action}: ${r.reason || "no reason"}`);
      });
    }

    lines.push("");
    lines.push(`Duration: ${decision.duration_ms}ms`);

    return lines.join("\n");
  }

  _handleAiLevel() {
    return [
      "Autonomy: observe",
      "",
      "In observe mode, the AI analyzes projects and sends recommendations via SMS but does NOT take any actions automatically.",
      "",
      "Levels: observe -> cautious -> moderate -> full",
      "(Higher levels available in future updates)",
    ].join("\n");
  }

  _handleAiHelp() {
    return [
      "AI commands:",
      "",
      "ai on/off - enable/disable AI brain",
      "ai think - trigger analysis now",
      "ai status - show AI state",
      "ai explain - show last decision",
      "ai level - show autonomy level",
    ].join("\n");
  }

  // ── Context-aware handlers ─────────────────────────────────────────────

  /**
   * Handle "go" / "continue" / "yes" etc. - act on the context project
   */
  _handleGo() {
    const ctx = this._getContext();
    if (!ctx) return "No recent project context. What project do you want to work on?";

    // If last signal was needs-input, a bare "yes"/"go" is ambiguous
    if (ctx.type === "needs-input") {
      return `${ctx.project} is waiting for input. Reply with your answer, or use: reply ${ctx.project}: <answer>`;
    }

    // If last signal was completed or error, restart the project to continue
    this.setContext(ctx.project, "command");
    this.signalProtocol.injectClaudeMd(ctx.project);
    const result = this.sessionManager.startSession(ctx.project);
    if (result.success) {
      return `Continuing ${ctx.project}.\n${result.message}`;
    }
    // Already running
    return result.message;
  }

  /**
   * Handle bare "stop" with no project name
   */
  _handleStopContext() {
    const ctx = this._getContext();
    if (!ctx) return "Stop which project? Text \"stop <project>\" or \"sessions\" to see running sessions.";

    this.setContext(ctx.project, "command");
    const result = this.sessionManager.stopSession(ctx.project);
    return `(Using context: ${ctx.project})\n${result.message}`;
  }

  /**
   * Handle unrecognized text using conversation context
   */
  _handleContextual(text, lower) {
    const ctx = this._getContext();

    if (!ctx) return this._handleHelp();

    // If the context project needs input, treat any unrecognized text as a reply
    if (ctx.type === "needs-input") {
      return this._sendReply(ctx.project, text);
    }

    // If context project just completed, check if user is giving next instructions
    if (ctx.type === "completed") {
      this.setContext(ctx.project, "command");
      this.signalProtocol.injectClaudeMd(ctx.project);
      const prompt = `The user wants you to: ${text}. Check .planning/STATE.md for context and work autonomously.`;
      const result = this.sessionManager.startSession(ctx.project, prompt);
      return `(Using context: ${ctx.project})\n${result.message}`;
    }

    // Default: show what we know and offer help
    return [
      `Last project: ${ctx.project}`,
      "",
      "Did you mean one of these?",
      `- reply ${ctx.project}: ${text}`,
      `- start ${ctx.project}`,
      `- status ${ctx.project}`,
      "",
      "Text \"help\" for all commands.",
    ].join("\n");
  }

  /**
   * Find a known project name embedded within free-form text
   * e.g., "phase 5 land speculation" → { project: "land-speculation", instruction: "phase 5" }
   */
  _findEmbeddedProject(text) {
    const lower = text.toLowerCase();
    // Normalize: remove hyphens for matching (so "land speculation" matches "land-speculation")
    const normalized = lower.replace(/-/g, " ");

    let bestMatch = null;
    let bestLen = 0;

    for (const name of this.projectNames) {
      const nameLower = name.toLowerCase();
      const nameNormalized = nameLower.replace(/-/g, " ");

      // Check if the full project name appears in the text (with or without hyphens)
      if (normalized.includes(nameNormalized) && nameNormalized.length > bestLen) {
        // Extract the instruction by removing the project name
        const instruction = normalized.replace(nameNormalized, "").trim();
        bestMatch = { project: name, instruction: instruction || null };
        bestLen = nameNormalized.length;
      }
    }

    return bestMatch;
  }

  isPaused(name) {
    return this._pausedProjects.has(name);
  }

  _matchProjectName(input) {
    const lower = input.toLowerCase();

    // Exact match
    const exact = this.projectNames.find((n) => n.toLowerCase() === lower);
    if (exact) return exact;

    // Prefix match
    const prefix = this.projectNames.find((n) => n.toLowerCase().startsWith(lower));
    if (prefix) return prefix;

    // Contains match
    const contains = this.projectNames.find((n) => n.toLowerCase().includes(lower));
    if (contains) return contains;

    // Fuzzy match - allow 1 character off (typos like "smm" -> "sms")
    let bestMatch = null;
    let bestDist = Infinity;
    for (const name of this.projectNames) {
      // Check against full name and each word in hyphenated names
      const parts = [name.toLowerCase(), ...name.toLowerCase().split("-")];
      for (const part of parts) {
        const dist = this._levenshtein(lower, part);
        if (dist <= 2 && dist < bestDist) {
          bestDist = dist;
          bestMatch = name;
        }
      }
    }
    return bestMatch;
  }

  _levenshtein(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] = a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
    return dp[m][n];
  }
}

module.exports = CommandRouter;
