const { execSync, exec } = require("child_process");
const fs = require("fs");
const path = require("path");

/**
 * SessionManager - Launches and manages Claude Code sessions in tmux panes.
 *
 * Each project gets a tmux session named "orch-<projectName>".
 * Claude Code runs with --dangerously-skip-permissions for autonomous operation.
 * Sessions communicate back via .orchestrator/ signal files.
 */
class SessionManager {
  constructor(config) {
    this.projectsDir = config.projectsDir;
    this.maxConcurrent = config.maxConcurrentSessions || 5;
    this.sessionPrefix = "orch-";

    // Build short-name -> full-path mapping for subdirectory support
    this._shortToFull = {};
    for (const name of (config.projects || [])) {
      this._shortToFull[path.basename(name)] = name;
    }
  }

  /**
   * Get the short display name from a project path (e.g., "revenue/web-scraping-biz" -> "web-scraping-biz")
   */
  _shortName(projectName) {
    return path.basename(projectName);
  }

  /**
   * Resolve a short name back to full path (e.g., "web-scraping-biz" -> "revenue/web-scraping-biz")
   */
  _fullName(shortName) {
    return this._shortToFull[shortName] || shortName;
  }

  /**
   * Get a tmux-safe session name (no slashes)
   */
  _sessionName(projectName) {
    return this.sessionPrefix + this._shortName(projectName);
  }

  /**
   * Start a Claude Code session for a project
   * @param {string} projectName - Project directory name
   * @param {string} [prompt] - Optional initial prompt (default: resume work)
   * @returns {{ success: boolean, message: string }}
   */
  startSession(projectName, prompt) {
    const projectDir = path.join(this.projectsDir, projectName);
    if (!fs.existsSync(projectDir)) {
      return { success: false, message: `Project dir not found: ${projectDir}` };
    }

    const sessionName = this._sessionName(projectName);

    // Check if already running
    if (this._tmuxSessionExists(sessionName)) {
      return { success: false, message: `Session already running for ${projectName}` };
    }

    // Check concurrent limit
    const running = this.getActiveSessions();
    if (running.length >= this.maxConcurrent) {
      return {
        success: false,
        message: `Max concurrent sessions (${this.maxConcurrent}) reached. Stop one first.`,
      };
    }

    // Ensure .orchestrator/ signal directory exists
    const signalDir = path.join(projectDir, ".orchestrator");
    if (!fs.existsSync(signalDir)) {
      fs.mkdirSync(signalDir, { recursive: true });
    }

    // Clear any stale signal files
    this._clearSignals(signalDir);

    // Build the resume prompt
    const resumePrompt = prompt || this._buildResumePrompt(projectName, projectDir);

    // Write prompt to a temp file (avoids all shell escaping issues)
    const promptFile = path.join(signalDir, "prompt.txt");
    fs.writeFileSync(promptFile, resumePrompt);

    // Create tmux session with interactive Claude Code
    // Start claude in the project dir, then send the prompt as input
    try {
      // Launch tmux with claude in interactive mode
      execSync(
        `tmux new-session -d -s "${sessionName}" -c "${projectDir}" ` +
          `"claude --dangerously-skip-permissions"`,
        { timeout: 10000 }
      );

      // Give Claude time to start up (MCP servers, hooks, etc.)
      execSync("sleep 8");

      // Send the prompt via tmux - use separate commands to ensure proper sequencing
      execSync(`tmux load-buffer "${promptFile}"`, { timeout: 5000 });
      execSync(`tmux paste-buffer -t "${sessionName}"`, { timeout: 5000 });
      execSync("sleep 1");
      execSync(`tmux send-keys -t "${sessionName}" Enter`, { timeout: 5000 });

      // Capture HEAD commit hash for evaluation window
      let headBefore = null;
      try {
        headBefore = execSync(`git -C "${projectDir}" rev-parse HEAD`,
          { encoding: 'utf-8', timeout: 3000 }).trim();
      } catch {} // Repo may not exist, have no commits, or not be a git repo

      // Write session metadata
      fs.writeFileSync(
        path.join(signalDir, "session.json"),
        JSON.stringify({
          projectName,
          sessionName,
          startedAt: new Date().toISOString(),
          headBefore,
          prompt: resumePrompt.substring(0, 200),
          status: "running",
        }, null, 2)
      );

      return { success: true, message: `Started session for ${projectName}` };
    } catch (e) {
      return { success: false, message: `Failed to start: ${e.message}` };
    }
  }

