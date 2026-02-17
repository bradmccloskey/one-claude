const os = require("os");

/**
 * DecisionExecutor - Validates, gates, and executes AI brain recommendations
 * with safety guardrails.
 *
 * Phase 2: Full execution engine. Dispatches validated actions to sessionManager
 * methods, gated by the autonomy level matrix. Includes just-in-time precondition
 * checks, error retry tracking, and execution logging.
 */
class DecisionExecutor {
  /**
   * Allowed actions the AI brain can recommend.
   * Any action not in this list is rejected.
   */
  static ALLOWED_ACTIONS = ["start", "stop", "restart", "notify", "skip"];

  /**
   * Autonomy gating matrix.
   * Maps each autonomy level to which actions are permitted.
   *
   * - observe:  No actions (same as Phase 1 behavior)
   * - cautious: AI can start sessions and send notifications
   * - moderate: AI can start, stop, restart, and notify
   * - full:     All actions permitted
   */
  static AUTONOMY_MATRIX = {
    observe:  { start: false, stop: false, restart: false, notify: false, skip: true },
    cautious: { start: true,  stop: false, restart: false, notify: true,  skip: true },
    moderate: { start: true,  stop: true,  restart: true,  notify: true,  skip: true },
    full:     { start: true,  stop: true,  restart: true,  notify: true,  skip: true },
  };

  /**
   * @param {Object} deps
   * @param {Object} deps.sessionManager - SessionManager instance
   * @param {Object} deps.messenger - Messenger instance
   * @param {Object} [deps.notificationManager] - NotificationManager instance (optional, falls back to messenger)
   * @param {Object} [deps.signalProtocol] - SignalProtocol instance (optional)
   * @param {Object} [deps.state] - StateManager instance (optional)
   * @param {Object} deps.config - Parsed config.json object
   */
  constructor({ sessionManager, messenger, notificationManager, signalProtocol, state, config }) {
    this.sessionManager = sessionManager;
    this.messenger = messenger;
    this.notificationManager = notificationManager || null;
    this.signalProtocol = signalProtocol || null;
    this.state = state || null;
    this.config = config;

    /** @type {Object.<string, number>} Tracks last action timestamps: "project:action" -> epoch */
    this._lastActionTime = {};

    /** @type {Map<string, number>} Content-based dedup: hash -> timestamp */
    this._recentHashes = new Map();

    /** @type {number} How long (ms) to suppress duplicate recommendations (default 1 hour) */
    this._dedupTtlMs = config.ai?.dedupTtlMs || 3600000;
  }

  /**
   * Evaluate an array of recommendations from the AI brain.
   * Validates each against the allowlist, protected projects, and cooldowns.
   * Marks recommendations with the current autonomy level's observe-only flag.
   *
   * @param {Array} recommendations - Array of recommendation objects from AI
   * @returns {Array} Evaluated recommendations with validation fields added
   */
  evaluate(recommendations) {
    if (!Array.isArray(recommendations)) return [];

    // Read runtime autonomy level from state (falls back to config default)
    const s = this.state ? this.state.load() : {};
    const autonomyLevel = this.state
      ? this.state.getAutonomyLevel(s, this.config)
      : (this.config.ai?.autonomyLevel || "observe");

    return recommendations.map((rec) => {
      const result = { ...rec };

      // 1. Validate action is in allowlist
      if (!DecisionExecutor.ALLOWED_ACTIONS.includes(rec.action)) {
        result.validated = false;
        result.rejected = "unknown action";
        result.observeOnly = false;
        return result;
      }

      // 2. Check if project is protected
      const protectedProjects = this.config.ai?.protectedProjects || [];
      if (protectedProjects.includes(rec.project)) {
        result.validated = false;
        result.rejected = "protected project";
        result.observeOnly = false;
        return result;
      }

      // 3. Check cooldowns
      const cooldownCheck = this._checkCooldown(rec.project, rec.action);
      if (!cooldownCheck.ok) {
        result.validated = false;
        result.rejected = "cooldown active";
        result.cooldownRemainingMs = cooldownCheck.remainingMs;
        result.observeOnly = false;
        return result;
      }

      // 4. Passed all checks
      result.validated = true;
      result.rejected = null;

      // In observe mode, mark as observe-only (recommend but don't act)
      result.observeOnly = autonomyLevel === "observe";
      result.autonomyLevel = autonomyLevel;

      return result;
    });
  }

