const fs = require("fs");
const path = require("path");

/**
 * ContextAssembler - Gathers all project/session state and compresses it
 * into a compact prompt string suitable for `claude -p`.
 *
 * This is the AI brain's eyes -- it sees everything the orchestrator knows.
 */
class ContextAssembler {
  /**
   * @param {Object} deps
   * @param {Object} deps.scanner - ProjectScanner instance (scanAll, scanProject)
   * @param {Object} deps.sessionManager - SessionManager instance (getActiveSessions)
   * @param {Object} deps.processMonitor - ProcessMonitor instance (checkProjects)
   * @param {Object} deps.state - StateManager instance (load)
   * @param {Object} deps.config - Parsed config.json object
   */
  constructor({ scanner, sessionManager, processMonitor, state, config }) {
    this.scanner = scanner;
    this.sessionManager = sessionManager;
    this.processMonitor = processMonitor;
    this.state = state;
    this.config = config;
    this.prioritiesPath = path.join(__dirname, "..", "priorities.json");
  }

  /**
   * Assemble a complete context prompt for the AI brain.
   * @returns {string} The prompt string for claude -p
   */
  assemble() {
    const priorities = this._loadPriorities();
    const projects = this.scanner.scanAll();
    const sessions = this.sessionManager.getActiveSessions();
    const stateData = this.state.load();
    const decisionHistory = (stateData.aiDecisionHistory || []).slice(-5);

    // Filter out skipped projects
    const skipSet = new Set(priorities.skip || []);
    const activeProjects = projects.filter((p) => !skipSet.has(p.name));

    // Filter out projects with no state AND no active session
    const sessionSet = new Set(sessions.map((s) => s.projectName));
    const relevantProjects = activeProjects.filter(
      (p) => p.hasState || sessionSet.has(p.name)
    );

    // Sort: focus first, then needsAttention, then alphabetical
    const focusSet = new Set(priorities.focus || []);
    relevantProjects.sort((a, b) => {
      const aFocus = focusSet.has(a.name) ? 0 : 1;
      const bFocus = focusSet.has(b.name) ? 0 : 1;
      if (aFocus !== bFocus) return aFocus - bFocus;

      const aAttention = a.needsAttention ? 0 : 1;
      const bAttention = b.needsAttention ? 0 : 1;
      if (aAttention !== bAttention) return aAttention - bAttention;

      return a.name.localeCompare(b.name);
    });

    // Count summary stats
    const needsAttentionCount = relevantProjects.filter(
      (p) => p.needsAttention
    ).length;

    // Build the prompt sections
    const sections = [];

    // 1. System preamble
    sections.push(this._buildPreamble(relevantProjects.length, sessions.length, needsAttentionCount));

    // 2. Current time + quiet hours
    sections.push(this._buildTimeSection());

    // 3. User priorities
    sections.push(this._buildPrioritiesSection(priorities));

    // 4. Active sessions
    sections.push(this._buildSessionsSection(sessions));

    // 5. Project states
    sections.push(this._buildProjectsSection(relevantProjects, sessionSet, priorities));

    // 6. Recent decision history
    if (decisionHistory.length > 0) {
      sections.push(this._buildHistorySection(decisionHistory));
    }

    // 7. Response format
    sections.push(this._buildResponseFormat());

    let prompt = sections.join("\n\n---\n\n");

    // Truncate if over max length
    const maxLen = this.config.ai?.maxPromptLength || 8000;
    if (prompt.length > maxLen) {
      prompt = prompt.substring(0, maxLen - 50) + "\n\n[Context truncated]";
    }

    return prompt;
  }

  /**
   * Get a single project's context string.
   * @param {string} projectName
   * @returns {string}
   */
  getProjectSummary(projectName) {
    const projects = this.scanner.scanAll();
    const project = projects.find((p) => p.name === projectName);
    if (!project) return `Project "${projectName}" not found.`;

    const sessions = this.sessionManager.getActiveSessions();
    const hasSession = sessions.some((s) => s.projectName === projectName);
    const priorities = this._loadPriorities();
    const note = priorities.notes?.[projectName];

    return this._formatProject(project, hasSession, note);
  }

  // --- Private helpers ---

  /**
   * Load priorities.json with fallback to empty defaults
   * @returns {Object}
   */
  _loadPriorities() {
    try {
      const raw = fs.readFileSync(this.prioritiesPath, "utf-8");
      return JSON.parse(raw);
    } catch {
      return { focus: [], block: [], skip: [], notes: {} };
    }
  }

