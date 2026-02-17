const fs = require("fs");
const path = require("path");

/**
 * ConversationStore - Persistent conversation history with TTL, cap, and credential filtering.
 *
 * Stores conversation entries to a JSON file so that multi-turn SMS context
 * survives daemon restarts. Automatically prunes messages older than TTL and
 * caps total messages. Credential-like strings are redacted before storage.
 */
class ConversationStore {
  /**
   * @param {Object} [options]
   * @param {string} [options.filePath] - Path to JSON persistence file
   * @param {number} [options.maxMessages=20] - Maximum messages to retain
   * @param {number} [options.ttlMs=86400000] - Time-to-live in ms (default 24 hours)
   */
  constructor({ filePath, maxMessages, ttlMs } = {}) {
    this.filePath = filePath || path.join(__dirname, "..", ".conversation-history.json");
    this.maxMessages = maxMessages || 20;
    this.ttlMs = ttlMs || 24 * 60 * 60 * 1000; // 24 hours
  }

  /**
   * Add a conversation entry. Filters credentials from text before persisting.
   * @param {Object} entry - { role: string, text: string, ts: number }
   */
  push(entry) {
    const filtered = {
      role: entry.role,
      text: this._filterCredentials(entry.text || ""),
      ts: entry.ts || Date.now(),
    };

    const entries = this._load();
    entries.push(filtered);

    // Cap to maxMessages (keep newest)
    const capped = entries.length > this.maxMessages
      ? entries.slice(-this.maxMessages)
      : entries;

    this._save(capped);
  }

  /**
   * Get the most recent entries, after pruning expired messages.
   * @param {number} [count=4] - Number of recent entries to return
   * @returns {Array} Last `count` entries
   */
  getRecent(count = 4) {
    const pruned = this._prune();
    return pruned.slice(-count);
  }

  /**
   * Get all entries after pruning expired messages.
   * @returns {Array} All non-expired entries (up to maxMessages)
   */
  getAll() {
    return this._prune();
  }

  /**
   * Clear all conversation history.
   */
  clear() {
    this._save([]);
  }

  /**
   * Load, prune expired entries, cap to maxMessages, save, and return.
   * @returns {Array} Pruned entries
   * @private
   */
  _prune() {
    const entries = this._load();
    const now = Date.now();
    const cutoff = now - this.ttlMs;

    // Remove expired entries
    const alive = entries.filter((e) => e.ts > cutoff);

    // Cap to maxMessages (keep newest)
    const capped = alive.length > this.maxMessages
      ? alive.slice(-this.maxMessages)
      : alive;

    this._save(capped);
    return capped;
  }

  /**
   * Filter credential-like strings from text, replacing with [REDACTED].
   * @param {string} text
   * @returns {string} Text with credentials redacted
   * @private
   */
  _filterCredentials(text) {
    if (!text) return text;

    let filtered = text;

    // OpenAI-style keys: sk-...
    filtered = filtered.replace(/\bsk-[A-Za-z0-9]{20,}\b/g, "[REDACTED]");

    // Stripe live keys: sk_live_...
    filtered = filtered.replace(/\bsk_live_[A-Za-z0-9]+\b/g, "[REDACTED]");

    // GitHub PATs: ghp_...
    filtered = filtered.replace(/\bghp_[A-Za-z0-9]+\b/g, "[REDACTED]");

    // Slack bot tokens: xoxb-...
    filtered = filtered.replace(/\bxoxb-[A-Za-z0-9-]+\b/g, "[REDACTED]");

    // Generic key/token/bearer contexts: key=VALUE, token=VALUE, Bearer VALUE, KEY: VALUE
    filtered = filtered.replace(
      /(?:key=|token=|KEY:|TOKEN:|Bearer\s+)([A-Za-z0-9_\-]{20,})\b/gi,
      (match, secret) => match.replace(secret, "[REDACTED]")
    );

    return filtered;
  }

  /**
   * Load entries from disk. Returns empty array on error or missing file.
   * @returns {Array}
   * @private
   */
  _load() {
    try {
      const data = fs.readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(data);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  /**
   * Save entries to disk as formatted JSON.
   * @param {Array} entries
   * @private
   */
  _save(entries) {
    fs.writeFileSync(this.filePath, JSON.stringify(entries, null, 2));
  }
}

module.exports = ConversationStore;