  /**
   * Format evaluated recommendations into a clean SMS-friendly text message.
   * Skips rejected recommendations and deduplicates validated ones.
   * Keeps under 1500 chars.
   *
   * @param {Array} evaluatedRecommendations - Output of evaluate()
   * @param {string} [summary] - Optional summary from AI brain
   * @returns {string|null} Formatted SMS text, or null if all recommendations were duplicates
   */
  formatForSMS(evaluatedRecommendations, summary) {
    const rejected = evaluatedRecommendations.filter((r) => !r.validated);

    // Deduplicate validated recommendations (content-based)
    const valid = evaluatedRecommendations.filter((r) => {
      if (!r.validated) return false;       // handled in rejected
      if (this._isDuplicate(r)) return false; // suppress duplicates
      this._recordRecommendation(r);        // record new ones
      return true;
    });

    // If all valid recommendations were deduped and there are no rejections, skip SMS entirely
    if (valid.length === 0 && rejected.length === 0) {
      if (evaluatedRecommendations.some((r) => r.validated)) {
        // Had valid recs but all were deduped
        return null;
      }
    }

    const lines = [];

    // Read runtime autonomy level from state
    const s = this.state ? this.state.load() : {};
    const autonomyLevel = this.state
      ? this.state.getAutonomyLevel(s, this.config)
      : (this.config.ai?.autonomyLevel || "observe");

    if (valid.length === 0 && rejected.length === 0) {
      lines.push("AI brain: No recommendations.");
      if (summary) lines.push(`\n${summary}`);
      return lines.join("");
    }

    lines.push("AI recommends:\n");

    // List valid recommendations (numbered)
    for (let i = 0; i < valid.length; i++) {
      const r = valid[i];
      lines.push(`${i + 1}. ${r.project} -> ${r.action}`);
      if (r.reason) lines.push(`   ${r.reason}`);
      lines.push("");
    }

    // Note rejected items briefly
    if (rejected.length > 0) {
      lines.push(`(${rejected.length} rejected: ${rejected.map((r) => `${r.project}:${r.rejected}`).join(", ")})\n`);
    }

    if (summary) {
      lines.push(`Summary: ${summary}\n`);
    }

    if (autonomyLevel === "observe") {
      lines.push("(observe mode - no actions taken)");
    }

    let result = lines.join("\n");

    // Truncate to 1500 chars if needed
    if (result.length > 1500) {
      result = result.substring(0, 1460) + "\n\n[truncated]";
    }

    return result;
  }

