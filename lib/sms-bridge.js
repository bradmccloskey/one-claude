'use strict';

/**
 * SMSBridge — Bridges iMessages to the persistent ONE Claude session.
 *
 * Polls Messenger for new incoming messages, injects them into the Claude
 * tmux session, waits for Claude to finish processing, then sends the
 * response back via iMessage.
 *
 * Security: Only messages from the configured phone number (config.myNumber)
 * are processed. All other sender messages are silently dropped.
 *
 * Dual access: When an SSH user is attached to the tmux session, SMS input
 * is still injected with a [SMS from Brad]: prefix so the SSH user sees it.
 */
class SMSBridge {
  /**
   * @param {Object} opts
   * @param {Object} opts.messenger - Messenger instance
   * @param {Object} opts.claudeSession - ClaudeSession instance
   * @param {Object} opts.state - StateManager instance
   * @param {Object} opts.config - Full config.json
   * @param {Function} opts.log - Logging function (tag, msg)
   */
  constructor({ messenger, claudeSession, state, config, log }) {
    this.messenger = messenger;
    this.claudeSession = claudeSession;
    this.state = state;
    this.config = config;
    this.log = log || ((tag, msg) => console.log(`[${tag}] ${msg}`));

    this.pollIntervalMs = config.pollIntervalMs || 10000;
    this.responseTimeoutMs = config.claudeSession?.responseTimeoutMs || 300000; // 5 min
    this.maxResponseLength = config.maxResponseLength || 1500;

    // Security: extract allowed sender digits for validation
    this._allowedDigits = (config.myNumber || '').replace(/\D/g, '').slice(-10);
    if (!this._allowedDigits || this._allowedDigits.length < 10) {
      throw new Error('SMSBridge: config.myNumber must be a valid phone number');
    }

    // AI enabled state (kill switch)
    this._aiEnabled = true;

    // Mutex to prevent concurrent SMS injections
    this._processing = false;

    // Polling state
    this._pollTimer = null;
  }

  /**
   * Start polling for incoming messages.
   */
  start() {
    // Initialize lastRowId on first run
    const s = this.state.load();
    if (s.lastRowId === 0) {
      const latest = this.messenger.getLatestRowId();
      if (latest) {
        s.lastRowId = latest;
        this.state.save(s);
        this.log('SMS', `Initialized lastRowId: ${s.lastRowId}`);
      }
    }

    this._pollTimer = setInterval(() => this._poll(), this.pollIntervalMs);
    this.log('SMS', `Bridge started (poll: ${this.pollIntervalMs}ms, timeout: ${this.responseTimeoutMs / 1000}s)`);

    // Run initial poll
    this._poll();
  }

  /**
   * Stop polling.
   */
  stop() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  /**
   * Check if AI mode is enabled (kill switch state).
   * @returns {boolean}
   */
  isEnabled() {
    return this._aiEnabled;
  }

  // ── Internal ────────────────────────────────────────────────────

  /**
   * Poll for new messages and process them.
   */
  async _poll() {
    if (this._processing) return;

    try {
      const s = this.state.load();
      const messages = this.messenger.getNewMessages(s.lastRowId);

      for (const msg of messages) {
        // SECURITY: Validate sender matches configured phone number
        if (!this._isAllowedSender(msg.sender_id)) {
          this.log('SMS', `BLOCKED message from unknown sender: ${(msg.sender_id || 'null').substring(0, 20)} (ROWID: ${msg.ROWID})`);
          // Still advance lastRowId so we don't re-process
          s.lastRowId = Math.max(s.lastRowId, msg.ROWID);
          this.state.save(s);
          continue;
        }

        this.log('SMS', `Received: "${msg.text}" (ROWID: ${msg.ROWID})`);

        // Check kill switch BEFORE processing
        const killResult = this._checkKillSwitch(msg.text);
        if (killResult !== null) {
          this.log('SMS', `Kill switch: ${killResult}`);
          this.messenger.send(killResult);
          await this._advanceRowId(s, msg.ROWID);
          continue;
        }

        // Skip if AI is disabled
        if (!this._aiEnabled) {
          this.log('SMS', 'AI disabled, ignoring message');
          await this._advanceRowId(s, msg.ROWID);
          continue;
        }

        // Process through Claude session
        await this._processMessage(msg.text);
        await this._advanceRowId(s, msg.ROWID);
      }
    } catch (e) {
      if (e.message.includes('authorization denied') || e.message.includes('SQLITE_CANTOPEN')) {
        console.error(
          '\nCannot access Messages database!\n' +
          'Grant Full Disk Access to your terminal app:\n' +
          '  System Settings > Privacy & Security > Full Disk Access\n'
        );
        process.exit(1);
      }
      this.log('SMS', `Poll error: ${e.message}`);
    }
  }

