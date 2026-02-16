const { execSync } = require("child_process");
const os = require("os");

/**
 * AIBrain - Core intelligence layer for the orchestrator.
 *
 * Runs think cycles: assembles context via ContextAssembler, shells out to
 * `claude -p` for recommendations, parses the JSON response, logs the
 * decision to state, and passes recommendations to DecisionExecutor.
 *
 * In Phase 1 (observe mode), this produces recommendations but the executor
 * only validates -- it never acts.
 */
class AIBrain {
  /**
   * @param {Object} deps
   * @param {Object} deps.contextAssembler - ContextAssembler instance
   * @param {Object} deps.decisionExecutor - DecisionExecutor instance
   * @param {Object} deps.state - StateManager instance
   * @param {Object} deps.messenger - Messenger instance (for logging/notifications)
   * @param {Object} deps.config - Parsed config.json object
   */
  constructor({ contextAssembler, decisionExecutor, state, messenger, config }) {
    this.contextAssembler = contextAssembler;
    this.decisionExecutor = decisionExecutor;
    this.state = state;
    this.messenger = messenger;
    this.config = config;

    this._thinking = false;
    this._lastThinkTime = 0;
    this._enabled = config.ai?.enabled || false;
    this._nextThinkOverride = null; // AI-suggested think interval override
  }

  /**
   * Run a single think cycle: assemble context, ask Claude, parse response,
   * log decision, and pass to executor for evaluation.
   *
   * @returns {Object|null} Decision object or null if skipped/failed
   */
  async think() {
    if (!this._enabled) {
      return null;
    }

    if (this._thinking) {
      console.log("[ai-brain] Already thinking, skipping concurrent cycle");
      return null;
    }

    const resourceCheck = this._checkResources();
    if (!resourceCheck.ok) {
      console.log(`[ai-brain] Resource check failed: ${resourceCheck.reason}`);
      return null;
    }

    this._thinking = true;
    const startTime = Date.now();

    try {
      // 1. Assemble context prompt
      const prompt = this.contextAssembler.assemble();

      // 2. Shell out to claude -p
      let responseText;
      try {
        const model = this.config.ai?.model || "sonnet";
        responseText = execSync(
          `claude -p --model ${model} --max-turns 1 --output-format text`,
          { input: prompt, encoding: "utf-8", timeout: 30000 }
        );
      } catch (execErr) {
        const duration_ms = Date.now() - startTime;
        const errorType = execErr.code === "ETIMEDOUT"
          ? "timeout"
          : execErr.status
            ? `exit_code_${execErr.status}`
            : "exec_error";

        const errorMsg = execErr.code === "ETIMEDOUT"
          ? "Think timed out after 30s"
          : execErr.stderr
            ? `claude stderr: ${String(execErr.stderr).substring(0, 200)}`
            : `exec error: ${execErr.message}`;

        console.log(`[ai-brain] ${errorMsg}`);

        const fallback = {
          timestamp: new Date().toISOString(),
          prompt_length: prompt.length,
          response_raw: "",
          recommendations: [],
          summary: errorMsg,
          duration_ms,
          error: errorType,
        };

        const s = this.state.load();
        this.state.logDecision(s, fallback);
        return fallback;
      }

      // 3. Parse JSON from response
      const parsed = this.parseJSON(responseText);
      const recommendations = parsed?.recommendations || [];
      const summary = parsed?.summary || "No summary";

      // 4. Log decision to state
      const duration_ms = Date.now() - startTime;
      const decision = {
        timestamp: new Date().toISOString(),
        prompt_length: prompt.length,
        response_raw: responseText.substring(0, 500),
        recommendations,
        summary,
        duration_ms,
        error: parsed ? null : "parse_error",
      };

      const s = this.state.load();
      this.state.logDecision(s, decision);

      // 5. Pass to executor for evaluation
      const evaluated = this.decisionExecutor.evaluate(recommendations);
      decision.evaluated = evaluated;

      // 6. Update last think time
      this._lastThinkTime = Date.now();

      return decision;
    } finally {
      this._thinking = false;
    }
  }

  /**
   * Enable the AI brain (runtime toggle).
   */
  enable() {
    this._enabled = true;
  }

  /**
   * Disable the AI brain (runtime toggle).
   */
  disable() {
    this._enabled = false;
  }

  /**
   * Check if the AI brain is currently enabled.
   * @returns {boolean}
   */
  isEnabled() {
    return this._enabled;
  }

  /**
   * Get current status of the AI brain.
   * @returns {Object} Status object
   */
  getStatus() {
    const s = this.state.load();
    const recentDecisions = (s.aiDecisionHistory || []).length;

    return {
      enabled: this._enabled,
      lastThinkTime: this._lastThinkTime
        ? new Date(this._lastThinkTime).toISOString()
        : null,
      thinking: this._thinking,
      autonomyLevel: this.config.ai?.autonomyLevel || "observe",
      recentDecisions,
    };
  }

  /**
   * Get the most recent decision from history.
   * @returns {Object|null} Last decision or null
   */
  getLastDecision() {
    const s = this.state.load();
    const history = s.aiDecisionHistory || [];
    return history.length > 0 ? history[history.length - 1] : null;
  }