  /**
   * Build the system preamble section
   */
  _buildPreamble(projectCount, sessionCount, attentionCount) {
    return (
      `You are the AI brain of a project orchestrator managing ${projectCount} projects on a Mac Mini. ` +
      `You observe project states and recommend actions. Respond with a JSON object.\n\n` +
      `Overview: ${projectCount} projects tracked, ${sessionCount} active sessions, ${attentionCount} needing attention.`
    );
  }

  /**
   * Build current time and quiet hours section
   */
  _buildTimeSection() {
    const now = new Date();
    const lines = [`Current time: ${now.toISOString()}`];

    const qh = this.config.quietHours;
    if (qh?.enabled) {
      const isQuiet = this._isQuietHours(now, qh);
      lines.push(
        `Quiet hours: ${qh.start}-${qh.end} ${qh.timezone} (currently ${isQuiet ? "ACTIVE - no SMS" : "inactive"})`
      );
    }

    return lines.join("\n");
  }

  /**
   * Check if current time is within quiet hours
   */
  _isQuietHours(now, qh) {
    try {
      const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: qh.timezone,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
      const localTime = formatter.format(now);
      const [h, m] = localTime.split(":").map(Number);
      const currentMinutes = h * 60 + m;

      const [startH, startM] = qh.start.split(":").map(Number);
      const [endH, endM] = qh.end.split(":").map(Number);
      const startMinutes = startH * 60 + startM;
      const endMinutes = endH * 60 + endM;

      if (startMinutes > endMinutes) {
        // Crosses midnight (e.g., 22:00 - 07:00)
        return currentMinutes >= startMinutes || currentMinutes < endMinutes;
      }
      return currentMinutes >= startMinutes && currentMinutes < endMinutes;
    } catch {
      return false;
    }
  }

  /**
   * Build user priorities section
   */
  _buildPrioritiesSection(priorities) {
    const lines = ["User Priorities:"];

    if (priorities.focus?.length > 0) {
      lines.push(`Focus: ${priorities.focus.join(", ")}`);
    }
    if (priorities.block?.length > 0) {
      lines.push(`Blocked (never start sessions): ${priorities.block.join(", ")}`);
    }
    if (priorities.skip?.length > 0) {
      lines.push(`Skipped (excluded from analysis): ${priorities.skip.join(", ")}`);
    }

    const noteEntries = Object.entries(priorities.notes || {});
    if (noteEntries.length > 0) {
      lines.push("Notes:");
      for (const [project, note] of noteEntries) {
        lines.push(`  ${project}: ${note}`);
      }
    }

    if (lines.length === 1) {
      lines.push("No overrides set.");
    }

    return lines.join("\n");
  }

  /**
   * Build active sessions section with duration and timeout warnings
   */
  _buildSessionsSection(sessions) {
    const maxConcurrent = this.config.maxConcurrentSessions || 5;
    const maxDuration = this.config.ai?.maxSessionDurationMs || 2700000;
    const lines = [`Active Sessions (${sessions.length}/${maxConcurrent}):`];

    if (sessions.length === 0) {
      lines.push("None running.");
    } else {
      for (const s of sessions) {
        const startTime = new Date(s.created).getTime();
        const durationMin = Math.round((Date.now() - startTime) / 60000);
        const maxMin = Math.round(maxDuration / 60000);
        const timeWarning = durationMin >= maxMin ? " TIMEOUT IMMINENT" : "";
        lines.push(`- ${s.projectName} (${durationMin}min running${timeWarning})`);
      }
    }

    return lines.join("\n");
  }

  /**
   * Build project states section
   */
  _buildProjectsSection(projects, sessionSet, priorities) {
    const lines = [`Projects (${projects.length}):`];

    // Load error retry counts from state
    const stateData = this.state.load();
    const errorCounts = stateData.errorRetryCounts || {};

    for (const p of projects) {
      const note = priorities.notes?.[p.name];
      const errorInfo = this._getProjectErrorInfo(p.name, errorCounts);
      lines.push("");
      lines.push(this._formatProject(p, sessionSet.has(p.name), note, errorInfo));
    }

    return lines.join("\n");
  }

  /**
   * Get error info for a project from state and signal files
   * @param {string} projectName
   * @param {Object} errorCounts - Error retry counts from state
   * @returns {Object|null} { error, retryCount } or null
   */
  _getProjectErrorInfo(projectName, errorCounts) {
    const retryCount = errorCounts[projectName] || 0;

    // Check for active error signal file
    const projectsDir = this.config.projectsDir || this.scanner?.projectsDir || "/Users/claude/projects";
    const errorFile = path.join(projectsDir, projectName, ".orchestrator", "error.json");
    let errorData = null;
    try {
      if (fs.existsSync(errorFile)) {
        errorData = JSON.parse(fs.readFileSync(errorFile, "utf-8"));
      }
    } catch {}

    if (!errorData && retryCount === 0) return null;

    return {
      error: errorData?.error || (retryCount > 0 ? "previous error (retried)" : null),
      retryCount,
    };
  }

