/**
 * DecisionExecutor - Validates and formats AI brain recommendations with
 * safety guardrails.
 *
 * Phase 1 (observe mode): Validates actions against an allowlist, checks
 * cooldowns and protected projects, but NEVER executes. The execute() method
 * is a scaffold that will be wired in Phase 2.
 */
class DecisionExecutor {
  /**
   * Allowed actions the AI brain can recommend.
   * Any action not in this list is rejected.
   */
  static ALLOWED_ACTIONS = ["start", "stop", "restart", "notify", "skip"];

  /**
   * @param {Object} deps
   * @param {Object} deps.sessionManager - SessionManager instance
   * @param {Object} deps.messenger - Messenger instance
   * @param {Object} deps.config - Parsed config.json object
   */
  constructor({ sessionManager, messenger, config }) {
    this.sessionManager = sessionManager;
    this.messenger = messenger;
    this.config = config;

    /** @type {Object.<string, number>} Tracks last action timestamps: "project:action" -> epoch */
    this._lastActionTime = {};
  }

  /**
   * Evaluate an array of recommendations from the AI brain.
   * Validates each against the allowlist, protected projects, and cooldowns.
   * In observe mode, all validated recommendations are marked observeOnly.
   *
   * @param {Array} recommendations - Array of recommendation objects from AI
   * @returns {Array} Evaluated recommendations with validation fields added
   */
  evaluate(recommendations) {
    if (!Array.isArray(recommendations)) return [];

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
      const autonomyLevel = this.config.ai?.autonomyLevel || "observe";
      result.observeOnly = autonomyLevel === "observe";

      return result;
    });
  }

  /**
   * Format evaluated recommendations into a clean SMS-friendly text message.
   * Skips rejected recommendations, keeps under 1500 chars.
   *
   * @param {Array} evaluatedRecommendations - Output of evaluate()
   * @param {string} [summary] - Optional summary from AI brain
   * @returns {string} Formatted SMS text
   */
  formatForSMS(evaluatedRecommendations, summary) {
    const valid = evaluatedRecommendations.filter((r) => r.validated);
    const rejected = evaluatedRecommendations.filter((r) => !r.validated);

    const lines = [];
    const autonomyLevel = this.config.ai?.autonomyLevel || "observe";

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
   * Execute a validated recommendation. Phase 1 SCAFFOLD -- refuses to act.
   * Will be wired to sessionManager in Phase 2.
   *
   * @param {Object} evaluatedRecommendation - A single evaluated recommendation
   * @returns {Object} Execution result
   */
  execute(evaluatedRecommendation) {
    console.log("[decision-executor] execute() called in observe mode, ignoring");
    return { executed: false, reason: "observe mode" };
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
}

module.exports = DecisionExecutor;
