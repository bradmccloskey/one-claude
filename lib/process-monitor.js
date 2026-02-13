const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

/**
 * ProcessMonitor - Detects running Claude Code processes,
 * identifies their working directories, and determines idle state.
 */
class ProcessMonitor {
  constructor(projectsDir, idleThresholdMinutes = 15) {
    this.projectsDir = projectsDir;
    this.idleThresholdMs = idleThresholdMinutes * 60 * 1000;
  }

  /**
   * Get all running Claude Code processes with their working directories
   * @returns {Object[]} Array of { pid, project, cwd, cpuTime, idle }
   */
  getClaudeSessions() {
    try {
      // Find Claude Code node processes
      const psOutput = execSync(
        "ps aux | grep -E 'claude' | grep -v grep | grep -v project-orchestrator",
        { encoding: "utf-8", timeout: 5000 }
      ).trim();

      if (!psOutput) return [];

      const sessions = [];
      const lines = psOutput.split("\n");

      for (const line of lines) {
        const parts = line.split(/\s+/);
        const pid = parseInt(parts[1]);
        if (isNaN(pid)) continue;

        // Get the working directory of the process
        const cwd = this._getProcessCwd(pid);
        if (!cwd) continue;

        // Determine which project this belongs to
        const project = this._matchProject(cwd);

        sessions.push({
          pid,
          cwd,
          project,
          command: parts.slice(10).join(" ").substring(0, 100),
        });
      }

      // Deduplicate by project (keep the main process)
      const byProject = new Map();
      for (const s of sessions) {
        if (s.project && !byProject.has(s.project)) {
          byProject.set(s.project, s);
        }
      }

      return Array.from(byProject.values());
    } catch {
      return [];
    }
  }

  /**
   * Check which projects have active Claude Code sessions
   * @param {string[]} projectNames - List of project names to check
   * @returns {Object} Map of projectName -> { running, pid, idle }
   */
  checkProjects(projectNames) {
    const sessions = this.getClaudeSessions();
    const sessionMap = new Map(sessions.map((s) => [s.project, s]));

    const result = {};
    for (const name of projectNames) {
      const session = sessionMap.get(name);
      if (session) {
        result[name] = {
          running: true,
          pid: session.pid,
          hasRecentOutput: this._hasRecentConversation(name),
        };
      } else {
        result[name] = { running: false, pid: null, hasRecentOutput: false };
      }
    }
    return result;
  }

  /**
   * Check if a project's Claude conversation has had recent activity
   * by looking at .claude/ conversation files
   * @param {string} projectName
   * @returns {boolean}
   */
  _hasRecentConversation(projectName) {
    const claudeDir = path.join(this.projectsDir, projectName, ".claude");
    try {
      if (!fs.existsSync(claudeDir)) return false;

      // Check for recent conversation files
      const files = fs.readdirSync(claudeDir).filter((f) => f.endsWith(".json"));
      const now = Date.now();

      for (const file of files) {
        const stat = fs.statSync(path.join(claudeDir, file));
        if (now - stat.mtimeMs < this.idleThresholdMs) {
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Get the current working directory of a process
   * @param {number} pid
   * @returns {string|null}
   */
  _getProcessCwd(pid) {
    try {
      // macOS: use lsof to find cwd
      const output = execSync(`lsof -p ${pid} -Fn 2>/dev/null | grep '^n/' | head -1`, {
        encoding: "utf-8",
        timeout: 3000,
      }).trim();
      return output ? output.substring(1) : null;
    } catch {
      return null;
    }
  }

  /**
   * Match a cwd path to a known project name
   * @param {string} cwd
   * @returns {string|null}
   */
  _matchProject(cwd) {
    if (!cwd.startsWith(this.projectsDir)) return null;
    const relative = cwd.substring(this.projectsDir.length + 1);
    const projectName = relative.split("/")[0];
    return projectName || null;
  }
}

module.exports = ProcessMonitor;