  /**
   * Check system resources to determine if a think cycle is safe.
   * @returns {{ ok: boolean, reason: string }}
   */
  _checkResources() {
    const minFreeBytes =
      (this.config.ai?.resourceLimits?.minFreeMemoryMB || 2048) * 1024 * 1024;
    const freeMemory = os.freemem();

    if (freeMemory < minFreeBytes) {
      const freeMB = Math.round(freeMemory / 1024 / 1024);
      const requiredMB = Math.round(minFreeBytes / 1024 / 1024);
      return {
        ok: false,
        reason: `Insufficient free memory: ${freeMB}MB available, ${requiredMB}MB required`,
      };
    }

    return { ok: true, reason: "Resources adequate" };
  }

  /**
   * Generate an AI-written morning digest via claude -p.
   * Includes overnight activity, session completions, errors, and priorities.
   *
   * @returns {string|null} AI-generated digest text, or null on failure
   */
  async generateDigest() {
    if (this._thinking) {
      console.log("[ai-brain] Cannot generate digest while thinking");
      return null;
    }

    this._thinking = true;
    try {
      // Gather context
      const baseContext = this.contextAssembler.assemble();

      // Get overnight decision history
      const s = this.state.load();
      const history = s.aiDecisionHistory || [];
      const executionHistory = s.executionHistory || [];

      // Filter to decisions from last 12 hours (overnight window)
      const twelveHoursAgo = Date.now() - 12 * 60 * 60 * 1000;
      const recentDecisions = history.filter(
        (d) => new Date(d.timestamp).getTime() > twelveHoursAgo
      );
      const recentExecutions = executionHistory.filter(
        (e) => new Date(e.timestamp).getTime() > twelveHoursAgo
      );

      // Build digest prompt
      const digestPrompt = [
        "You are generating a morning digest for a project orchestrator manager.",
        "Write a concise, valuable summary (under 1000 chars) that covers:",
        "1. What happened overnight (sessions started/stopped, completions, errors)",
        "2. What needs attention today",
        "3. Suggested priorities for today",
        "",
        "Keep it conversational and actionable. No JSON needed, just plain text.",
        'Start with "Good morning!" and end with today\'s top priority.',
        "",
        "--- Current State ---",
        baseContext.substring(0, 4000), // First 4K of context
        "",
      ];

      if (recentDecisions.length > 0) {
        digestPrompt.push("--- Overnight AI Decisions ---");
        for (const d of recentDecisions.slice(-10)) {
          digestPrompt.push(`[${d.timestamp}] ${d.summary || "no summary"}`);
          if (d.recommendations) {
            for (const r of d.recommendations) {
              digestPrompt.push(
                `  - ${r.action} ${r.project}: ${r.reason || ""}`
              );
            }
          }
        }
        digestPrompt.push("");
      }

      if (recentExecutions.length > 0) {
        digestPrompt.push("--- Overnight Executions ---");
        for (const e of recentExecutions.slice(-10)) {
          digestPrompt.push(
            `[${e.timestamp}] ${e.action} ${e.project}: ${e.result?.message || ""}`
          );
        }
        digestPrompt.push("");
      }

      const prompt = digestPrompt.join("\n");

      // Shell out to claude -p
      const model = this.config.ai?.model || "sonnet";
      const responseText = execSync(
        `claude -p --model ${model} --max-turns 1 --output-format text`,
        { input: prompt, encoding: "utf-8", timeout: 30000 }
      );

      const digestText = responseText.trim();
      if (digestText.length < 20) {
        console.log("[ai-brain] Digest response too short, likely failed");
        return null;
      }

      // Truncate if over 1500 chars (SMS limit)
      return digestText.length > 1500
        ? digestText.substring(0, 1460) + "\n\n[truncated]"
        : digestText;
    } catch (err) {
      console.log(`[ai-brain] Digest generation failed: ${err.message}`);
      return null;
    } finally {
      this._thinking = false;
    }
  }

  /**
   * Set an override for the next think interval (in ms).
   * Bounded to 60s-1800s (1-30 min). Resets after one use.
   * @param {number} seconds - AI-suggested seconds
   */
  setNextThinkOverride(seconds) {
    const bounded = Math.max(60, Math.min(1800, Number(seconds) || 300));
    this._nextThinkOverride = bounded * 1000;
  }

  /**
   * Consume the next think override (returns it and resets to null).
   * @returns {number|null} Override in ms, or null
   */
  consumeNextThinkOverride() {
    const override = this._nextThinkOverride;
    this._nextThinkOverride = null;
    return override;
  }

  /**
   * Robust JSON extractor. Handles:
   * 1. Clean JSON string
   * 2. JSON embedded in prose (finds outermost { ... })
   * 3. JSON inside markdown ```json ... ``` fences
   *
   * @param {string} text - Raw text potentially containing JSON
   * @returns {Object|null} Parsed object or null on failure
   */
  parseJSON(text) {
    if (!text || typeof text !== "string") return null;

    const trimmed = text.trim();

    // Attempt 1: Direct parse
    try {
      return JSON.parse(trimmed);
    } catch {
      // continue to fallback strategies
    }

    // Attempt 2: Extract from markdown ```json ... ``` fences
    const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (fenceMatch) {
      try {
        return JSON.parse(fenceMatch[1].trim());
      } catch {
        // continue
      }
    }

    // Attempt 3: Find outermost { ... } braces
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(trimmed.substring(firstBrace, lastBrace + 1));
      } catch {
        // all strategies exhausted
      }
    }

    console.log("[ai-brain] Failed to parse JSON from response");
    return null;
  }
}

module.exports = AIBrain;