  /**
   * Stop a Claude Code session
   * @param {string} projectName
   * @returns {{ success: boolean, message: string }}
   */
  stopSession(projectName) {
    const sessionName = this._sessionName(projectName);

    if (!this._tmuxSessionExists(sessionName)) {
      return { success: false, message: `No running session for ${projectName}` };
    }

    try {
      // Send Ctrl-C then kill the session
      execSync(`tmux send-keys -t "${sessionName}" C-c`, { timeout: 5000 });
      // Give it a moment to clean up
      execSync("sleep 2");
      try {
        execSync(`tmux kill-session -t "${sessionName}"`, { timeout: 5000 });
      } catch {
        // Session may have already ended
      }

      // Update signal file
      const signalDir = path.join(this.projectsDir, projectName, ".orchestrator");
      const sessionFile = path.join(signalDir, "session.json");
      if (fs.existsSync(sessionFile)) {
        const data = JSON.parse(fs.readFileSync(sessionFile, "utf-8"));
        data.status = "stopped";
        data.stoppedAt = new Date().toISOString();
        fs.writeFileSync(sessionFile, JSON.stringify(data, null, 2));
      }

      return { success: true, message: `Stopped session for ${projectName}` };
    } catch (e) {
      return { success: false, message: `Error stopping: ${e.message}` };
    }
  }

  /**
   * Restart a session (stop + start)
   * @param {string} projectName
   * @param {string} [prompt]
   * @returns {{ success: boolean, message: string }}
   */
  restartSession(projectName, prompt) {
    this.stopSession(projectName);
    return this.startSession(projectName, prompt);
  }

  /**
   * Send input text to a running session's tmux pane
   * @param {string} projectName
   * @param {string} input - Text to type into the session
   * @returns {{ success: boolean, message: string }}
   */
  sendInput(projectName, input) {
    const sessionName = this._sessionName(projectName);

    if (!this._tmuxSessionExists(sessionName)) {
      return { success: false, message: `No running session for ${projectName}` };
    }

    try {
      // Write input to a temp file to avoid escaping issues
      const tmpFile = `/tmp/orch-input-${Date.now()}.txt`;
      fs.writeFileSync(tmpFile, input);
      execSync(`tmux load-buffer "${tmpFile}"`, { timeout: 5000 });
      execSync(`tmux paste-buffer -t "${sessionName}"`, { timeout: 5000 });
      execSync("sleep 1");
      execSync(`tmux send-keys -t "${sessionName}" Enter`, { timeout: 5000 });
      fs.unlinkSync(tmpFile);

      return { success: true, message: `Sent input to ${projectName}` };
    } catch (e) {
      return { success: false, message: `Error sending input: ${e.message}` };
    }
  }

  /**
   * Get all active orchestrator tmux sessions
   * @returns {Object[]} Array of { name, projectName, created }
   */
  getActiveSessions() {
    try {
      const output = execSync(
        'tmux list-sessions -F "#{session_name}|#{session_created}" 2>/dev/null',
        { encoding: "utf-8", timeout: 5000 }
      ).trim();

      if (!output) return [];

      return output
        .split("\n")
        .filter((line) => line.startsWith(this.sessionPrefix))
        .map((line) => {
          const [name, created] = line.split("|");
          const shortName = name.substring(this.sessionPrefix.length);
          return {
            name,
            projectName: this._fullName(shortName),
            created: new Date(parseInt(created) * 1000).toISOString(),
          };
        });
    } catch {
      return [];
    }
  }

