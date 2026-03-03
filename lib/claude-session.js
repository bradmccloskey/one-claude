'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * ClaudeSession — Manages a persistent Claude Code session in tmux.
 *
 * The ONE Claude brain runs as `claude --dangerously-skip-permissions` inside
 * tmux session "one-claude". This class handles lifecycle, input injection,
 * output capture, idle detection, and crash recovery.
 *
 * Dual access:
 *   iPhone SMS → SMSBridge → sendInput() → tmux → captureOutput() → iMessage
 *   MacBook SSH → tmux attach -t one-claude → same session
 */
class ClaudeSession {
  /**
   * @param {Object} opts
   * @param {Object} opts.config - Full config.json object
   * @param {Function} opts.log - Logging function (tag, msg)
   * @param {Object} [opts.notificationManager] - For crash notifications
   */
  constructor({ config, log, notificationManager }) {
    this.config = config;
    this.log = log || ((tag, msg) => console.log(`[${tag}] ${msg}`));
    this.notificationManager = notificationManager;

    const sessionConfig = config.claudeSession || {};
    this.sessionName = sessionConfig.sessionName || 'one-claude';
    this.maxRestartsPerHour = sessionConfig.maxRestarts || 3;
    this.healthCheckIntervalMs = sessionConfig.healthCheckMs || 30000;

    this._restartTimestamps = [];
    this._healthTimer = null;
    this._started = false;
  }

  /**
   * Start the persistent Claude session in tmux.
   * Creates the tmux session and launches Claude Code inside it.
   * @returns {{ success: boolean, message: string }}
   */
  start() {
    if (this._tmuxSessionExists()) {
      this.log('CLAUDE', `Session "${this.sessionName}" already exists, reusing`);
      this._started = true;
      this._startHealthLoop();
      return { success: true, message: 'Reusing existing session' };
    }

    try {
      const orchestratorDir = path.join(__dirname, '..');
      const launcherPath = this._buildLauncher(orchestratorDir);

      const tmuxCmd = launcherPath
        ? `tmux new-session -d -s "${this.sessionName}" -c "${orchestratorDir}" "${launcherPath}"`
        : `tmux new-session -d -s "${this.sessionName}" -c "${orchestratorDir}" "claude --dangerously-skip-permissions"`;

      execSync(tmuxCmd, { timeout: 10000 });
      this._started = true;
      this.log('CLAUDE', `Session "${this.sessionName}" started`);
      this._startHealthLoop();
      return { success: true, message: 'Session started' };
    } catch (e) {
      this.log('CLAUDE', `Failed to start session: ${e.message}`);
      return { success: false, message: e.message };
    }
  }

  /**
   * Gracefully stop the Claude session.
   */
  stop() {
    this._stopHealthLoop();
    if (!this._tmuxSessionExists()) {
      this._started = false;
      return;
    }

    try {
      // Send /exit to Claude, then kill if needed
      execSync(`tmux send-keys -t "${this.sessionName}" "/exit" Enter`, { timeout: 5000 });
      // Wait briefly for graceful exit
      try { execSync('sleep 3'); } catch {}
      if (this._tmuxSessionExists()) {
        execSync(`tmux kill-session -t "${this.sessionName}"`, { timeout: 5000 });
      }
    } catch {
      // Force kill
      try { execSync(`tmux kill-session -t "${this.sessionName}"`, { timeout: 5000 }); } catch {}
    }
    this._started = false;
    this.log('CLAUDE', 'Session stopped');
  }

  /**
   * Restart the session.
   */
  restart() {
    this.log('CLAUDE', 'Restarting session...');
    this.stop();
    // Wait for cleanup
    try { execSync('sleep 2'); } catch {}
    return this.start();
  }

  /**
   * Check if Claude is idle (ready for input).
   * Compares 3 consecutive capture-pane snapshots 2s apart.
   * If all 3 are identical and no spinner chars, Claude is idle.
   * @returns {Promise<boolean>}
   */
  async isIdle() {
    const snapshots = [];
    for (let i = 0; i < 3; i++) {
      if (i > 0) await this._sleep(2000);
      snapshots.push(this._capturePane());
    }

    // All 3 snapshots must be identical
    if (snapshots[0] !== snapshots[1] || snapshots[1] !== snapshots[2]) {
      return false;
    }

    // Check for spinner characters that indicate work in progress
    const last = snapshots[2];
    const spinnerChars = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏', '◐', '◓', '◑', '◒'];
    for (const ch of spinnerChars) {
      if (last.includes(ch)) return false;
    }

    return true;
  }

  /**
   * Send input text to the Claude session via tmux.
   * Uses load-buffer + paste-buffer to avoid shell escaping issues.
   * @param {string} text - Text to inject
   * @returns {{ success: boolean, message: string }}
   */
  sendInput(text) {
    if (!this._tmuxSessionExists()) {
      return { success: false, message: 'Session not running' };
    }

    try {
      const tmpFile = `/tmp/one-claude-input-${Date.now()}.txt`;
      fs.writeFileSync(tmpFile, text);
      execSync(`tmux load-buffer "${tmpFile}"`, { timeout: 5000 });
      execSync(`tmux paste-buffer -t "${this.sessionName}"`, { timeout: 5000 });
      execSync('sleep 1');
      execSync(`tmux send-keys -t "${this.sessionName}" Enter`, { timeout: 5000 });
      try { fs.unlinkSync(tmpFile); } catch {}
      return { success: true, message: 'Input sent' };
    } catch (e) {
      return { success: false, message: e.message };
    }
  }

