const fs = require("fs");
const path = require("path");

/**
 * SignalProtocol - Manages the file-based communication protocol between
 * the orchestrator and Claude Code sessions.
 *
 * Protocol:
 *   .orchestrator/needs-input.json - Session needs human input
 *   .orchestrator/completed.json   - Session completed its work
 *   .orchestrator/error.json       - Session hit an unrecoverable error
 *   .orchestrator/session.json     - Session metadata (managed by session-manager)
 *   .orchestrator/session.log      - Session stdout log
 */

const ORCHESTRATOR_CLAUDE_MD = `
# Orchestrator Integration

You are running as a managed session under the Project Orchestrator.
Follow these rules for autonomous operation:

## Autonomous Work
- Work independently without asking for confirmation on routine tasks
- Follow existing .planning/STATE.md and ROADMAP.md for what to do next
- Make commits as you complete work
- Update .planning/STATE.md when you complete phases or milestones

## When You Need Human Input
If you encounter something that TRULY requires human decision-making (not routine coding):
- Architecture decisions with major trade-offs
- Ambiguous requirements where you could go multiple valid directions
- External service credentials or access you don't have
- A blocker you cannot work around

Write this file and then STOP:
\`\`\`
// .orchestrator/needs-input.json
{
  "question": "Clear, specific question for the human",
  "context": "Brief context about what you were doing",
  "options": ["Option A", "Option B"],  // optional
  "timestamp": "<ISO timestamp>"
}
\`\`\`

## When You Complete Work
When you finish all planned work for the current phase or milestone:
\`\`\`
// .orchestrator/completed.json
{
  "summary": "What was accomplished",
  "phase": "Phase name/number completed",
  "nextSteps": "What should happen next",
  "timestamp": "<ISO timestamp>"
}
\`\`\`

## When You Hit an Error
If you encounter an unrecoverable error after multiple attempts:
\`\`\`
// .orchestrator/error.json
{
  "error": "Description of the error",
  "context": "What you were trying to do",
  "attempts": "What you tried",
  "timestamp": "<ISO timestamp>"
}
\`\`\`

## Important
- Do NOT write signal files for routine questions you can answer yourself
- Do NOT stop working just because one task failed - move to the next task if possible
- DO update .planning/STATE.md as you work so the orchestrator can track progress
- The human will respond via the orchestrator when they see your signal
`.trim();

class SignalProtocol {
  constructor(projectsDir) {
    this.projectsDir = projectsDir;
  }

  /**
   * Ensure a project has the orchestrator CLAUDE.md instructions
   * Appends to existing CLAUDE.md or creates one
   * @param {string} projectName
   */
  injectClaudeMd(projectName) {
    const projectDir = path.join(this.projectsDir, projectName);
    const claudeMdPath = path.join(projectDir, "CLAUDE.md");
    const marker = "# Orchestrator Integration";

    if (fs.existsSync(claudeMdPath)) {
      const existing = fs.readFileSync(claudeMdPath, "utf-8");
      if (existing.includes(marker)) return; // Already injected
      fs.writeFileSync(claudeMdPath, existing + "\n\n" + ORCHESTRATOR_CLAUDE_MD);
    } else {
      fs.writeFileSync(claudeMdPath, ORCHESTRATOR_CLAUDE_MD);
    }
  }

  /**
   * Remove orchestrator instructions from a project's CLAUDE.md
   * @param {string} projectName
   */
  removeClaudeMd(projectName) {
    const claudeMdPath = path.join(this.projectsDir, projectName, "CLAUDE.md");
    if (!fs.existsSync(claudeMdPath)) return;

    const content = fs.readFileSync(claudeMdPath, "utf-8");
    const marker = "# Orchestrator Integration";
    const idx = content.indexOf(marker);
    if (idx === -1) return;

    const cleaned = content.substring(0, idx).trimEnd();
    if (cleaned.length === 0) {
      fs.unlinkSync(claudeMdPath);
    } else {
      fs.writeFileSync(claudeMdPath, cleaned + "\n");
    }
  }

  /**
   * Scan all projects for signal files
   * @param {string[]} projectNames
   * @returns {Object[]} Array of { projectName, type, data }
   */
  scanSignals(projectNames) {
    const signals = [];

    for (const name of projectNames) {
      const signalDir = path.join(this.projectsDir, name, ".orchestrator");
      if (!fs.existsSync(signalDir)) continue;

      for (const type of ["needs-input", "completed", "error"]) {
        const file = path.join(signalDir, `${type}.json`);
        if (fs.existsSync(file)) {
          try {
            const data = JSON.parse(fs.readFileSync(file, "utf-8"));
            signals.push({ projectName: name, type, data });
          } catch {}
        }
      }
    }

    return signals;
  }

  /**
   * Acknowledge and clear a signal (after user has been notified)
   * @param {string} projectName
   * @param {string} type - "needs-input", "completed", or "error"
   */
  clearSignal(projectName, type) {
    const file = path.join(this.projectsDir, projectName, ".orchestrator", `${type}.json`);
    if (fs.existsSync(file)) {
      // Archive to .orchestrator/history/
      const historyDir = path.join(this.projectsDir, projectName, ".orchestrator", "history");
      if (!fs.existsSync(historyDir)) fs.mkdirSync(historyDir, { recursive: true });
      const archiveName = `${type}-${Date.now()}.json`;
      fs.renameSync(file, path.join(historyDir, archiveName));
    }
  }

  /**
   * Format a signal into a notification message
   * @param {Object} signal - { projectName, type, data }
   * @returns {string}
   */
  formatSignalNotification(signal) {
    const lines = [];

    switch (signal.type) {
      case "needs-input":
        lines.push(`${signal.projectName} needs your input:`);
        lines.push("");
        lines.push(signal.data.question || "No question specified");
        if (signal.data.context) {
          lines.push("");
          lines.push(signal.data.context);
        }
        if (signal.data.options?.length > 0) {
          lines.push("");
          signal.data.options.forEach((opt, i) => lines.push(`${i + 1}. ${opt}`));
        }
        lines.push("");
        lines.push(`To answer: reply ${signal.projectName}: your answer`);
        break;

      case "completed":
        lines.push(`${signal.projectName} finished its work.`);
        lines.push("");
        lines.push(signal.data.summary || "Work completed");
        if (signal.data.nextSteps) {
          lines.push("");
          lines.push(`Next: ${signal.data.nextSteps}`);
        }
        break;

      case "error":
        lines.push(`${signal.projectName} hit an error:`);
        lines.push("");
        lines.push(signal.data.error || "Unknown error");
        if (signal.data.context) {
          lines.push(`Was trying to: ${signal.data.context}`);
        }
        break;
    }

    return lines.join("\n");
  }
}

module.exports = { SignalProtocol, ORCHESTRATOR_CLAUDE_MD };
