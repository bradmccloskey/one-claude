const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

/**
 * ProjectScanner - Reads .planning/STATE.md files across all projects
 * and extracts structured status information, git state, and GSD progress.
 */
class ProjectScanner {
  constructor(projectsDir, projectNames, opts = {}) {
    this.projectsDir = projectsDir;
    this.projectNames = projectNames;
    this.metadata = this._loadMetadata();
    this._scanDb = opts.scanDb || null;
  }

  /**
   * Load project metadata from metadata file
   * @returns {Object} Metadata object
   */
  _loadMetadata() {
    const metadataPath = path.join(__dirname, "..", "project-metadata.json");
    try {
      if (fs.existsSync(metadataPath)) {
        return JSON.parse(fs.readFileSync(metadataPath, "utf-8"));
      }
    } catch (err) {
      console.error("Failed to load project metadata:", err.message);
    }
    return {};
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
      projectStatus: (this.metadata[name] && this.metadata[name].testStatus) || null,
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
    // "None", "None.", "None (some note)" all count as no blockers
    const isNone = (s) => /^none\b/i.test(s.trim());

    const blockerSection = content.match(/###\s*Blockers\s*\n([\s\S]*?)(?=\n---|\n##|\n$)/);
    if (blockerSection) {
      const blockerLines = blockerSection[1]
        .split("\n")
        .map((l) => l.replace(/^\s*[-*]\s*/, "").trim())
        .filter((l) => l.length > 0 && !isNone(l));
      parsed.blockers = blockerLines;
    }

    // Also check inline blockers
    const blockerInline = content.match(/\*\*Blockers:\*\*\s*(.+)/);
    if (blockerInline && !isNone(blockerInline[1])) {
      parsed.blockers = parsed.blockers || [];
      parsed.blockers.push(blockerInline[1].trim());
    }

    if (!parsed.blockers) parsed.blockers = [];

    return parsed;
  }

  // ── Git scanning ─────────────────────────────────────────────────────

  /**
   * Get git branch and dirty file count for a project.
   * Uses execSync with timeout to prevent hanging.
   * @param {string} projectDir
   * @returns {{ gitBranch: string|null, dirtyFiles: number, lastCommitAt: string|null, lastCommitMessage: string|null }}
   */
  _scanGit(projectDir) {
    const result = { gitBranch: null, dirtyFiles: 0, lastCommitAt: null, lastCommitMessage: null };
    const opts = { encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] };

    try {
      // Check if git repo
      execSync(`git -C "${projectDir}" rev-parse --is-inside-work-tree`, opts);
    } catch {
      return result; // Not a git repo
    }

    // Branch name
    try {
      let branch = execSync(`git -C "${projectDir}" rev-parse --abbrev-ref HEAD`, opts).trim();
      if (branch === 'HEAD') {
        const hash = execSync(`git -C "${projectDir}" rev-parse --short HEAD`, opts).trim();
        branch = `detached:${hash}`;
      }
      result.gitBranch = branch;
    } catch {}

    // Dirty files count
    try {
      const status = execSync(`git -C "${projectDir}" status --porcelain`, opts).trim();
      result.dirtyFiles = status ? status.split('\n').length : 0;
    } catch {}

    // Last commit info
    try {
      const log = execSync(`git -C "${projectDir}" log --format='%aI|%s' -1`, opts).trim();
      if (log) {
        const pipeIdx = log.indexOf('|');
        if (pipeIdx !== -1) {
          result.lastCommitAt = log.substring(0, pipeIdx);
          result.lastCommitMessage = log.substring(pipeIdx + 1);
        }
      }
    } catch {}

    return result;
  }

  // ── GSD ROADMAP.md parsing ──────────────────────────────────────────

