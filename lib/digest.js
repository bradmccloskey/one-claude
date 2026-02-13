/**
 * DigestFormatter - Formats project status data into clean, human-readable texts
 */
class DigestFormatter {
  /**
   * Format a full morning digest of all projects
   */
  formatMorningDigest(projects, processStatus) {
    const lines = ["Good morning! Here's your project update:"];

    // Projects that need attention first
    const attention = projects.filter((p) => p.needsAttention);
    if (attention.length > 0) {
      lines.push("");
      lines.push("Needs your attention:");
      for (const p of attention) {
        const running = processStatus[p.name]?.running ? ", session running" : "";
        lines.push(`- ${p.name}${running}`);
        lines.push(`  ${p.attentionReason}`);
      }
    }

    // Active projects (have state, in progress)
    const active = projects.filter(
      (p) => p.hasState && !p.needsAttention && p.status && !p.status.toLowerCase().includes("complete")
    );
    if (active.length > 0) {
      lines.push("");
      lines.push("In progress:");
      for (const p of active) {
        const pct = p.progress != null ? ` (${p.progress}%)` : "";
        const phase = p.phase && p.totalPhases ? ` phase ${p.phase}/${p.totalPhases}` : "";
        const running = processStatus[p.name]?.running ? " *running*" : "";
        lines.push(`- ${p.name}${pct}${phase}${running}`);
      }
    }

    // Completed projects
    const completed = projects.filter(
      (p) => p.hasState && p.status && p.status.toLowerCase().includes("complete") && !p.needsAttention
    );
    if (completed.length > 0) {
      lines.push("");
      lines.push("Done: " + completed.map((p) => p.name).join(", "));
    }

    // Summary
    const totalRunning = Object.values(processStatus).filter((s) => s.running).length;
    lines.push("");
    lines.push(`${projects.length} projects, ${totalRunning} active sessions, ${attention.length} need attention`);

    return lines.join("\n");
  }

  /**
   * Format a detailed status for a single project
   */
  formatProjectDetail(project, processInfo) {
    if (!project.exists) {
      return `${project.name}: project directory not found`;
    }

    if (!project.hasState) {
      const running = processInfo?.running ? "Session running" : "No session";
      return `${project.name}: no planning state found. ${running}`;
    }

    const lines = [project.name];

    if (project.status) lines.push(`Status: ${project.status}`);

    if (project.phase && project.totalPhases) {
      const name = project.phaseName ? ` - ${project.phaseName}` : "";
      lines.push(`Phase ${project.phase} of ${project.totalPhases}${name}`);
    }

    if (project.progress != null) {
      lines.push(`Progress: ${project.progress}%`);
    }

    if (processInfo?.running) {
      const activity = processInfo.hasRecentOutput ? "active" : "idle";
      lines.push(`Session: running (${activity})`);
    } else {
      lines.push("Session: not running");
    }

    if (project.blockers.length > 0) {
      lines.push("");
      lines.push("Blocked on:");
      for (const b of project.blockers) {
        lines.push(`- ${b}`);
      }
    }

    if (project.nextSteps.length > 0) {
      lines.push("");
      lines.push("Next up:");
      for (const step of project.nextSteps.slice(0, 3)) {
        lines.push(`- ${step}`);
      }
    }

    if (project.lastActivity) {
      lines.push("");
      lines.push(`Last active: ${project.lastActivity}`);
    }

    return lines.join("\n");
  }

  /**
   * Format a priority summary
   */
  formatPriority(projects, processStatus) {
    const attention = projects
      .filter((p) => p.needsAttention)
      .sort((a, b) => {
        if (a.blockers.length > 0 && b.blockers.length === 0) return -1;
        if (b.blockers.length > 0 && a.blockers.length === 0) return 1;
        return 0;
      });

    if (attention.length === 0) {
      return "Nothing needs your attention right now. All projects are progressing on their own.";
    }

    const lines = ["Priority items:"];
    for (let i = 0; i < attention.length; i++) {
      const p = attention[i];
      const running = processStatus[p.name]?.running ? "running" : "stopped";
      lines.push("");
      lines.push(`${i + 1}. ${p.name} (${running})`);
      lines.push(`   ${p.attentionReason}`);
      if (p.nextSteps.length > 0) {
        lines.push(`   Next: ${p.nextSteps[0]}`);
      }
    }

    return lines.join("\n");
  }
}

module.exports = DigestFormatter;