  /**
   * Format a single project into a compact 2-3 line block
   */
  _formatProject(project, hasSession, note, errorInfo) {
    const parts = [project.name];

    // Status line
    const statusParts = [];
    if (project.status) statusParts.push(project.status);
    if (project.phase && project.totalPhases) {
      statusParts.push(`phase ${project.phase}/${project.totalPhases}`);
    }
    if (project.progress != null) {
      statusParts.push(`${project.progress}%`);
    }
    if (hasSession) statusParts.push("SESSION ACTIVE");

    if (statusParts.length > 0) {
      parts.push(`  ${statusParts.join(" | ")}`);
    }

    // Attention / blockers line
    if (project.needsAttention) {
      parts.push(`  ATTENTION: ${project.attentionReason}`);
    }
    if (project.blockers?.length > 0) {
      parts.push(`  Blockers: ${project.blockers.join("; ")}`);
    }

    // User note
    if (note) {
      parts.push(`  Note: ${note}`);
    }

    // Error history
    if (errorInfo) {
      parts.push(`  ERROR: ${errorInfo.error || "unknown error"}`);
      if (errorInfo.retryCount > 0) {
        const maxRetries = this.config.ai?.maxErrorRetries || 3;
        parts.push(`  Retries: ${errorInfo.retryCount}/${maxRetries}`);
      }
    }

    // Last activity with staleness detection
    if (project.lastActivity) {
      const lastDate = new Date(project.lastActivity);
      const daysSince = Math.round((Date.now() - lastDate.getTime()) / 86400000);
      const stalenessDays = this.config.ai?.stalenessDays || 3;
      if (daysSince >= stalenessDays && project.status && !project.status.toLowerCase().includes("complete")) {
        parts.push(`  STALE (${daysSince} days idle)`);
      }
      parts.push(`  Last: ${project.lastActivity}`);
    }

    return parts.join("\n");
  }

  /**
   * Build recent decision history section
   */
  _buildHistorySection(history) {
    const lines = ["Recent AI Decisions (avoid repeating):"];
    for (const entry of history) {
      const time = entry.timestamp || "unknown";
      const action = entry.action || "unknown";
      const project = entry.project || "unknown";
      lines.push(`- [${time}] ${action} on ${project}: ${entry.reason || ""}`);
    }
    return lines.join("\n");
  }

  /**
   * Build response format instructions with autonomy level and expanded fields
   */
  _buildResponseFormat() {
    // Load runtime autonomy level
    const stateData = this.state.load();
    const autonomyLevel = this.state.getAutonomyLevel
      ? this.state.getAutonomyLevel(stateData, this.config)
      : this.config.ai?.autonomyLevel || "observe";

    const lines = [
      "Respond with a JSON object in this exact format:",
      "{",
      '  "recommendations": [',
      "    {",
      '      "project": "project-name",',
      '      "action": "start|stop|restart|notify|skip",',
      '      "reason": "why this action",',
      "      \"priority\": 1-5,",
      '      "message": "SMS text if action is notify",',
      '      "prompt": "optional: specific instructions for the Claude Code session (for start/restart)",',
      '      "confidence": 0.85,',
      '      "notificationTier": 2',
      "    }",
      "  ],",
      '  "summary": "One-line overall assessment",',
      '  "nextThinkIn": "suggested seconds until next think cycle"',
      "}",
      "",
      `Current autonomy level: ${autonomyLevel}`,
      autonomyLevel === "observe"
        ? "You are in OBSERVE mode. Recommend actions but none will be executed automatically."
        : `You are in ${autonomyLevel.toUpperCase()} mode. Actions will be executed automatically based on your recommendations.`,
      "",
      "Rules:",
      "- Only recommend actions for projects not in the block list",
      "- Focus on projects in the focus list first",
      "- Prioritize STALE projects that have pending work",
      "- Do not repeat an action for the same project if it appears in recent decisions",
      "- If nothing needs doing, return empty recommendations and suggest a longer nextThinkIn",
      "- priority: 1=critical, 2=high, 3=medium, 4=low, 5=informational",
      '- For start/restart actions, include a specific "prompt" field with targeted instructions for the session',
      "- For projects with errors, evaluate if the error is retryable or needs human intervention",
      "- If error retry count is at the cap, recommend \"notify\" to escalate to the user instead of restart",
    ];

    return lines.join("\n");
  }
}

module.exports = ContextAssembler;
