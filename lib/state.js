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
        aiDecisionHistory: [],
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

  /**
   * Log an AI brain decision to the decision history.
   * Trims history to the last 50 entries to prevent unbounded growth.
   * @param {Object} state - Current state object
   * @param {Object} decision - Decision record
   * @param {string} decision.timestamp - ISO timestamp
   * @param {number} [decision.prompt_length] - Length of prompt sent
   * @param {string} [decision.response_raw] - First 500 chars of raw response
   * @param {Array} [decision.recommendations] - Parsed recommendations
   * @param {string} [decision.summary] - AI summary
   * @param {number} [decision.duration_ms] - Think cycle duration
   * @param {string} [decision.error] - Error type if failed
   */
  logDecision(state, decision) {
    if (!state.aiDecisionHistory) state.aiDecisionHistory = [];
    state.aiDecisionHistory.push(decision);
    // Keep only the last 50 entries
    if (state.aiDecisionHistory.length > 50) {
      state.aiDecisionHistory = state.aiDecisionHistory.slice(-50);
    }
    this.save(state);
  }

  /**
   * Get the most recent AI decisions from history.
   * @param {Object} state - Current state object
   * @param {number} [count=5] - Number of recent decisions to return
   * @returns {Array} Last N decision entries
   */
  getRecentDecisions(state, count = 5) {
    const history = state.aiDecisionHistory || [];
    return history.slice(-count);
  }
}

module.exports = StateManager;