  /**
   * Execute a validated recommendation.
   * Dispatches to sessionManager methods with autonomy gating, precondition checks,
   * cooldown recording, execution logging, and post-action notifications.
   *
   * @param {Object} evaluatedRecommendation - A single evaluated recommendation
   * @returns {Promise<Object>} Execution result
   */
  async execute(evaluatedRecommendation) {
    const rec = evaluatedRecommendation;

    // 1. Reject if not validated
    if (!rec.validated) {
      return { executed: false, action: rec.action, project: rec.project, rejected: rec.rejected };
    }

    // 2. Check autonomy level gating
    const s = this.state ? this.state.load() : {};
    const autonomyLevel = this.state
      ? this.state.getAutonomyLevel(s, this.config)
      : "observe";

    if (!this._isActionAllowed(rec.action, autonomyLevel)) {
      // Action not allowed at this autonomy level -- notify instead
      const smsText = `AI would ${rec.action} ${rec.project}: ${rec.reason}`;
      this._notify(smsText, 3); // tier 3 = summary
      return { executed: false, action: rec.action, project: rec.project, rejected: "autonomy_level", autonomyLevel };
    }

    // 3. Just-in-time precondition checks
    const precondition = await this._checkPreconditions(rec);
    if (!precondition.ok) {
      return { executed: false, action: rec.action, project: rec.project, rejected: "precondition_failed", reason: precondition.reason };
    }

    // 4. Execute the action
    let result;
    try {
      switch (rec.action) {
        case "start":
          // Inject signal protocol before starting
          if (this.signalProtocol) {
            this.signalProtocol.injectClaudeMd(rec.project);
          }
          result = this.sessionManager.startSession(rec.project, rec.prompt);
          break;
        case "stop":
          result = this.sessionManager.stopSession(rec.project);
          break;
        case "restart":
          if (this.signalProtocol) {
            this.signalProtocol.injectClaudeMd(rec.project);
          }
          result = this.sessionManager.restartSession(rec.project, rec.prompt);
          break;
        case "notify":
          const msg = rec.message || rec.reason || "AI notification";
          this._notify(msg, rec.notificationTier || 2);
          result = { success: true, message: "Notification sent" };
          break;
        case "skip":
          result = { success: true, message: `Skipped ${rec.project}: ${rec.reason}` };
          break;
        default:
          result = { success: false, message: `Unknown action: ${rec.action}` };
      }
    } catch (err) {
      result = { success: false, message: `Execution error: ${err.message}` };
    }

    // 5. Post-action bookkeeping (cooldown tracking)
    this._recordAction(rec.project, rec.action);

    // 6. Log execution to state
    if (this.state) {
      const execRecord = {
        timestamp: new Date().toISOString(),
        action: rec.action,
        project: rec.project,
        result: { success: result.success, message: result.message },
        autonomyLevel,
        stateVersion: s.stateVersion || 0,
      };
      this.state.logExecution(s, execRecord);
    }

    // 7. Notify about major actions (start/stop/restart)
    if (result.success && ["start", "stop", "restart"].includes(rec.action)) {
      const actionText = `AI ${rec.action}ed ${rec.project}: ${rec.reason}`;
      this._notify(actionText, 2); // tier 2 = action
    }

    return {
      executed: result.success,
      action: rec.action,
      project: rec.project,
      result,
      timestamp: new Date().toISOString(),
      autonomyLevel,
    };
  }

  /**
   * Check if an action is allowed at a given autonomy level.
   *
   * @param {string} action - Action type
   * @param {string} level - Autonomy level
   * @returns {boolean}
   */
  _isActionAllowed(action, level) {
    const matrix = DecisionExecutor.AUTONOMY_MATRIX[level];
    if (!matrix) return false;
    return matrix[action] || false;
  }

  /**
   * Just-in-time precondition checks before executing an action.
   * Checks session state, concurrent limits, memory, and error retry caps.
   *
   * @param {Object} rec - Evaluated recommendation
   * @returns {Promise<{ ok: boolean, reason: string }>}
   */
  async _checkPreconditions(rec) {
    const { action, project } = rec;

    if (action === "start") {
      // 1. Check session not already running
      const sessions = this.sessionManager.getActiveSessions();
      const running = sessions.some((s) => s.projectName === project);
      if (running) return { ok: false, reason: `Session already running for ${project}` };

      // 2. Check concurrent limit
      if (sessions.length >= this.sessionManager.maxConcurrent) {
        return { ok: false, reason: `Max concurrent sessions (${this.sessionManager.maxConcurrent}) reached` };
      }

      // 3. Check memory
      const minMB = this.config.ai?.resourceLimits?.minFreeMemoryMB || 2048;
      const freeMB = Math.round(os.freemem() / 1024 / 1024);
      if (freeMB < minMB) {
        return { ok: false, reason: `Low memory: ${freeMB}MB free, need ${minMB}MB` };
      }

      // 4. Check error retry cap
      if (this.state) {
        const s = this.state.load();
        const retries = this.state.getErrorRetryCount(s, project);
        const maxRetries = this.config.ai?.maxErrorRetries || 3;
        if (retries >= maxRetries) {
          return { ok: false, reason: `Error retry cap reached (${retries}/${maxRetries}) for ${project}` };
        }
      }
    }

    if (action === "stop" || action === "restart") {
      // Check session IS running
      const sessions = this.sessionManager.getActiveSessions();
      const running = sessions.some((s) => s.projectName === project);
      if (!running) return { ok: false, reason: `No running session for ${project}` };
    }

    return { ok: true };
  }

