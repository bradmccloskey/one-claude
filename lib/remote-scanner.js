'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const REGISTRY_DIR = path.join(process.env.HOME || '/Users/claude', '.claude', 'remote-sessions');
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * RemoteScanner — Discovers Claude Code remote-control sessions.
 *
 * Two data sources:
 *   1. Registry files in ~/.claude/remote-sessions/*.json (user-registered URLs)
 *   2. Process scanning for running `claude` processes (detected sessions)
 *
 * Registry format:
 *   { id, url, label, pid?, created, lastSeen }
 */
class RemoteScanner {
  constructor() {
    this._ensureDir();
  }

  _ensureDir() {
    try {
      fs.mkdirSync(REGISTRY_DIR, { recursive: true });
    } catch {}
  }

  /**
   * Register a remote session URL.
   * @param {string} url - The remote control URL (e.g. https://claude.ai/code?bridge=xxx)
   * @param {string} [label] - Human-readable label (defaults to extracted from URL or 'Unnamed')
   * @param {number} [pid] - Optional PID of the Claude process
   * @returns {Object} The created entry
   */
  register(url, label, pid) {
    if (!url || typeof url !== 'string') {
      throw new Error('URL is required');
    }

    // Validate URL format
    if (!url.includes('claude.ai/code') && !url.includes('bridge=')) {
      throw new Error('Invalid remote control URL — expected https://claude.ai/code?bridge=...');
    }

    const id = this._generateId();
    const entry = {
      id,
      url: url.trim(),
      label: (label || this._extractLabel(url)).trim(),
      pid: pid || null,
      created: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    };

    const filePath = path.join(REGISTRY_DIR, `${id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(entry, null, 2));

    return entry;
  }

  /**
   * Remove a registered session by ID.
   * @param {string} id
   * @returns {boolean} True if removed
   */
  remove(id) {
    const filePath = path.join(REGISTRY_DIR, `${id}.json`);
    try {
      fs.unlinkSync(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get all registered remote sessions, pruning stale entries.
   * @returns {Array<Object>}
   */
  getRegistered() {
    this._ensureDir();
    const entries = [];
    const now = Date.now();

    try {
      const files = fs.readdirSync(REGISTRY_DIR).filter(f => f.endsWith('.json'));
      for (const file of files) {
        try {
          const filePath = path.join(REGISTRY_DIR, file);
          const raw = fs.readFileSync(filePath, 'utf-8');
          const entry = JSON.parse(raw);

          // Auto-prune entries older than 24 hours
          const age = now - new Date(entry.created).getTime();
          if (age > STALE_THRESHOLD_MS) {
            try { fs.unlinkSync(filePath); } catch {}
            continue;
          }

          // Check if PID is still alive
          if (entry.pid) {
            entry.alive = this._isPidAlive(entry.pid);
          } else {
            entry.alive = null; // unknown
          }

          entries.push(entry);
        } catch {}
      }
    } catch {}

    // Sort newest first
    entries.sort((a, b) => new Date(b.created) - new Date(a.created));
    return entries;
  }

  /**
   * Detect running Claude Code processes on the system.
   * @returns {Array<Object>} List of detected sessions
   */
  detectProcesses() {
    try {
      // Match actual claude CLI binary processes, not just anything in /Users/claude/
      // Look for the claude-code binary or `claude` command invocations
      const psOutput = execSync(
        'ps aux | grep -E "claude-code/cli|/bin/claude |claude remote|claude rc " | grep -v "grep" | grep -v "orchestrator"',
        { encoding: 'utf-8', timeout: 5000 }
      ).trim();

      if (!psOutput) return [];

      const processes = [];
      for (const line of psOutput.split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 11) continue;

        const pid = parseInt(parts[1], 10);
        const cpu = parts[2];
        const mem = parts[3];
        const startTime = parts[9];
        const command = parts.slice(10).join(' ');

        const isRemoteControl = command.includes('remote-control') ||
                                command.includes('remote') ||
                                command.includes('bridge') ||
                                command.includes(' rc');

        // Try to get working directory via lsof
        let cwd = null;
        try {
          const lsofOut = execSync(`lsof -p ${pid} -Fn 2>/dev/null | grep '^n.*projects' | head -1`, {
            encoding: 'utf-8',
            timeout: 3000,
          }).trim();
          if (lsofOut) {
            cwd = lsofOut.substring(1); // Remove 'n' prefix
          }
        } catch {}

        processes.push({
          pid,
          cpu,
          mem,
          startTime,
          command: command.length > 120 ? command.substring(0, 120) + '...' : command,
          isRemoteControl,
          cwd,
        });
      }

      return processes;
    } catch {
      return [];
    }
  }

  /**
   * Get combined view: registered URLs + detected processes.
   * @returns {Object}
   */
  getAll() {
    return {
      registered: this.getRegistered(),
      processes: this.detectProcesses(),
    };
  }

  // ── Helpers ──────────────────────────────────────────────────

  _generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
  }

  _extractLabel(url) {
    try {
      const u = new URL(url);
      const bridge = u.searchParams.get('bridge');
      if (bridge) return 'Session ' + bridge.substring(0, 8);
    } catch {}
    return 'Unnamed Session';
  }

  _isPidAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = RemoteScanner;