  /**
   * SECURITY: Validate that a sender matches the allowed phone number.
   * Only messages from config.myNumber are allowed through.
   * @param {string} senderId - The sender handle from iMessage DB
   * @returns {boolean}
   */
  _isAllowedSender(senderId) {
    if (!senderId) return false;
    // Extract last 10 digits from sender for comparison
    const senderDigits = senderId.replace(/\D/g, '').slice(-10);
    return senderDigits === this._allowedDigits;
  }

  /**
   * Check for kill switch commands.
   * @param {string} text - Message text
   * @returns {string|null} Response if kill switch triggered, null otherwise
   */
  _checkKillSwitch(text) {
    const normalized = text.trim().toLowerCase();

    if (normalized === 'ai off') {
      this._aiEnabled = false;
      return 'AI disabled. Send "ai on" to re-enable.';
    }

    if (normalized === 'ai on') {
      this._aiEnabled = true;
      return 'AI enabled. ONE Claude is listening.';
    }

    return null;
  }

  /**
   * Process a message through the Claude session.
   * Injects input, waits for idle, captures output, sends response.
   * @param {string} text - User message
   */
  async _processMessage(text) {
    this._processing = true;

    try {
      // Check if Claude session is alive
      if (!this.claudeSession.isAlive()) {
        this.messenger.send('ONE Claude session is not running. Attempting restart...');
        const result = this.claudeSession.restart();
        if (!result.success) {
          this.messenger.send(`Restart failed: ${result.message}`);
          return;
        }
        // Wait for Claude to boot up
        await this._sleep(10000);
      }

      // Take a snapshot before injecting input
      const beforeSnapshot = this.claudeSession.captureSnapshot();

      // Inject the message with SMS prefix
      const prefixed = `[SMS from Brad]: ${text}`;
      const sendResult = this.claudeSession.sendInput(prefixed);
      if (!sendResult.success) {
        this.messenger.send(`Failed to send to Claude: ${sendResult.message}`);
        return;
      }

      // Wait for Claude to become idle (with timeout)
      const startTime = Date.now();
      let isIdle = false;

      // Initial wait — give Claude at least 5s to start processing
      await this._sleep(5000);

      while (Date.now() - startTime < this.responseTimeoutMs) {
        isIdle = await this.claudeSession.isIdle();
        if (isIdle) break;
        await this._sleep(3000);
      }

      if (!isIdle) {
        this.messenger.send(
          'Still working on your request... SSH in to see progress: ssh.mccloskey-api.com'
        );
        return;
      }

      // Capture Claude's response
      let response = this.claudeSession.captureOutput(beforeSnapshot);

      if (!response || response.trim().length === 0) {
        // Fallback: capture last 50 lines
        response = this._getLastMeaningfulOutput();
      }

      if (!response || response.trim().length === 0) {
        this.messenger.send('Done (no text output). SSH in for details: ssh.mccloskey-api.com');
        return;
      }

      // Truncate for SMS
      if (response.length > this.maxResponseLength) {
        response = response.substring(0, this.maxResponseLength - 50) +
          '\n\n[Truncated — SSH in for full output]';
      }

      this.messenger.send(response);
    } catch (e) {
      this.log('SMS', `Process error: ${e.message}`);
      this.messenger.send(`Error: ${e.message.substring(0, 200)}`);
    } finally {
      this._processing = false;
    }
  }

  /**
   * Get the last meaningful output from the tmux pane.
   * Falls back to capturing recent lines when diff-based capture fails.
   */
  _getLastMeaningfulOutput() {
    try {
      const raw = this.claudeSession.captureOutput();
      if (!raw) return '';

      // Take the last non-empty lines
      const lines = raw.split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0 && !l.startsWith('>') && !l.startsWith('❯'));

      return lines.slice(-20).join('\n');
    } catch {
      return '';
    }
  }

  /**
   * Advance the lastRowId past our sent message.
   */
  async _advanceRowId(s, msgRowId) {
    await this._sleep(2000);
    const latest = this.messenger.getLatestRowId();
    s.lastRowId = latest || Math.max(s.lastRowId, msgRowId);
    this.state.save(s);
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = SMSBridge;
