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
    this._pausedProjects = new Set();
  }

  route(text) {
    const trimmed = text.trim();
    const lower = trimmed.toLowerCase();

    if (lower === "status") return this._handleStatusAll();
    if (lower.startsWith("status ")) return this._handleStatusProject(lower.slice(7).trim());
    if (lower === "priority" || lower === "pri") return this._handlePriority();
    if (lower.startsWith("start ")) return this._handleStart(lower.slice(6).trim());
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

    return this._handleHelp();
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

  _handleStart(name) {
    const match = this._matchProjectName(name);
    if (!match) return `Don't know a project called "${name}".`;

    this.signalProtocol.injectClaudeMd(match);
    const result = this.sessionManager.startSession(match);
    return result.message;
  }

  _handleStop(name) {
    const match = this._matchProjectName(name);
    if (!match) return `Don't know a project called "${name}".`;

    const result = this.sessionManager.stopSession(match);
    return result.message;
  }

  _handleRestart(name) {
    const match = this._matchProjectName(name);
    if (!match) return `Don't know a project called "${name}".`;

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
      return "To reply, use: reply <project>: <your message>";
    }

    const projectInput = input.substring(0, colonIdx).trim().toLowerCase();
    const message = input.substring(colonIdx + 1).trim();

    const match = this._matchProjectName(projectInput);
    if (!match) return `Don't know a project called "${projectInput}".`;
    if (!message) return "Empty reply. Use: reply <project>: <your message>";

    this.signalProtocol.clearSignal(match, "needs-input");
    const result = this.sessionManager.sendInput(match, message);

    if (result.success) {
      const preview = message.length > 50 ? message.substring(0, 50) + "..." : message;
      return `Sent to ${match}: "${preview}"`;
    }

    // Session not running - restart with the reply as context
    const prompt =
      `The user responded to your question with: "${message}". ` +
      "Continue working with this input. " +
      "Check .planning/STATE.md for current status and .orchestrator/ for previous context.";

    this.signalProtocol.injectClaudeMd(match);
    this.sessionManager.startSession(match, prompt);
    return `Session wasn't running. Restarted ${match} with your input.`;
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
    return [
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
      "pause / unpause <name> - mute alerts",
      "shh / wake - quiet mode on/off",
    ].join("\n");
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
