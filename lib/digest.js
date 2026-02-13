/**
 * DigestFormatter - Formats project status data into SMS-friendly summaries
 */
class DigestFormatter {
  /**
   * Format a full morning digest of all projects
   * @param {Object[]} projects - Array of project status objects from scanner
   * @param {Object} processStatus - Map of project -> { running, pid } from process monitor
   * @returns {string} Formatted digest text
   */
  formatMorningDigest(projects, processStatus) {
    const lines = ["/orchestrator", "MORNING DIGEST", ""];

    // Projects that need attention first
    const attention = projects.filter((p) => p.needsAttention);
    if (attention.length > 0) {
      lines.push("NEEDS YOUR ATTENTION:");
      for (const p of attention) {
        const running = processStatus[p.name]?.running ? "running" : "stopped";
        lines.push(`  ${p.name} [${running}]`);
        lines.push(`    ${p.attentionReason}`);
      }
      lines.push("");
    }

    // Active projects (have state, in progress)
    const active = projects.filter(
      (p) => p.hasState && !p.needsAttention && p.status && !p.status.toLowerCase().includes("complete")
    );
    if (active.length > 0) {
      lines.push("IN PROGRESS:");
      for (const p of active) {
        const pct = p.progress != null ? `${p.progress}%` : "?%";
        const running = processStatus[p.name]?.running ? "running" : "stopped";
        const phase = p.phase && p.totalPhases ? `Ph ${p.phase}/${p.totalPhases}` : "";
        lines.push(`  ${p.name} ${pct} ${phase} [${running}]`);
      }
      lines.push("");
    }

    // Completed projects
    const completed = projects.filter(
      (p) => p.hasState && p.status && p.status.toLowerCase().includes("complete") && !p.needsAttention
    );
    if (completed.length > 0) {
      lines.push("COMPLETE:");
      for (const p of completed) {
        lines.push(`  ${p.name}`);
      }
      lines.push("");
    }

    // Projects without planning
    const noPlanning = projects.filter((p) => p.exists && !p.hasPlanning);
    if (noPlanning.length > 0) {
      lines.push(`NO STATE: ${noPlanning.map((p) => p.name).join(", ")}`);
    }

    // Summary line
    const totalRunning = Object.values(processStatus).filter((s) => s.running).length;
    lines.push("");
    lines.push(`${projects.length} projects | ${totalRunning} sessions active | ${attention.length} need attention`);

    return lines.join("\n");
  }

  /**
   * Format a detailed status for a single project
   * @param {Object} project - Project status object
   * @param {Object} processInfo - { running, pid, hasRecentOutput }
   * @returns {string}
   */
  formatProjectDetail(project, processInfo) {
    const lines = [`/orchestrator`, `PROJECT: ${project.name}`, ""];

    if (!project.exists) {
      lines.push("Project directory not found.");
      return lines.join("\n");
    }

    if (!project.hasState) {
      const running = processInfo?.running ? "Claude session running" : "No Claude session";
      lines.push(`No .planning/STATE.md found`);
      lines.push(running);
      return lines.join("\n");
    }

    // Status line
    if (project.status) lines.push(`Status: ${project.status}`);

    // Phase info
    if (project.phase && project.totalPhases) {
      lines.push(`Phase: ${project.phase} of ${project.totalPhases}${project.phaseName ? ` (${project.phaseName})` : ""}`);
    }

    // Progress
    if (project.progress != null) {
      const bar = this._progressBar(project.progress);
      lines.push(`Progress: ${bar} ${project.progress}%`);
    }

    // Process status
    if (processInfo?.running) {
      const activity = processInfo.hasRecentOutput ? "active" : "idle";
      lines.push(`Claude: running (${activity}), PID ${processInfo.pid}`);
    } else {
      lines.push("Claude: no session");
    }

    // Blockers
    if (project.blockers.length > 0) {
      lines.push("");
      lines.push("BLOCKERS:");
      for (const b of project.blockers) {
        lines.push(`  - ${b}`);
      }
    }

    // Next steps
    if (project.nextSteps.length > 0) {
      lines.push("");
      lines.push("NEXT:");
      for (const step of project.nextSteps.slice(0, 3)) {
        lines.push(`  - ${step}`);
      }
    }

    // Last activity
    if (project.lastActivity) {
      lines.push("");
      lines.push(`Last activity: ${project.lastActivity}`);
    }

    return lines.join("\n");
  }

  /**
   * Format a priority summary - what needs attention most
   * @param {Object[]} projects - All project statuses
   * @param {Object} processStatus - Process status map
   * @returns {string}
   */
  formatPriority(projects, processStatus) {
    const lines = ["/orchestrator", "PRIORITY ITEMS:", ""];

    const attention = projects
      .filter((p) => p.needsAttention)
      .sort((a, b) => {
        // Blockers first, then ready-for-execution, then complete-needs-testing
        if (a.blockers.length > 0 && b.blockers.length === 0) return -1;
        if (b.blockers.length > 0 && a.blockers.length === 0) return 1;
        return 0;
      });

    if (attention.length === 0) {
      lines.push("Nothing needs your attention right now.");
      lines.push("All active projects are progressing autonomously.");
      return lines.join("\n");
    }

    for (let i = 0; i < attention.length; i++) {
      const p = attention[i];
      const running = processStatus[p.name]?.running ? "running" : "stopped";
      lines.push(`${i + 1}. ${p.name} [${running}]`);
      lines.push(`   ${p.attentionReason}`);
      if (p.nextSteps.length > 0) {
        lines.push(`   Next: ${p.nextSteps[0]}`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  /**
   * Simple ASCII progress bar
   * @param {number} pct - Percentage 0-100
   * @returns {string}
   */
  _progressBar(pct) {
    const filled = Math.round(pct / 10);
    return "[" + "#".repeat(filled) + ".".repeat(10 - filled) + "]";
  }
}

module.exports = DigestFormatter;