  /**
   * Get detailed status of all sessions including signal file data
   * @returns {Object[]}
   */
  getSessionStatuses() {
    const active = this.getActiveSessions();
    return active.map((session) => {
      const signalDir = path.join(this.projectsDir, session.projectName, ".orchestrator");
      const status = { ...session };

      // Check for signal files
      status.needsInput = this._readSignal(signalDir, "needs-input.json");
      status.error = this._readSignal(signalDir, "error.json");
      status.completed = this._readSignal(signalDir, "completed.json");

      // Check session log for recent output
      const logFile = path.join(signalDir, "session.log");
      if (fs.existsSync(logFile)) {
        try {
          const logContent = fs.readFileSync(logFile, "utf-8");
          status.ended = logContent.includes("__ORCH_SESSION_ENDED__");
          // Get last few lines of output
          const lines = logContent.split("\n").filter((l) => l.trim());
          status.lastOutput = lines.slice(-3).join("\n").substring(0, 300);
        } catch {}
      }

      return status;
    });
  }

  /**
   * Build a resume prompt for a project based on its state
   * @param {string} projectName
   * @param {string} projectDir
   * @returns {string}
   */
  _buildResumePrompt(projectName, projectDir) {
    // Check for previous session evaluation (SESS-03)
    let evalContext = '';
    try {
      const evalFile = path.join(projectDir, '.orchestrator', 'evaluation.json');
      if (fs.existsSync(evalFile)) {
        const evalData = JSON.parse(fs.readFileSync(evalFile, 'utf-8'));
        const parts = [
          `Last session scored ${evalData.score}/5 (${evalData.recommendation}).`,
        ];
        if (evalData.accomplishments?.length > 0) {
          parts.push(`Completed: ${evalData.accomplishments.join(', ')}.`);
        }
        if (evalData.failures?.length > 0) {
          parts.push(`Failed: ${evalData.failures.join(', ')}.`);
        }
        parts.push('Continue from where the last session left off.');
        evalContext = parts.join(' ') + '\n\n';
      }
    } catch {} // Eval file may be missing or malformed

    const stateFile = path.join(projectDir, ".planning", "STATE.md");

    // The CLAUDE.md already has the orchestrator signal protocol instructions,
    // so keep the prompt focused on what to actually DO.
    if (fs.existsSync(stateFile)) {
      return (
        evalContext +
        "Resume work on this project. Read .planning/STATE.md for where we left off, " +
        "then continue with the next steps listed there. Work autonomously."
      );
    }

    // No planning state - tell Claude to explore and figure out what to do
    return (
      evalContext +
      `This is the ${projectName} project. Read the existing code, README, and any docs to understand what this project does. ` +
      "Then look at git log and recent changes to understand where work left off. " +
      "Continue any in-progress work, or if everything looks done, check for bugs, missing tests, or improvements. " +
      "Work autonomously."
    );
  }

  /**
   * Read a signal file if it exists
   * @param {string} signalDir
   * @param {string} filename
   * @returns {Object|null}
   */
  _readSignal(signalDir, filename) {
    const filePath = path.join(signalDir, filename);
    try {
      if (!fs.existsSync(filePath)) return null;
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch {
      return null;
    }
  }

  /**
   * Clear stale signal files from a previous session
   * @param {string} signalDir
   */
  _clearSignals(signalDir) {
    const signalFiles = ["needs-input.json", "error.json", "completed.json"];
    for (const f of signalFiles) {
      const filePath = path.join(signalDir, f);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    // Also clear session log
    const logFile = path.join(signalDir, "session.log");
    if (fs.existsSync(logFile)) fs.unlinkSync(logFile);
  }

  /**
   * Check if a tmux session exists
   * @param {string} sessionName
   * @returns {boolean}
   */
  _tmuxSessionExists(sessionName) {
    try {
      execSync(`tmux has-session -t "${sessionName}" 2>/dev/null`, { timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = SessionManager;
