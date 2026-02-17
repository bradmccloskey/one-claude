'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * JSON schema for the LLM evaluation response.
 * Used with claudePWithSemaphore's --json-schema flag.
 */
const EVALUATION_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    score: { type: 'integer', minimum: 1, maximum: 5 },
    recommendation: { type: 'string', enum: ['continue', 'retry', 'escalate', 'complete'] },
    accomplishments: { type: 'array', items: { type: 'string' } },
    failures: { type: 'array', items: { type: 'string' } },
    reasoning: { type: 'string' },
  },
  required: ['score', 'recommendation', 'accomplishments', 'failures', 'reasoning'],
});

/**
 * SessionEvaluator - LLM-as-judge session quality scoring.
 *
 * Combines objective git signals with terminal output analysis to produce
 * structured evaluations of completed coding sessions. Uses claudePWithSemaphore
 * to call an LLM judge that scores sessions 1-5 with recommendations.
 */
class SessionEvaluator {
  /**
   * @param {Object} deps
   * @param {Object} deps.gitTracker - GitTracker instance for git progress queries
   * @param {Object} deps.state - StateManager instance for evaluation persistence
   * @param {Object} deps.config - Orchestrator config object
   */
  constructor({ gitTracker, state, config, sessionLearner }) {
    this.gitTracker = gitTracker;
    this.state = state;
    this.config = config;
    this.sessionLearner = sessionLearner || null;
  }

  /**
   * Evaluate a completed session's quality using objective evidence and LLM analysis.
   *
   * Call this BEFORE destroying the tmux session (needs to capture pane output).
   *
   * @param {Object} params
   * @param {string} params.projectName - Project identifier
   * @param {string} params.projectDir - Absolute path to project directory
   * @param {string} params.sessionName - tmux session name (e.g., "orch-web-scraping-biz")
   * @param {string} params.startedAt - ISO timestamp of session start
   * @param {string|null} params.headBefore - Git HEAD hash at session start (null if no commits)
   * @param {string} params.prompt - The prompt that was sent to the session
   * @returns {Promise<Object>} Structured evaluation record
   */
  async evaluate({ projectName, projectDir, sessionName, startedAt, headBefore, prompt }) {
    // 1. Capture tmux output (before session is destroyed)
    let tmuxOutput = '';
    try {
      const raw = execSync(
        `tmux capture-pane -t "${sessionName}" -p -S -200 -J`,
        { encoding: 'utf-8', timeout: 5000 }
      );
      // Strip ANSI escape codes
      tmuxOutput = raw.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
      // Trim to last 2000 chars for the LLM prompt
      if (tmuxOutput.length > 2000) {
        tmuxOutput = tmuxOutput.slice(-2000);
      }
    } catch {
      // Session may already be gone -- use empty string
      tmuxOutput = '';
    }

    // 2. Get git progress
    const gitProgress = this.gitTracker.getProgress(projectDir, startedAt);

    // 3. Calculate duration
    const durationMin = Math.round((Date.now() - new Date(startedAt).getTime()) / 60000);

    // 4. Build evaluation prompt
    const truncatedPrompt = (prompt || '').substring(0, 500);
    let evidenceSection = `- Commits since session start: ${gitProgress.commitCount}
- Files changed: ${gitProgress.filesChanged}
- Lines added: ${gitProgress.insertions}, Lines removed: ${gitProgress.deletions}
- Last commit: "${gitProgress.lastCommitMessage || 'none'}"
- Session duration: ${durationMin} minutes`;

    if (gitProgress.noGit) {
      evidenceSection += '\n- No git repository found. Evaluate based on terminal output only.';
    }

    const evalPrompt = `You are evaluating the quality of an automated coding session.
Analyze the objective evidence and terminal output, then score the session.

RUBRIC:
Score 1 (Failed): No commits, no meaningful changes, or only errors in output.
Score 2 (Minimal): Some activity but key objectives not addressed. Mostly setup/config.
Score 3 (Acceptable): Partial progress. Some real code changes toward objectives.
Score 4 (Good): Clear progress on objectives. Multiple meaningful commits. Tests pass.
Score 5 (Excellent): All stated objectives completed. Clean commits, tests pass, docs updated.

OBJECTIVE EVIDENCE:
${evidenceSection}

SESSION PROMPT (what was asked):
${truncatedPrompt}

TERMINAL OUTPUT (last lines):
${tmuxOutput}

Think step by step: What did this session accomplish relative to its objectives?
Then provide your evaluation.`;

    // 5. Call LLM-as-judge
    let parsed;
    try {
      const { claudePWithSemaphore } = require('./exec');
      const result = await claudePWithSemaphore(evalPrompt, {
        jsonSchema: EVALUATION_SCHEMA,
        timeout: 30000,
      });
      parsed = JSON.parse(result);
    } catch {
      // Fallback evaluation based on commit count
      const fallbackScore = gitProgress.commitCount === 0 ? 1
        : gitProgress.commitCount <= 2 ? 3
        : 4;
      parsed = {
        score: fallbackScore,
        recommendation: fallbackScore >= 3 ? 'continue' : 'retry',
        accomplishments: gitProgress.commitCount > 0
          ? [`${gitProgress.commitCount} commit(s) made`]
          : [],
        failures: gitProgress.commitCount === 0
          ? ['No commits detected during session']
          : [],
        reasoning: `Fallback evaluation (LLM judge unavailable). Score based on commit count: ${gitProgress.commitCount}.`,
      };
    }

    // 6. Build evaluation record
    const evaluation = {
      sessionId: sessionName,
      projectName,
      startedAt,
      stoppedAt: new Date().toISOString(),
      durationMinutes: durationMin,
      gitProgress: {
        commitCount: gitProgress.commitCount,
        insertions: gitProgress.insertions,
        deletions: gitProgress.deletions,
        filesChanged: gitProgress.filesChanged,
        lastCommitMessage: gitProgress.lastCommitMessage,
        noGit: gitProgress.noGit || false,
      },
      score: parsed.score,
      recommendation: parsed.recommendation,
      accomplishments: parsed.accomplishments,
      failures: parsed.failures,
      reasoning: parsed.reasoning,
      evaluatedAt: new Date().toISOString(),
    };

    // 7. Persist
    const orchestratorDir = path.join(projectDir, '.orchestrator');
    if (!fs.existsSync(orchestratorDir)) {
      fs.mkdirSync(orchestratorDir, { recursive: true });
    }
    fs.writeFileSync(
      path.join(orchestratorDir, 'evaluation.json'),
      JSON.stringify(evaluation, null, 2)
    );

    // Log to state history
    this.state.logEvaluation(this.state.load(), evaluation);

    // Dual-write to SQLite for pattern analysis
    if (this.sessionLearner) {
      try {
        this.sessionLearner.recordEvaluation({ ...evaluation, prompt });
      } catch (e) {
        console.log(`[SessionEvaluator] SQLite write warning: ${e.message}`);
      }
    }

    return evaluation;
  }
}

module.exports = { SessionEvaluator, EVALUATION_SCHEMA };
