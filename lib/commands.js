/**
 * CommandRouter - Handles incoming SMS commands for the orchestrator.
 * Routes text messages to appropriate handlers.
 */
class CommandRouter {
  /**
   * @param {Object} deps - Dependencies
   * @param {import('./scanner')} deps.scanner - Project scanner
   * @param {import('./process-monitor')} deps.processMonitor - Process monitor
   * @param {import('./digest')} deps.digest - Digest formatter
   * @param {import('./scheduler')} deps.scheduler - Scheduler (for quiet hours)
   * @param {import('./session-manager')} deps.sessionManager - Session manager
   * @param {import('./signal-protocol').SignalProtocol} deps.signalProtocol - Signal protocol
   * @param {Object} deps.state - State manager
   */
  constructor(deps) {
    this.scanner = deps.scanner;
    this.processMonitor = deps.processMonitor;
    this.digest = deps.digest;
    this.scheduler = deps.scheduler;
    this.sessionManager = deps.sessionManager;
    this.signalProtocol = deps.signalProtocol;
    this.state = deps.state;
    this.projectNames = deps.projectNames;
    this._pausedProjects = new Set();
  }

  /**
   * Route an incoming message to the appropriate handler
   * @param {string} text - Incoming message text
   * @returns {string} Response text
   */
  route(text) {
    const trimmed = text.trim();
    const lower = trimmed.toLowerCase();

    // Status commands
    if (lower === "status") return this._handleStatusAll();
    if (lower.startsWith("status ")) return this._handleStatusProject(lower.slice(7).trim());

    // Priority
    if (lower === "priority" || lower === "pri") return this._handlePriority();

    // Session management
    if (lower.startsWith("start ")) return this._handleStart(lower.slice(6).trim());
    if (lower.startsWith("stop ")) return this._handleStop(lower.slice(5).trim());
    if (lower.startsWith("restart ")) return this._handleRestart(lower.slice(8).trim());
    if (lower === "startall") return this._handleStartAll();
    if (lower === "stopall") return this._handleStopAll();
    if (lower === "sessions") return this._handleSessions();

    // Reply/input routing - preserve original case for the reply content
    if (lower.startsWith("reply ")) return this._handleReply(trimmed.slice(6));

    // Pause/unpause alerts for a project
    if (lower.startsWith("pause ")) return this._handlePause(lower.slice(6).trim());
    if (lower.startsWith("unpause ") || lower.startsWith("resume ")) {
      const name = lower.replace(/^(unpause|resume)\s+/, "").trim();
      return this._handleUnpause(name);
    }

    // Quiet hours
    if (lower === "quiet on" || lower === "shh") return this._handleQuietOn();
    if (lower === "quiet off" || lower === "wake") return this._handleQuietOff();

    // Help
    if (lower === "help" || lower === "?") return this._handleHelp();

    // Projects list
    if (lower === "projects" || lower === "list") return this._handleList();

    // Unrecognized
    return this._handleHelp();
  }

  // ── Status commands ─────────────────────────────────────────────────────

  _handleStatusAll() {
    const projects = this.scanner.scanAll();
    const processStatus = this.processMonitor.checkProjects(this.projectNames);
    return this.digest.formatMorningDigest(projects, processStatus);
  }

  _handleStatusProject(name) {
    const match = this._matchProjectName(name);
    if (!match) return `/orchestrator\nUnknown project "${name}".\nType "list" for all projects.`;

    const project = this.scanner.scanProject(match);
    const processStatus = this.processMonitor.checkProjects([match]);
    return this.digest.formatProjectDetail(project, processStatus[match]);
  }

  _handlePriority() {
    const projects = this.scanner.scanAll();
    const processStatus = this.processMonitor.checkProjects(this.projectNames);
    return this.digest.formatPriority(projects, processStatus);
  }

  // ── Session management ──────────────────────────────────────────────────

  _handleStart(name) {
    const match = this._matchProjectName(name);
    if (!match) return `/orchestrator\nUnknown project "${name}".`;

    // Inject orchestrator instructions into project
    this.signalProtocol.injectClaudeMd(match);

    const result = this.sessionManager.startSession(match);
    return `/orchestrator\n${result.message}`;
  }

  _handleStop(name) {
    const match = this._matchProjectName(name);
    if (!match) return `/orchestrator\nUnknown project "${name}".`;

    const result = this.sessionManager.stopSession(match);
    return `/orchestrator\n${result.message}`;
  }

  _handleRestart(name) {
    const match = this._matchProjectName(name);
    if (!match) return `/orchestrator\nUnknown project "${name}".`;

    this.signalProtocol.injectClaudeMd(match);
    const result = this.sessionManager.restartSession(match);
    return `/orchestrator\n${result.message}`;
  }

  _handleStartAll() {
    // Only start projects that have planning state (active projects)
    const projects = this.scanner.scanAll();
    const active = projects.filter(
      (p) => p.hasState && p.status && !p.status.toLowerCase().includes("complete")
    );

    if (active.length === 0) {
      return "/orchestrator\nNo active (non-complete) projects to start.";
    }

    const results = [];
    for (const p of active) {
      this.signalProtocol.injectClaudeMd(p.name);
      const r = this.sessionManager.startSession(p.name);
      results.push(`${p.name}: ${r.message}`);
    }
    return `/orchestrator\nSTART ALL:\n${results.join("\n")}`;
  }

  _handleStopAll() {
    const sessions = this.sessionManager.getActiveSessions();
    if (sessions.length === 0) {
      return "/orchestrator\nNo sessions running.";
    }

    const results = [];
    for (const s of sessions) {
      const r = this.sessionManager.stopSession(s.projectName);
      results.push(`${s.projectName}: ${r.message}`);
    }
    return `/orchestrator\nSTOP ALL:\n${results.join("\n")}`;
  }

