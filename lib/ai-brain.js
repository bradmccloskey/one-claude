const { claudePWithSemaphore } = require("./exec");
const os = require("os");

/**
 * AIBrain - Core intelligence layer for the orchestrator.
 *
 * Runs think cycles: assembles context via ContextAssembler, shells out to
 * `claude -p` for plain text JSON response, parses it, logs the decision
 * to state, and passes recommendations to DecisionExecutor.
 */
class AIBrain {
  constructor({ contextAssembler, decisionExecutor, state, messenger, config }) {
    this.contextAssembler = contextAssembler;
    this.decisionExecutor = decisionExecutor;
    this.state = state;
    this.messenger = messenger;
    this.config = config;

    this._thinking = false;
    this._lastThinkTime = 0;
    this._enabled = config.ai?.enabled || false;
    this._nextThinkOverride = null;
  }

  /**
   * Run a single think cycle: assemble context, ask Claude, parse response,
   * log decision, and pass to executor for evaluation.
   */
  async think() {
    if (!this._enabled) return null;

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

      // 2. Shell out to claude -p — plain text, maxTurns 1, no tools
      let responseText;
      try {
        const model = this.config.ai?.model || "sonnet";
        responseText = await claudePWithSemaphore(prompt, {
          model,
          maxTurns: 1,
          outputFormat: "text",
          timeout: 60000,
        });
      } catch (execErr) {
        const duration_ms = Date.now() - startTime;
        const errorType = execErr.code === "ETIMEDOUT"
          ? "timeout"
          : execErr.status
            ? `exit_code_${execErr.status}`
            : "exec_error";

        const errorMsg = execErr.code === "ETIMEDOUT"
          ? "Think timed out after 60s"
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

      // 3. Extract JSON from response text
      const parsed = this._extractJSON(responseText);
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
   * Extract JSON from a text response that may contain markdown fences or prose.
   * Tries: raw parse, fenced code block extraction, brace extraction.
   * @param {string} text - Raw response text
   * @returns {Object|null} Parsed JSON object or null
   */
  _extractJSON(text) {
    if (!text || text.length < 2) return null;

    // Check for error messages
    if (text.startsWith("Error:") || text.includes("Reached max turns")) {
      console.log(`[ai-brain] Response was error: ${text.substring(0, 100)}`);
      return null;
    }

    // 1. Try raw parse (ideal case — response is pure JSON)
    try {
      return JSON.parse(text.trim());
    } catch {}

    // 2. Try extracting from markdown code fence
    const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fenceMatch) {
      try {
        return JSON.parse(fenceMatch[1].trim());
      } catch {}
    }

    // 3. Try extracting the first { ... } block
    const braceStart = text.indexOf("{");
    const braceEnd = text.lastIndexOf("}");
    if (braceStart !== -1 && braceEnd > braceStart) {
      try {
        return JSON.parse(text.substring(braceStart, braceEnd + 1));
      } catch {}
    }

    console.warn(`[ai-brain] Failed to extract JSON from response: ${text.substring(0, 200)}`);
    return null;
  }

  enable() { this._enabled = true; }
  disable() { this._enabled = false; }
  isEnabled() { return this._enabled; }

  getStatus() {
    const s = this.state.load();
    const recentDecisions = (s.aiDecisionHistory || []).length;
    return {
      enabled: this._enabled,
      lastThinkTime: this._lastThinkTime ? new Date(this._lastThinkTime).toISOString() : null,
      thinking: this._thinking,
      autonomyLevel: this.config.ai?.autonomyLevel || "observe",
      recentDecisions,
    };
  }

  getLastDecision() {
    const s = this.state.load();
    const history = s.aiDecisionHistory || [];
    return history.length > 0 ? history[history.length - 1] : null;
  }

  _checkResources() {
    const minFreeBytes = (this.config.ai?.resourceLimits?.minFreeMemoryMB || 2048) * 1024 * 1024;
    const freeMemory = os.freemem();
    if (freeMemory < minFreeBytes) {
      const freeMB = Math.round(freeMemory / 1024 / 1024);
      const requiredMB = Math.round(minFreeBytes / 1024 / 1024);
      return { ok: false, reason: `Insufficient free memory: ${freeMB}MB available, ${requiredMB}MB required` };
    }
    return { ok: true, reason: "Resources adequate" };
  }

  async generateDigest() {
    if (this._thinking) {
      console.log("[ai-brain] Cannot generate digest while thinking");
      return null;
    }

    this._thinking = true;
    try {
      const baseContext = this.contextAssembler.assemble();
      const s = this.state.load();
      const history = s.aiDecisionHistory || [];
      const executionHistory = s.executionHistory || [];

      const twelveHoursAgo = Date.now() - 12 * 60 * 60 * 1000;
      const recentDecisions = history.filter(d => new Date(d.timestamp).getTime() > twelveHoursAgo);
      const recentExecutions = executionHistory.filter(e => new Date(e.timestamp).getTime() > twelveHoursAgo);

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
        baseContext.substring(0, 4000),
        "",
      ];

      if (recentDecisions.length > 0) {
        digestPrompt.push("--- Overnight AI Decisions ---");
        for (const d of recentDecisions.slice(-10)) {
          digestPrompt.push(`[${d.timestamp}] ${d.summary || "no summary"}`);
          if (d.recommendations) {
            for (const r of d.recommendations) {
              digestPrompt.push(`  - ${r.action} ${r.project}: ${r.reason || ""}`);
            }
          }
        }
        digestPrompt.push("");
      }

      if (recentExecutions.length > 0) {
        digestPrompt.push("--- Overnight Executions ---");
        for (const e of recentExecutions.slice(-10)) {
          digestPrompt.push(`[${e.timestamp}] ${e.action} ${e.project}: ${e.result?.message || ""}`);
        }
        digestPrompt.push("");
      }

      const prompt = digestPrompt.join("\n");
      const model = this.config.ai?.model || "sonnet";
      const digestText = await claudePWithSemaphore(prompt, {
        model,
        maxTurns: 1,
        outputFormat: "text",
        timeout: 30000,
      });

      if (digestText.length < 20) {
        console.log("[ai-brain] Digest response too short, likely failed");
        return null;
      }

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

  setNextThinkOverride(seconds) {
    const bounded = Math.max(60, Math.min(1800, Number(seconds) || 300));
    this._nextThinkOverride = bounded * 1000;
  }

  consumeNextThinkOverride() {
    const override = this._nextThinkOverride;
    this._nextThinkOverride = null;
    return override;
  }
}

module.exports = AIBrain;