  /**
   * Parse .planning/ROADMAP.md to count total and completed phases.
   * @param {string} projectDir
   * @returns {{ gsdPhasesTotal: number, gsdPhasesComplete: number }}
   */
  _parseGsdRoadmap(projectDir) {
    const roadmapPath = path.join(projectDir, '.planning', 'ROADMAP.md');
    const result = { gsdPhasesTotal: 0, gsdPhasesComplete: 0 };

    try {
      if (!fs.existsSync(roadmapPath)) return result;
      const content = fs.readFileSync(roadmapPath, 'utf-8');

      // Count total phases: "## Phase N" or "### Phase N" headings
      const phaseHeadings = content.match(/^#{2,3} Phase \d+/gm) || [];
      result.gsdPhasesTotal = phaseHeadings.length;

      // Strategy 1: Progress tracking table with "Complete" status
      const tableComplete = content.match(
        /\|\s*\d+\s*-[^|]+\|\s*\*?\*?Complete\*?\*?\s*\|/gm
      ) || [];

      if (tableComplete.length > 0) {
        result.gsdPhasesComplete = tableComplete.length;
      } else {
        // Strategy 2: "**Status:** Complete" within phase sections
        const sections = content.split(/^#{2,3} Phase \d+/gm);
        for (let i = 1; i < sections.length; i++) {
          const section = sections[i];
          if (
            /\*\*Status:\*\*\s*Complete/i.test(section) ||
            /\bStatus:\s*Complete\b/i.test(section) ||
            /\bCOMPLETE\b/.test(section.split(/^#{2,3} /m)[0] || section)
          ) {
            result.gsdPhasesComplete++;
          }
        }
      }

      result.gsdPhasesComplete = Math.min(result.gsdPhasesComplete, result.gsdPhasesTotal);
    } catch {}

    return result;
  }

  // ── Enriched scan with DB persistence ───────────────────────────────

  /**
   * Perform an enriched scan of all projects (STATE.md + git + GSD)
   * and persist results to the scan database.
   * @returns {Object[]} Enriched project status objects
   */
  scanAllEnriched() {
    const projects = this.scanAll();
    const scanRecords = [];

    for (const project of projects) {
      if (!project.exists) continue;

      // Git data
      const git = this._scanGit(project.path);
      project.gitBranch = git.gitBranch;
      project.dirtyFiles = git.dirtyFiles;
      project.lastCommitAt = git.lastCommitAt;
      project.lastCommitMessage = git.lastCommitMessage;

      // GSD ROADMAP.md data
      const gsd = this._parseGsdRoadmap(project.path);
      project.gsdPhasesTotal = gsd.gsdPhasesTotal;
      project.gsdPhasesComplete = gsd.gsdPhasesComplete;

      scanRecords.push({
        projectName: project.name,
        gitBranch: git.gitBranch,
        lastCommitAt: git.lastCommitAt,
        lastCommitMessage: git.lastCommitMessage,
        dirtyFiles: git.dirtyFiles,
        gsdPhasesTotal: gsd.gsdPhasesTotal,
        gsdPhasesComplete: gsd.gsdPhasesComplete,
      });
    }

    // Persist to DB
    if (this._scanDb && scanRecords.length > 0) {
      try {
        this._scanDb.insertMany(scanRecords);
      } catch (err) {
        console.error('[SCANNER] DB write error:', err.message);
      }
    }

    return projects;
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

    // Status suggests waiting — but not if the project is fully complete (100%, all phases done)
    const isFullyDone = result.progress >= 100 ||
      (result.phase && result.totalPhases && result.phase >= result.totalPhases &&
       (result.status || "").toLowerCase().match(/complete|shipped|done|live/));
    if (!isFullyDone) {
      const waitingStatuses = ["ready for execution", "ready for testing", "waiting", "needs input", "paused"];
      if (result.status && waitingStatuses.some((s) => result.status.toLowerCase().includes(s))) {
        result.needsAttention = true;
        result.attentionReason = `Status: ${result.status}`;
        return;
      }
    }

    // All phases complete — don't flag. Completed projects are done.
    // If the user wants to revisit, they'll do it manually or via v2 planning.
  }
}

module.exports = ProjectScanner;
