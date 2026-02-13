const fs = require("fs");
const path = require("path");

/**
 * ProjectScanner - Reads .planning/STATE.md files across all projects
 * and extracts structured status information.
 */
class ProjectScanner {
  constructor(projectsDir, projectNames) {
    this.projectsDir = projectsDir;
    this.projectNames = projectNames;
  }

  /**
   * Scan all configured projects and return their status
   * @returns {Object[]} Array of project status objects
   */
  scanAll() {
    return this.projectNames.map((name) => this.scanProject(name));
  }

  /**
   * Scan a single project for its current state
   * @param {string} name - Project directory name
   * @returns {Object} Project status object
   */
  scanProject(name) {
    const projectDir = path.join(this.projectsDir, name);
    const stateFile = path.join(projectDir, ".planning", "STATE.md");
    const projectFile = path.join(projectDir, ".planning", "PROJECT.md");

    const result = {
      name,
      path: projectDir,
      exists: fs.existsSync(projectDir),
      hasPlanning: false,
      hasState: false,
      phase: null,
      totalPhases: null,
      status: null,
      progress: null,
      blockers: [],
      nextSteps: [],
      lastActivity: null,
      coreValue: null,
      currentFocus: null,
      needsAttention: false,
      attentionReason: null,
    };

    if (!result.exists) return result;

    result.hasPlanning = fs.existsSync(path.join(projectDir, ".planning"));
    if (!result.hasPlanning) return result;

    // Parse STATE.md
    if (fs.existsSync(stateFile)) {
      result.hasState = true;
      const content = fs.readFileSync(stateFile, "utf-8");
      Object.assign(result, this._parseStateMd(content));
    }

    // Extract core value from PROJECT.md if available
    if (fs.existsSync(projectFile)) {
      const content = fs.readFileSync(projectFile, "utf-8");
      const coreMatch = content.match(/\*\*Core Value:\*\*\s*(.+)/);
      if (coreMatch) result.coreValue = coreMatch[1].trim();
    }

    // Determine if project needs attention
    this._assessAttention(result);

    return result;
  }

  /**
   * Parse a STATE.md file and extract structured fields
   * @param {string} content - Raw markdown content
   * @returns {Object} Parsed fields
   */
  _parseStateMd(content) {
    const parsed = {};

    // Phase: "1 of 4 (Foundation Refactor)" or "4 - Scoring Visualization (Planned)" or "6 of 6 (ALL COMPLETE)"
    const phaseMatch = content.match(/\*\*Phase:\*\*\s*(\d+)\s*(?:of\s*(\d+))?\s*(?:[-(]\s*(.+?))?[\s)]*$/m);
    if (phaseMatch) {
      parsed.phase = parseInt(phaseMatch[1]);
      parsed.totalPhases = phaseMatch[2] ? parseInt(phaseMatch[2]) : null;
      parsed.phaseName = phaseMatch[3] ? phaseMatch[3].replace(/[()]+$/g, "").trim() : null;
    }

    // Status
    const statusMatch = content.match(/\*\*Status:\*\*\s*(.+)/);
    if (statusMatch) parsed.status = statusMatch[1].trim();

    // Progress percentage - try multiple patterns
    const progressPctMatch = content.match(/(\d+(?:\.\d+)?)\s*%/);
    if (progressPctMatch) parsed.progress = parseFloat(progressPctMatch[1]);

    // Phase progress like "3/5 phases complete"
    const phaseProgressMatch = content.match(/(\d+)\/(\d+)\s*phases?\s*complete/i);
    if (phaseProgressMatch && !parsed.totalPhases) {
      parsed.totalPhases = parseInt(phaseProgressMatch[2]);
    }

    // Last activity
    const activityMatch = content.match(/\*\*Last activity:\*\*\s*(.+)/);
    if (activityMatch) parsed.lastActivity = activityMatch[1].trim();

    // Last session (alternative)
    const sessionMatch = content.match(/\*\*Last [Ss]ession:\*\*\s*(.+)/);
    if (sessionMatch && !parsed.lastActivity) parsed.lastActivity = sessionMatch[1].trim();

    // Current Focus
    const focusMatch = content.match(/\*\*Current Focus:\*\*\s*(.+)/);
    if (focusMatch) parsed.currentFocus = focusMatch[1].trim();

    // Next Steps - look for numbered list after "Next Steps" or "What's Next"
    const nextMatch = content.match(/\*\*(?:Next Steps|What's Next|Next Action):\*\*\s*([\s\S]*?)(?=\n---|\n##|\n\*\*[A-Z]|\n$)/);
    if (nextMatch) {
      parsed.nextSteps = nextMatch[1]
        .split("\n")
        .map((l) => l.replace(/^\s*[-\d.]+\s*/, "").trim())
        .filter((l) => l.length > 0);
    }

    // Blockers - look in ### Blockers section or **Blockers:** field
    const blockerSection = content.match(/###\s*Blockers\s*\n([\s\S]*?)(?=\n---|\n##|\n$)/);
    if (blockerSection) {
      const blockerLines = blockerSection[1]
        .split("\n")
        .map((l) => l.replace(/^\s*[-*]\s*/, "").trim())
        .filter((l) => l.length > 0 && !l.toLowerCase().match(/^none\.?$/));
      parsed.blockers = blockerLines;
    }

    // Also check inline blockers
    const blockerInline = content.match(/\*\*Blockers:\*\*\s*(.+)/);
    if (blockerInline && blockerInline[1].trim().toLowerCase() !== "none") {
      parsed.blockers = parsed.blockers || [];
      parsed.blockers.push(blockerInline[1].trim());
    }

    if (!parsed.blockers) parsed.blockers = [];

    return parsed;
  }

  /**
   * Determine if a project needs user attention and why
   * @param {Object} result - Project status object (mutated in place)
   */
  _assessAttention(result) {
    // Has explicit blockers
    if (result.blockers.length > 0) {
      result.needsAttention = true;
      result.attentionReason = `Blocked: ${result.blockers[0]}`;
      return;
    }

    // Status suggests waiting
    const waitingStatuses = ["ready for execution", "ready for testing", "waiting", "needs input", "paused"];
    if (result.status && waitingStatuses.some((s) => result.status.toLowerCase().includes(s))) {
      result.needsAttention = true;
      result.attentionReason = `Status: ${result.status}`;
      return;
    }

    // All phases complete - may need testing or deployment
    if (result.phase && result.totalPhases && result.phase >= result.totalPhases) {
      const status = (result.status || "").toLowerCase();
      if (status.includes("complete") || status.includes("testing")) {
        result.needsAttention = true;
        result.attentionReason = "All phases complete - needs testing/review";
      }
    }
  }
}

module.exports = ProjectScanner;