  _handleSessions() {
    const sessions = this.sessionManager.getSessionStatuses();

    if (sessions.length === 0) {
      return "/orchestrator\nNo active sessions.\nText 'start <project>' to launch one.";
    }

    const lines = ["/orchestrator", `SESSIONS (${sessions.length}):`];
    for (const s of sessions) {
      let status = "running";
      if (s.ended) status = "ended";
      if (s.needsInput) status = "NEEDS INPUT";
      if (s.error) status = "ERROR";
      if (s.completed) status = "completed";

      lines.push(`  ${s.projectName}: ${status}`);
      if (s.needsInput) {
        lines.push(`    Q: ${s.needsInput.question?.substring(0, 80) || "?"}`);
      }
      if (s.error) {
        lines.push(`    E: ${s.error.error?.substring(0, 80) || "?"}`);
      }
      if (s.lastOutput && !s.needsInput && !s.error) {
        const lastLine = s.lastOutput.split("\n").pop()?.substring(0, 60);
        if (lastLine) lines.push(`    > ${lastLine}`);
      }
    }
    return lines.join("\n");
  }

  // ── Input routing ───────────────────────────────────────────────────────

  _handleReply(input) {
    // Format: "reply <project>: <message>"
    const colonIdx = input.indexOf(":");
    if (colonIdx === -1) {
      return "/orchestrator\nFormat: reply <project>: <your message>";
    }

    const projectInput = input.substring(0, colonIdx).trim().toLowerCase();
    const message = input.substring(colonIdx + 1).trim();

    const match = this._matchProjectName(projectInput);
    if (!match) return `/orchestrator\nUnknown project "${projectInput}".`;

    if (!message) {
      return "/orchestrator\nEmpty reply. Format: reply <project>: <your message>";
    }

    // Clear the needs-input signal since we're responding
    this.signalProtocol.clearSignal(match, "needs-input");

    // Send input to the tmux session
    const result = this.sessionManager.sendInput(match, message);

    if (result.success) {
      return `/orchestrator\nSent to ${match}: "${message.substring(0, 50)}${message.length > 50 ? "..." : ""}"`;
    }

    // If session isn't running, restart it with the reply as context
    const prompt =
      `The user responded to your question with: "${message}". ` +
      "Continue working with this input. " +
      "Check .planning/STATE.md for current status and .orchestrator/ for previous context.";

    this.signalProtocol.injectClaudeMd(match);
    const restart = this.sessionManager.startSession(match, prompt);
    return `/orchestrator\nSession wasn't running. Restarted ${match} with your input.`;
  }

  // ── Alert management ────────────────────────────────────────────────────

  _handlePause(name) {
    const match = this._matchProjectName(name);
    if (!match) return `/orchestrator\nUnknown project "${name}".`;
    this._pausedProjects.add(match);
    return `/orchestrator\nPaused alerts for ${match}. Text "unpause ${match}" to resume.`;
  }

  _handleUnpause(name) {
    const match = this._matchProjectName(name);
    if (!match) return `/orchestrator\nUnknown project "${name}".`;
    this._pausedProjects.delete(match);
    return `/orchestrator\nResumed alerts for ${match}.`;
  }

  _handleQuietOn() {
    this.scheduler.setQuietOverride(true);
    return "/orchestrator\nQuiet mode ON. No alerts until you text 'quiet off' or 'wake'.";
  }

  _handleQuietOff() {
    this.scheduler.setQuietOverride(false);
    return "/orchestrator\nQuiet mode OFF. Alerts resumed.";
  }

  // ── Info commands ───────────────────────────────────────────────────────

  _handleList() {
    const projects = this.scanner.scanAll();
    const sessions = this.sessionManager.getActiveSessions();
    const sessionNames = new Set(sessions.map((s) => s.projectName));

    const lines = ["/orchestrator", "ALL PROJECTS:", ""];
    for (const p of projects) {
      if (!p.exists) continue;
      const running = sessionNames.has(p.name) ? "RUN" : "---";
      const state = p.hasState
        ? p.progress != null
          ? `${p.progress}%`
          : p.status || "has state"
        : "no state";
      lines.push(`  [${running}] ${p.name}: ${state}`);
    }
    return lines.join("\n");
  }

  _handleHelp() {
    return [
      "/orchestrator",
      "COMMANDS:",
      "",
      "INFO:",
      "  status          - All projects overview",
      "  status <name>   - Detail for one project",
      "  priority        - What needs attention",
      "  list            - All projects with status",
      "  sessions        - Active Claude sessions",
      "",
      "SESSIONS:",
      "  start <name>    - Launch Claude for a project",
      "  stop <name>     - Stop a session",
      "  restart <name>  - Restart a session",
      "  startall        - Start all active projects",
      "  stopall         - Stop all sessions",
      "  reply <name>: <text> - Send input to a session",
      "",
      "ALERTS:",
      "  pause <name>    - Mute alerts for a project",
      "  unpause <name>  - Resume alerts",
      "  quiet on / shh  - Silence everything",
      "  quiet off / wake - Resume alerts",
      "",
      "  help / ?        - This message",
    ].join("\n");
  }

  /**
   * Check if a project is paused
   * @param {string} name
   * @returns {boolean}
   */
  isPaused(name) {
    return this._pausedProjects.has(name);
  }

  /**
   * Fuzzy match a project name (case-insensitive, partial match)
   * @param {string} input
   * @returns {string|null} Matched project name or null
   */
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

    return null;
  }
}

module.exports = CommandRouter;
