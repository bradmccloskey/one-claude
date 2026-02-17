const fs = require("fs");
const path = require("path");

/**
 * StateManager - Persists orchestrator runtime state to disk.
 * Tracks last message ROWID, last scan results, alert history,
 * state versioning, execution history, error retry counts, and runtime autonomy level.
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
        stateVersion: 0,
        executionHistory: [],
        errorRetryCounts: {},
        runtimeAutonomyLevel: null,
        evaluationHistory: [],
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

  // --- Phase 2: State Version Tracking ---

  /**
   * Increment the state version counter and save.
   * Used for optimistic locking -- correlate AI decisions with the state snapshot they saw.
   * @param {Object} state - Current state object
   * @returns {number} The new state version
   */
  incrementVersion(state) {
    state.stateVersion = (state.stateVersion || 0) + 1;
    this.save(state);
    return state.stateVersion;
  }

  // --- Phase 2: Execution History ---

  /**
   * Log an execution record to the history.
   * Trims to last 100 entries to prevent unbounded growth.
   * @param {Object} state - Current state object
   * @param {Object} executionRecord - Record to log
   * @param {string} executionRecord.timestamp - ISO timestamp
   * @param {string} executionRecord.action - Action taken (start, stop, restart, notify, skip)
   * @param {string} executionRecord.project - Project name
   * @param {*} [executionRecord.result] - Result of the action
   * @param {string} [executionRecord.autonomyLevel] - Autonomy level when action was taken
   * @param {number} [executionRecord.stateVersion] - State version at time of action
   */
  logExecution(state, executionRecord) {
    if (!state.executionHistory) state.executionHistory = [];
    state.executionHistory.push(executionRecord);
    // Keep only the last 100 entries
    if (state.executionHistory.length > 100) {
      state.executionHistory = state.executionHistory.slice(-100);
    }
    this.save(state);
  }

  // --- Phase 2: Error Retry Counts ---

  /**
   * Record an error retry attempt for a project.
   * @param {Object} state - Current state object
   * @param {string} project - Project name
   * @returns {number} Current retry count after increment
   */
  recordErrorRetry(state, project) {
    if (!state.errorRetryCounts) state.errorRetryCounts = {};
    state.errorRetryCounts[project] = (state.errorRetryCounts[project] || 0) + 1;
    this.save(state);
    return state.errorRetryCounts[project];
  }

  /**
   * Get the current error retry count for a project.
   * @param {Object} state - Current state object
   * @param {string} project - Project name
   * @returns {number} Current retry count (0 if none)
   */
  getErrorRetryCount(state, project) {
    return state.errorRetryCounts?.[project] || 0;
  }

  /**
   * Clear error retry count for a project (e.g., after successful session).
   * @param {Object} state - Current state object
   * @param {string} project - Project name
   */
  clearErrorRetries(state, project) {
    if (state.errorRetryCounts) {
      delete state.errorRetryCounts[project];
      this.save(state);
    }
  }

  // --- Phase 4: Session Evaluation History ---

  /**
   * Log an evaluation record to the evaluation history.
   * Trims to last 100 entries to prevent unbounded growth.
   * @param {Object} state - Current state object
   * @param {Object} evaluation - Evaluation record from SessionEvaluator
   */
  logEvaluation(state, evaluation) {
    if (!state.evaluationHistory) state.evaluationHistory = [];
    state.evaluationHistory.push(evaluation);
    if (state.evaluationHistory.length > 100) {
      state.evaluationHistory = state.evaluationHistory.slice(-100);
    }
    this.save(state);
  }

  /**
   * Get the most recent session evaluations from history.
   * @param {Object} state - Current state object
   * @param {number} [count=5] - Number of recent evaluations to return
   * @returns {Array} Last N evaluation entries
   */
  getRecentEvaluations(state, count = 5) {
    return (state.evaluationHistory || []).slice(-count);
  }

  // --- Phase 2: Runtime Autonomy Level ---

  /**
   * Valid autonomy levels for runtime override.
   * @type {string[]}
   */
  static AUTONOMY_LEVELS = ["observe", "cautious", "moderate", "full"];

  /**
   * Set the runtime autonomy level override.
   * Persists to state so it survives orchestrator restarts.
   * @param {Object} state - Current state object
   * @param {string} level - One of: 'observe', 'cautious', 'moderate', 'full'
   * @returns {string} The set level
   * @throws {Error} If level is not valid
   */
  setAutonomyLevel(state, level) {
    if (!StateManager.AUTONOMY_LEVELS.includes(level)) {
      throw new Error(
        `Invalid autonomy level '${level}'. Must be one of: ${StateManager.AUTONOMY_LEVELS.join(", ")}`
      );
    }
    state.runtimeAutonomyLevel = level;
    this.save(state);
    return level;
  }

  /**
   * Get the effective autonomy level.
   * Runtime override takes precedence over config default.
   * @param {Object} state - Current state object
   * @param {Object} config - Config object (reads ai.autonomyLevel)
   * @returns {string} The effective autonomy level
   */
  getAutonomyLevel(state, config) {
    return state.runtimeAutonomyLevel || config.ai?.autonomyLevel || "observe";
  }
}

module.exports = StateManager;
