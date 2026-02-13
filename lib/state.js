const fs = require("fs");
const path = require("path");

/**
 * StateManager - Persists orchestrator runtime state to disk.
 * Tracks last message ROWID, last scan results, and alert history.
 */
class StateManager {
  constructor(stateFile = path.join(__dirname, "..", ".state.json")) {
    this.stateFile = stateFile;
  }

  load() {
    try {
      return JSON.parse(fs.readFileSync(this.stateFile, "utf-8"));
    } catch {
      return {
        lastRowId: 0,
        lastScan: null,
        lastDigest: null,
        alertHistory: {},
      };
    }
  }

  save(state) {
    fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
  }

  /**
   * Record that an alert was sent for a project, to avoid spamming
   * @param {Object} state - Current state
   * @param {string} projectName
   * @param {string} reason
   */
  recordAlert(state, projectName, reason) {
    if (!state.alertHistory) state.alertHistory = {};
    state.alertHistory[projectName] = {
      reason,
      timestamp: new Date().toISOString(),
    };
    this.save(state);
  }

  /**
   * Check if we recently alerted about this project (within cooldown)
   * @param {Object} state
   * @param {string} projectName
   * @param {number} cooldownMs - Minimum ms between alerts (default 1 hour)
   * @returns {boolean}
   */
  wasRecentlyAlerted(state, projectName, cooldownMs = 3600000) {
    const lastAlert = state.alertHistory?.[projectName];
    if (!lastAlert) return false;
    return Date.now() - new Date(lastAlert.timestamp).getTime() < cooldownMs;
  }
}

module.exports = StateManager;