  /**
   * Send a notification through NotificationManager (tiered) or fall back to Messenger.
   *
   * @param {string} text - Message text
   * @param {number} [tier=2] - Notification tier (1=URGENT, 2=ACTION, 3=SUMMARY, 4=DEBUG)
   */
  _notify(text, tier = 2) {
    if (this.notificationManager) {
      this.notificationManager.notify(text, tier);
    } else if (this.messenger) {
      this.messenger.send(text);
    }
  }

  /**
   * Check if an action for a project is within its cooldown period.
   * Checks both same-action cooldown and same-project cooldown.
   *
   * @param {string} project - Project name
   * @param {string} action - Action type
   * @returns {{ ok: boolean, reason: string, remainingMs: number }}
   */
  _checkCooldown(project, action) {
    const now = Date.now();
    const sameActionMs = this.config.ai?.cooldowns?.sameActionMs || 300000;
    const sameProjectMs = this.config.ai?.cooldowns?.sameProjectMs || 600000;

    // Check same action cooldown
    const actionKey = `${project}:${action}`;
    const lastActionTime = this._lastActionTime[actionKey];
    if (lastActionTime) {
      const elapsed = now - lastActionTime;
      if (elapsed < sameActionMs) {
        return {
          ok: false,
          reason: `Same action cooldown: ${Math.round((sameActionMs - elapsed) / 1000)}s remaining`,
          remainingMs: sameActionMs - elapsed,
        };
      }
    }

    // Check same project cooldown (any action on this project)
    for (const [key, timestamp] of Object.entries(this._lastActionTime)) {
      if (key.startsWith(`${project}:`)) {
        const elapsed = now - timestamp;
        if (elapsed < sameProjectMs) {
          return {
            ok: false,
            reason: `Same project cooldown: ${Math.round((sameProjectMs - elapsed) / 1000)}s remaining`,
            remainingMs: sameProjectMs - elapsed,
          };
        }
      }
    }

    return { ok: true, reason: "No cooldown active", remainingMs: 0 };
  }

  /**
   * Record that an action was taken on a project (updates cooldown tracking).
   *
   * @param {string} project - Project name
   * @param {string} action - Action type
   */
  _recordAction(project, action) {
    this._lastActionTime[`${project}:${action}`] = Date.now();
  }

  // ── Content-based recommendation dedup ──────────────────────────────────

  /**
   * Compute a content hash for a recommendation based on project+action+reason.
   * Uses djb2 hash function (simple, no crypto dependency needed).
   *
   * @param {Object} rec - Recommendation object
   * @returns {string} Hex hash string
   */
  _hashRecommendation(rec) {
    const content = `${rec.project}:${rec.action}:${(rec.reason || "").substring(0, 100)}`.toLowerCase();
    return this._hashString(content);
  }

  /**
   * djb2 hash function. Returns a hex string.
   * @param {string} str
   * @returns {string}
   */
  _hashString(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash) + str.charCodeAt(i);
      hash = hash & hash; // Convert to 32-bit integer
    }
    return (hash >>> 0).toString(16);
  }

  /**
   * Check if a recommendation is a duplicate (same content hash within TTL).
   *
   * @param {Object} rec - Recommendation object
   * @returns {boolean} true if duplicate
   */
  _isDuplicate(rec) {
    const hash = this._hashRecommendation(rec);
    const lastSeen = this._recentHashes.get(hash);
    if (lastSeen === undefined) return false;
    return (Date.now() - lastSeen) < this._dedupTtlMs;
  }

  /**
   * Record a recommendation hash with current timestamp.
   * Also prunes expired entries from the hash map.
   *
   * @param {Object} rec - Recommendation object
   */
  _recordRecommendation(rec) {
    const hash = this._hashRecommendation(rec);
    const now = Date.now();
    this._recentHashes.set(hash, now);

    // Prune expired entries
    for (const [key, ts] of this._recentHashes) {
      if (now - ts > this._dedupTtlMs) {
        this._recentHashes.delete(key);
      }
    }
  }
}

module.exports = DecisionExecutor;
