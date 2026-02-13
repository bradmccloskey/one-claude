const { execSync } = require("child_process");
const fs = require("fs");
const Database = require("better-sqlite3");
const os = require("os");
const path = require("path");

/**
 * Messenger - iMessage send/receive adapted from claude-sms.
 * Sends via AppleScript JXA with env var message passing.
 * Receives by polling macOS Messages SQLite database.
 */
class Messenger {
  constructor(config) {
    this.myNumber = config.myNumber;
    this.claudeNumber = config.claudeNumber;
    this.maxResponseLength = config.maxResponseLength || 1500;
    this.dbPath = path.join(os.homedir(), "Library/Messages/chat.db");
    this._chatIds = null;
  }

  /**
   * Send an iMessage. Chunks long messages with intelligent breaks.
   * @param {string} text - Message text to send
   */
  send(text) {
    const chunks = this._chunkMessage(text);
    const digits = this.myNumber.replace(/\D/g, "").slice(-10);

    for (let i = 0; i < chunks.length; i++) {
      const chunk =
        chunks.length > 1 ? `[${i + 1}/${chunks.length}] ${chunks[i]}` : chunks[i];

      const tmpScript = `/tmp/imessage-orch-${Date.now()}.js`;
      fs.writeFileSync(
        tmpScript,
        `
const m = Application("Messages");
const chat = m.chats().find(c => c.id().includes("${digits}"));
if (!chat) throw new Error("No chat found matching ${digits}");
const text = $.NSProcessInfo.processInfo.environment.objectForKey("IMSG_TEXT").js;
m.send(text, { to: chat });
`
      );

      try {
        execSync(`IMSG_TEXT=${JSON.stringify(chunk)} osascript -l JavaScript "${tmpScript}"`, {
          timeout: 30000,
        });
        fs.unlinkSync(tmpScript);
        if (i < chunks.length - 1) {
          execSync("sleep 1");
        }
      } catch (e) {
        console.error(`[SEND ERROR] ${e.message}`);
        try { fs.unlinkSync(tmpScript); } catch {}
      }
    }
  }

  /**
   * Get new incoming messages since the given ROWID
   * @param {number} lastRowId - Only return messages after this ROWID
   * @returns {Array} Array of message objects with .ROWID and .text
   */
  getNewMessages(lastRowId) {
    const chatIds = this._getChatIds();
    if (!chatIds) return [];

    const db = new Database(this.dbPath, { readonly: true, fileMustExist: true });
    try {
      const placeholders = chatIds.map(() => "?").join(",");
      const myDigits = this.myNumber.replace(/\D/g, "").slice(-10);

      const rows = db
        .prepare(
          `SELECT DISTINCT m.ROWID, m.text, m.date, m.is_from_me,
                  h.id as sender_id
           FROM message m
           JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
           LEFT JOIN handle h ON m.handle_id = h.ROWID
           WHERE cmj.chat_id IN (${placeholders})
             AND m.ROWID > ?
             AND m.text IS NOT NULL
             AND m.text != ''
             AND h.id LIKE ?
           ORDER BY m.ROWID ASC`
        )
        .all(...chatIds, lastRowId, `%${myDigits}%`);

      return rows;
    } finally {
      db.close();
    }
  }

  /**
   * Get the latest ROWID from our chat (for skipping past sent messages)
   * @returns {number|null}
   */
  getLatestRowId() {
    const chatIds = this._getChatIds();
    if (!chatIds) return null;

    const db = new Database(this.dbPath, { readonly: true, fileMustExist: true });
    try {
      const placeholders = chatIds.map(() => "?").join(",");
      const row = db
        .prepare(
          `SELECT MAX(m.ROWID) as maxId FROM message m
           JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
           WHERE cmj.chat_id IN (${placeholders})`
        )
        .get(...chatIds);
      return row?.maxId || null;
    } finally {
      db.close();
    }
  }

  /**
   * Find and cache chat IDs for our conversation
   * @returns {number[]|null}
   */
  _getChatIds() {
    if (this._chatIds) return this._chatIds;

    const db = new Database(this.dbPath, { readonly: true, fileMustExist: true });
    try {
      const myDigits = this.myNumber.replace(/\D/g, "").slice(-10);
      const claudeDigits = this.claudeNumber.replace(/\D/g, "").slice(-10);
      const chats = db
        .prepare(
          `SELECT ROWID FROM chat
           WHERE chat_identifier LIKE ? OR chat_identifier LIKE ?`
        )
        .all(`%${myDigits}%`, `%${claudeDigits}%`);

      if (chats.length === 0) return null;
      this._chatIds = [...new Set(chats.map((c) => c.ROWID))];
      return this._chatIds;
    } finally {
      db.close();
    }
  }

  /**
   * Split long messages into chunks at intelligent break points
   * @param {string} text
   * @returns {string[]}
   */
  _chunkMessage(text) {
    const maxLen = this.maxResponseLength;
    if (text.length <= maxLen) return [text];

    const chunks = [];
    let remaining = text;
    while (remaining.length > 0) {
      let breakAt = maxLen;
      if (remaining.length > maxLen) {
        const lastNewline = remaining.lastIndexOf("\n", maxLen);
        const lastSpace = remaining.lastIndexOf(" ", maxLen);
        if (lastNewline > maxLen * 0.5) breakAt = lastNewline + 1;
        else if (lastSpace > maxLen * 0.5) breakAt = lastSpace + 1;
      }
      chunks.push(remaining.substring(0, breakAt));
      remaining = remaining.substring(breakAt);
    }
    return chunks;
  }
}

module.exports = Messenger;