  /**
   * Capture output from the Claude session.
   * Diffs current pane content against a baseline snapshot.
   * @param {string} [beforeSnapshot] - Baseline to diff against (from captureSnapshot())
   * @returns {string} New output text, cleaned of ANSI codes
   */
  captureOutput(beforeSnapshot) {
    const current = this._capturePane();
    let output = current;

    if (beforeSnapshot) {
      // Find new content by diffing against baseline
      const beforeLines = beforeSnapshot.split('\n');
      const currentLines = current.split('\n');

      // Find the first line that differs
      let diffStart = 0;
      for (let i = 0; i < Math.min(beforeLines.length, currentLines.length); i++) {
        if (beforeLines[i] !== currentLines[i]) {
          diffStart = i;
          break;
        }
        diffStart = i + 1;
      }

      output = currentLines.slice(diffStart).join('\n');
    }

    return this._cleanOutput(output);
  }

  /**
   * Take a snapshot of the current pane content for later diffing.
   * @returns {string} Raw pane content
   */
  captureSnapshot() {
    return this._capturePane();
  }

  /**
   * Check if the tmux session is alive.
   * @returns {boolean}
   */
  isAlive() {
    return this._tmuxSessionExists();
  }

  // ── Internal methods ────────────────────────────────────────────

  /**
   * Build launcher script that unlocks keychain before starting Claude.
   * Reuses pattern from session-manager.js.
   */
  _buildLauncher(workDir) {
    const pwFile = path.join(__dirname, '..', '.keychain-password');
    if (!fs.existsSync(pwFile)) return null;

    const password = fs.readFileSync(pwFile, 'utf-8').trim();
    const launcherPath = path.join(workDir, '.one-claude-launcher.sh');
    const script = [
      '#!/bin/bash',
      `security unlock-keychain -p "${password}" ~/Library/Keychains/login.keychain-db 2>/dev/null`,
      'exec claude --dangerously-skip-permissions',
    ].join('\n') + '\n';

    fs.writeFileSync(launcherPath, script, { mode: 0o700 });
    return launcherPath;
  }

  /**
   * Check if the tmux session exists.
   */
  _tmuxSessionExists() {
    try {
      execSync(`tmux has-session -t "${this.sessionName}" 2>/dev/null`, { timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Capture the last 500 lines of the tmux pane.
   */
  _capturePane() {
    try {
      return execSync(
        `tmux capture-pane -t "${this.sessionName}" -p -S -500 2>/dev/null`,
        { encoding: 'utf-8', timeout: 5000 }
      );
    } catch {
      return '';
    }
  }

  /**
   * Clean terminal output: strip ANSI codes, box-drawing chars, UI chrome.
   */
  _cleanOutput(raw) {
    if (!raw) return '';
    return raw
      // Strip ANSI escape codes
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
      .replace(/\x1b\][^\x07]*\x07/g, '')
      .replace(/\x1b\[[\d;]*m/g, '')
      // Strip box-drawing characters
      .replace(/[─━│┃┌┐└┘├┤┬┴┼╋╭╮╯╰═║╔╗╚╝╠╣╦╩╬]+/g, '')
      // Strip Claude Code UI elements
      .replace(/⏵+\s*bypass permissions[^\n]*/gi, '')
      .replace(/\(shift\+tab to cycle\)/gi, '')
      // Collapse excessive whitespace
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /**
   * Start the health check loop.
   * Checks every 30s if the session is alive, auto-restarts on crash.
   */
  _startHealthLoop() {
    if (this._healthTimer) return;

    this._healthTimer = setInterval(() => {
      if (!this._started) return;

      if (!this._tmuxSessionExists()) {
        this.log('CLAUDE', 'Session crashed! Attempting restart...');

        // Check restart budget
        const oneHourAgo = Date.now() - 3600000;
        this._restartTimestamps = this._restartTimestamps.filter(t => t > oneHourAgo);

        if (this._restartTimestamps.length >= this.maxRestartsPerHour) {
          this.log('CLAUDE', `Restart budget exhausted (${this.maxRestartsPerHour}/hour). Manual intervention needed.`);
          if (this.notificationManager) {
            this.notificationManager.notify(
              'ONE Claude session crashed and restart budget exhausted. Manual restart needed.',
              1 // URGENT
            );
          }
          return;
        }

        this._restartTimestamps.push(Date.now());
        const result = this.start();

        if (this.notificationManager) {
          const msg = result.success
            ? 'ONE Claude session crashed and was auto-restarted.'
            : `ONE Claude session crashed. Restart failed: ${result.message}`;
          this.notificationManager.notify(msg, 1);
        }
      }
    }, this.healthCheckIntervalMs);
  }

  /**
   * Stop the health check loop.
   */
  _stopHealthLoop() {
    if (this._healthTimer) {
      clearInterval(this._healthTimer);
      this._healthTimer = null;
    }
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = ClaudeSession;
