'use strict';

const { spawn } = require('child_process');

/**
 * ClaudeSemaphore - Limits concurrent claude -p processes.
 *
 * Gates entry so no more than `maxConcurrent` processes run
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
 * Build the claude CLI args array from options.
 * Shared between claudeP and claudePStream.
 *
 * @param {Object} options
 * @returns {string[]} args array (without 'claude' itself)
 */
function _buildArgs(options = {}) {
  const {
    model = 'sonnet',
    maxTurns = 1,
    outputFormat = 'text',
    jsonSchema = null,
    allowedTools = null,
    dangerouslySkipPermissions = false,
  } = options;

  const args = ['-p'];

  if (dangerouslySkipPermissions) {
    args.push('--dangerously-skip-permissions');
  }

  args.push('--model', model);
  args.push('--max-turns', String(maxTurns));

  if (jsonSchema) {
    args.push('--output-format', 'text');
    args.push('--json-schema', jsonSchema);
  } else {
    args.push('--output-format', outputFormat);
  }

  if (allowedTools) {
    if (allowedTools.length === 0) {
      args.push('--allowedTools', '');
    } else {
      for (const tool of allowedTools) {
        args.push('--allowedTools', tool);
      }
    }
  }

  return args;
}

/**
 * claudeP - Centralized async wrapper for all `claude -p` invocations.
 *
 * Uses child_process.spawn (non-blocking) instead of execSync.
 * The event loop remains free while claude runs.
 *
 * @param {string} prompt - The prompt text (passed via stdin)
 * @param {Object} [options]
 * @param {string} [options.model='sonnet'] - Model name
 * @param {number} [options.maxTurns=1] - Max turns (always enforced)
 * @param {string} [options.outputFormat='text'] - Output format: 'text' or 'json'
 * @param {string} [options.jsonSchema] - JSON schema string (forces outputFormat to 'json')
 * @param {number} [options.timeout=30000] - Timeout in ms
 * @param {string[]} [options.allowedTools] - Allowed tools list
 * @param {Function} [options.onProgress] - Callback for streaming stdout chunks
 * @returns {Promise<string>} Trimmed stdout from claude -p
 * @throws {Error} On timeout (.code = 'ETIMEDOUT') or non-zero exit (.stderr attached)
 */
async function claudeP(prompt, options = {}) {
  const { timeout = 30000, onProgress = null } = options;
  const args = _buildArgs(options);

  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    // Timeout handling
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
      // Give 5s to clean up, then SIGKILL
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
      }, 5000);
    }, timeout);

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (onProgress) {
        try { onProgress(text); } catch {}
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);

      if (killed) {
        const timeoutErr = new Error(`claude -p timed out after ${timeout}ms`);
        timeoutErr.code = 'ETIMEDOUT';
        timeoutErr.stderr = stderr;
        return reject(timeoutErr);
      }

      if (code !== 0) {
        const exitErr = new Error(
          `claude -p exited with code ${code}: ${stderr.substring(0, 500) || 'no stderr'}`
        );
        exitErr.code = `EXIT_${code}`;
        exitErr.status = code;
        exitErr.stderr = stderr;
        return reject(exitErr);
      }

      resolve(stdout.trim());
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    // Write prompt to stdin and close
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/**
 * claudePStream - Returns the child process for streaming use cases.
 * Caller manages the child lifecycle. Still uses semaphore externally.
 *
 * @param {string} prompt - The prompt text
 * @param {Object} [options] - Same options as claudeP (minus timeout - caller manages)
 * @returns {{ child: ChildProcess, result: Promise<string> }}
 */
function claudePStream(prompt, options = {}) {
  const { timeout = 300000 } = options;
  const args = _buildArgs(options);

  const child = spawn('claude', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  let stdout = '';
  let stderr = '';
  let killed = false;

  const timer = setTimeout(() => {
    killed = true;
    child.kill('SIGTERM');
    setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
    }, 5000);
  }, timeout);

  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const result = new Promise((resolve, reject) => {
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) {
        const err = new Error(`claude -p timed out after ${timeout}ms`);
        err.code = 'ETIMEDOUT';
        err.stderr = stderr;
        return reject(err);
      }
      if (code !== 0) {
        const err = new Error(`claude -p exited with code ${code}: ${stderr.substring(0, 500) || 'no stderr'}`);
        err.code = `EXIT_${code}`;
        err.status = code;
        err.stderr = stderr;
        return reject(err);
      }
      resolve(stdout.trim());
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  // Write prompt to stdin and close
  child.stdin.write(prompt);
  child.stdin.end();

  return { child, result };
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
    return await claudeP(prompt, options);
  } finally {
    _semaphore.release();
  }
}

module.exports = {
  claudeP,
  claudePWithSemaphore,
  claudePStream,
  ClaudeSemaphore,
  _semaphore,
  _buildArgs,
};
