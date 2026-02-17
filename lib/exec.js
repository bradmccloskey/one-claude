'use strict';

const { execSync } = require('child_process');

/**
 * ClaudeSemaphore - Limits concurrent claude -p processes.
 *
 * Since claudeP uses execSync (blocking), the semaphore gates entry
 * so no more than `maxConcurrent` processes block the event loop
 * simultaneously. Callers wait via a Promise queue.
 */
class ClaudeSemaphore {
  /**
   * @param {number} maxConcurrent - Maximum concurrent slots (default 2)
   */
  constructor(maxConcurrent = 2) {
    this._max = maxConcurrent;
    this._active = 0;
    this._queue = []; // Array of { resolve } waiters
  }

  /** Number of currently running processes */
  get active() {
    return this._active;
  }

  /** Number of callers waiting for a slot */
  get pending() {
    return this._queue.length;
  }

  /**
   * Acquire a semaphore slot. Resolves immediately if a slot is
   * available, otherwise waits until one is freed.
   * @returns {Promise<void>}
   */
  async acquire() {
    if (this._active < this._max) {
      this._active++;
      return;
    }

    // All slots taken -- wait in queue
    return new Promise((resolve) => {
      this._queue.push({ resolve });
    });
  }

  /**
   * Release a semaphore slot. If waiters are queued, the next one
   * is resolved (and inherits the slot).
   */
  release() {
    if (this._queue.length > 0) {
      // Hand the slot directly to the next waiter
      const next = this._queue.shift();
      next.resolve();
    } else {
      this._active--;
    }
  }
}

// Singleton semaphore instance (max 2 concurrent claude -p processes)
const _semaphore = new ClaudeSemaphore(2);

/**
 * claudeP - Centralized wrapper for all `claude -p` invocations.
 *
 * Constructs the CLI command with proper flags and executes via execSync.
 * NEVER includes --dangerously-skip-permissions.
 *
 * @param {string} prompt - The prompt text (passed via stdin)
 * @param {Object} [options]
 * @param {string} [options.model='sonnet'] - Model name
 * @param {number} [options.maxTurns=1] - Max turns (always enforced)
 * @param {string} [options.outputFormat='text'] - Output format: 'text' or 'json'
 * @param {string} [options.jsonSchema] - JSON schema string (forces outputFormat to 'json')
 * @param {number} [options.timeout=30000] - execSync timeout in ms
 * @param {string[]} [options.allowedTools] - Future: MCP allowed tools
 * @returns {string} Trimmed stdout from claude -p
 * @throws {Error} On timeout (.code = 'ETIMEDOUT') or non-zero exit (.stderr attached)
 */
function claudeP(prompt, options = {}) {
  const {
    model = 'sonnet',
    maxTurns = 1,
    outputFormat = 'text',
    jsonSchema = null,
    timeout = 30000,
    allowedTools = null,
  } = options;

  // Build command parts
  const parts = ['claude', '-p'];

  parts.push('--model', model);
  parts.push('--max-turns', String(maxTurns));

  if (jsonSchema) {
    // JSON schema implies json output format
    parts.push('--output-format', 'json');
    // Shell-escape the schema by wrapping in single quotes
    // (internal single quotes replaced with '\'' pattern)
    const escapedSchema = jsonSchema.replace(/'/g, "'\\''");
    parts.push('--json-schema', `'${escapedSchema}'`);
  } else {
    parts.push('--output-format', outputFormat);
  }

  if (allowedTools && allowedTools.length > 0) {
    for (const tool of allowedTools) {
      parts.push('--allowedTools', tool);
    }
  }

  const command = parts.join(' ');

  try {
    const result = execSync(command, {
      input: prompt,
      encoding: 'utf-8',
      timeout,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return result.trim();
  } catch (err) {
    // Enhance error with consistent shape
    if (err.killed && err.signal === 'SIGTERM') {
      // execSync timeout sends SIGTERM
      const timeoutErr = new Error(`claude -p timed out after ${timeout}ms`);
      timeoutErr.code = 'ETIMEDOUT';
      timeoutErr.stderr = err.stderr ? String(err.stderr) : '';
      throw timeoutErr;
    }

    // Non-zero exit code
    if (err.status != null) {
      const exitErr = new Error(
        `claude -p exited with code ${err.status}: ${err.stderr ? String(err.stderr).substring(0, 500) : 'no stderr'}`
      );
      exitErr.code = `EXIT_${err.status}`;
      exitErr.status = err.status;
      exitErr.stderr = err.stderr ? String(err.stderr) : '';
      throw exitErr;
    }

    // Unknown error -- rethrow
    throw err;
  }
}

/**
 * claudePWithSemaphore - Production wrapper that acquires a semaphore
 * slot before running claudeP. Ensures no more than 2 concurrent
 * claude -p processes.
 *
 * @param {string} prompt - The prompt text
 * @param {Object} [options] - Same options as claudeP
 * @returns {Promise<string>} Trimmed stdout from claude -p
 */
async function claudePWithSemaphore(prompt, options = {}) {
  await _semaphore.acquire();
  try {
    return claudeP(prompt, options);
  } finally {
    _semaphore.release();
  }
}

module.exports = {
  claudeP,
  claudePWithSemaphore,
  ClaudeSemaphore,
  _semaphore,
};
