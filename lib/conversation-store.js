const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

/**
 * ConversationStore - SQLite-backed conversation history with TTL, cap,
 * keyword search, and credential filtering.
 *
 * Stores conversation entries in orchestrator.db (shared with revenue,
 * trust, and reminders). Automatically prunes messages older than TTL
 * and caps total messages. Credential-like strings are redacted before
 * storage.
 *
 * On first run, migrates any existing .conversation-history.json into
 * SQLite and deletes the JSON file.
 */
class ConversationStore {
  /**
   * @param {Object} [options]
   * @param {string} [options.dbPath] - Path to SQLite database file
   * @param {number} [options.maxMessages=100] - Maximum messages to retain
   * @param {number} [options.ttlMs=604800000] - Time-to-live in ms (default 7 days)
   */
  constructor({ dbPath, maxMessages, ttlMs } = {}) {
    this.dbPath = dbPath || path.join(__dirname, "..", "orchestrator.db");
    this.maxMessages = maxMessages || 100;
    this.ttlMs = ttlMs || 7 * 24 * 60 * 60 * 1000; // 7 days
    this.db = null; // Lazy init
  }

  /**
   * Lazily initialize the SQLite database and create the conversations table.
   * Matches the RevenueTracker _ensureDb pattern.
   * @private
   */
  _ensureDb() {
    if (this.db) return;
    this.db = new Database(this.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        ts INTEGER NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_conversations_ts
      ON conversations(ts)
    `);

    // One-time migration from legacy JSON file
    this._migrateFromJSON();
  }

  /**
   * Add a conversation entry. Filters credentials from text before persisting.
   * @param {Object} entry - { role: string, text: string, ts: number }
   */
  push(entry) {
    this._ensureDb();

    const ts = entry.ts || Date.now();
    const filtered = {
      role: entry.role,
      text: this._filterCredentials(entry.text || ""),
      ts,
      created_at: new Date(ts).toISOString(),
    };

    this.db
      .prepare(
        "INSERT INTO conversations (role, text, ts, created_at) VALUES (?, ?, ?, ?)"
      )
      .run(filtered.role, filtered.text, filtered.ts, filtered.created_at);

    this._prune();
  }

  /**
   * Get the most recent entries, after pruning expired messages.
   * @param {number} [count=4] - Number of recent entries to return
   * @returns {Array} Last `count` entries in chronological order
   */
  getRecent(count = 4) {
    this._ensureDb();
    this._prune();

    const cutoff = Date.now() - this.ttlMs;
    const rows = this.db
      .prepare(
        "SELECT role, text, ts FROM conversations WHERE ts > ? ORDER BY ts DESC LIMIT ?"
      )
      .all(cutoff, count);

    // Return in chronological order (oldest first)
    return rows.reverse();
  }

  /**
   * Get all entries after pruning expired messages.
   * @returns {Array} All non-expired entries (up to maxMessages)
   */
  getAll() {
    this._ensureDb();
    this._prune();

    const cutoff = Date.now() - this.ttlMs;
    return this.db
      .prepare(
        "SELECT role, text, ts FROM conversations WHERE ts > ? ORDER BY ts ASC LIMIT ?"
      )
      .all(cutoff, this.maxMessages);
  }

  /**
   * Search conversation text with case-insensitive LIKE matching.
   * @param {string} query - Search term
   * @returns {Array} Up to 20 matching entries, most recent first
   */
  search(query) {
    this._ensureDb();

    const cutoff = Date.now() - this.ttlMs;
    return this.db
      .prepare(
        "SELECT role, text, ts FROM conversations WHERE ts > ? AND text LIKE ? ORDER BY ts DESC LIMIT 20"
      )
      .all(cutoff, `%${query}%`);
  }

  /**
   * Clear all conversation history.
   */
  clear() {
    this._ensureDb();
    this.db.prepare("DELETE FROM conversations").run();
  }

  /**
   * Close the SQLite database connection.
   */
  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  /**
   * Remove expired entries and cap to maxMessages (keep newest).
   * @private
   */
  _prune() {
    const cutoff = Date.now() - this.ttlMs;

    // Remove expired entries
    this.db
      .prepare("DELETE FROM conversations WHERE ts <= ?")
      .run(cutoff);

    // Cap to maxMessages (keep newest)
    const countRow = this.db
      .prepare("SELECT COUNT(*) as cnt FROM conversations")
      .get();

    if (countRow.cnt > this.maxMessages) {
      const excess = countRow.cnt - this.maxMessages;
      this.db
        .prepare(
          "DELETE FROM conversations WHERE id IN (SELECT id FROM conversations ORDER BY ts ASC LIMIT ?)"
        )
        .run(excess);
    }
  }

  /**
   * One-time migration from legacy .conversation-history.json into SQLite.
   * Reads the JSON file, inserts all entries, then deletes the JSON file.
   * @private
   */
  _migrateFromJSON() {
    const jsonPath = path.join(path.dirname(this.dbPath), ".conversation-history.json");

    try {
      if (!fs.existsSync(jsonPath)) return;

      const data = fs.readFileSync(jsonPath, "utf-8");
      const entries = JSON.parse(data);
      if (!Array.isArray(entries) || entries.length === 0) {
        fs.unlinkSync(jsonPath);
        return;
      }

      const insert = this.db.prepare(
        "INSERT INTO conversations (role, text, ts, created_at) VALUES (?, ?, ?, ?)"
      );

      const insertAll = this.db.transaction((items) => {
        for (const entry of items) {
          const ts = entry.ts || Date.now();
          insert.run(
            entry.role || "unknown",
            entry.text || "",
            ts,
            new Date(ts).toISOString()
          );
        }
      });

      insertAll(entries);
      fs.unlinkSync(jsonPath);
    } catch {
      // Migration is best-effort; don't crash if JSON is malformed
    }
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
}

module.exports = ConversationStore;
