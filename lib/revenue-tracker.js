const Database = require('better-sqlite3');
const path = require('path');

class RevenueTracker {
  constructor({ config }) {
    this.config = config;
    this.db = null; // Lazy init
    this._lastCollectionTime = 0;
    this._lastPruneTime = 0;
  }

  _ensureDb() {
    if (this.db) return;
    const dbPath = path.join(__dirname, '..', 'orchestrator.db');
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS revenue_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        collected_at TEXT NOT NULL,
        balance_atomic INTEGER,
        paid_atomic INTEGER,
        hashrate REAL,
        xmr_price_usd REAL,
        requests_served INTEGER,
        tokens_generated INTEGER,
        raw_json TEXT
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_revenue_source_time
      ON revenue_snapshots(source, collected_at)
    `);
  }

  async collect() {
    this._ensureDb();
    const now = new Date().toISOString();

    // Collect from each source independently
    await Promise.allSettled([
      this._collectXMR(now),
      this._collectMLX(now),
    ]);

    this._lastCollectionTime = Date.now();

    // Prune old data periodically (every 24 hours worth of collections)
    this._maybePrune();
  }

  async _collectXMR(collectedAt) {
    const wallet = this.config.revenue?.xmrWallet;
    if (!wallet) return;

    let poolData = null;
    let priceData = null;

    // Fetch pool stats
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      const response = await fetch(
        `https://www.supportxmr.com/api/miner/${wallet}/stats`,
        { signal: controller.signal }
      );
      clearTimeout(timeoutId);
      if (response.ok) {
        poolData = await response.json();
      }
    } catch {}

    // Fetch XMR price
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      const response = await fetch(
        'https://api.coingecko.com/api/v3/simple/price?ids=monero&vs_currencies=usd',
        { signal: controller.signal }
      );
      clearTimeout(timeoutId);
      if (response.ok) {
        priceData = await response.json();
      }
    } catch {}

    // Store snapshot -- NULL for fields we couldn't fetch
    const stmt = this.db.prepare(`
      INSERT INTO revenue_snapshots
        (source, collected_at, balance_atomic, paid_atomic, hashrate, xmr_price_usd, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      'xmr-mining',
      collectedAt,
      poolData?.amtDue ?? null,
      poolData?.amtPaid ?? null,
      poolData?.hash ?? null,
      priceData?.monero?.usd ?? null,
      poolData ? JSON.stringify(poolData) : null,
    );
  }

  async _collectMLX(collectedAt) {
    let healthData = null;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      const response = await fetch('http://localhost:8100/health', {
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (response.ok) {
        healthData = await response.json();
      }
    } catch {}

    const stmt = this.db.prepare(`
      INSERT INTO revenue_snapshots
        (source, collected_at, requests_served, tokens_generated, raw_json)
      VALUES (?, ?, ?, ?, ?)
    `);

    stmt.run(
      'mlx-api',
      collectedAt,
      healthData?.requests_served ?? null,
      healthData?.total_tokens_generated ?? null,
      healthData ? JSON.stringify(healthData) : null,
    );
  }

  getLatest() {
    this._ensureDb();
    const result = {};

    for (const source of ['xmr-mining', 'mlx-api']) {
      const row = this.db.prepare(`
        SELECT * FROM revenue_snapshots
        WHERE source = ?
        ORDER BY collected_at DESC
        LIMIT 1
      `).get(source);

      if (row) {
        const ageMs = Date.now() - new Date(row.collected_at).getTime();
        const ageMinutes = Math.round(ageMs / 60000);
        result[source] = { ...row, ageMinutes };
      } else {
        result[source] = null;
      }
    }

    return result;
  }

  formatForContext() {
    const latest = this.getLatest();
    if (!latest['xmr-mining'] && !latest['mlx-api']) return null;

    const lines = ['Revenue:'];

    // XMR Mining
    const xmr = latest['xmr-mining'];
    if (xmr && xmr.balance_atomic !== null) {
      const balanceXMR = xmr.balance_atomic / 1e12;
      const balanceUSD = xmr.xmr_price_usd ? (balanceXMR * xmr.xmr_price_usd).toFixed(2) : '?';
      const totalXMR = ((xmr.balance_atomic + (xmr.paid_atomic || 0)) / 1e12).toFixed(6);
      const ageStr = this._formatAge(xmr.ageMinutes);
      lines.push(`- XMR Mining: $${balanceUSD} balance (${balanceXMR.toFixed(6)} XMR), hashrate ${xmr.hashrate || 0} H/s (${ageStr})`);
    } else if (xmr) {
      lines.push(`- XMR Mining: data unavailable (${this._formatAge(xmr.ageMinutes)})`);
    } else {
      lines.push('- XMR Mining: no data collected yet');
    }

    // MLX API
    const mlx = latest['mlx-api'];
    if (mlx && mlx.requests_served !== null) {
      const ageStr = this._formatAge(mlx.ageMinutes);
      lines.push(`- MLX API: ${mlx.requests_served} requests served, ${mlx.tokens_generated || 0} tokens (${ageStr})`);
    } else if (mlx) {
      lines.push(`- MLX API: data unavailable (${this._formatAge(mlx.ageMinutes)})`);
    } else {
      lines.push('- MLX API: no data collected yet');
    }

    return lines.join('\n');
  }

  _formatAge(ageMinutes) {
    if (ageMinutes > 60) {
      const hours = Math.round(ageMinutes / 60);
      return hours > 1 ? `STALE: ${hours}h ago` : `${ageMinutes}min ago`;
    }
    return `${ageMinutes}min ago`;
  }

  getWeeklyTrend() {
    this._ensureDb();

    const now = new Date();
    const thisWeekStart = new Date(now);
    thisWeekStart.setDate(now.getDate() - now.getDay()); // Start of this week (Sunday)
    thisWeekStart.setHours(0, 0, 0, 0);

    const lastWeekStart = new Date(thisWeekStart);
    lastWeekStart.setDate(lastWeekStart.getDate() - 7);

    const thisWeekISO = thisWeekStart.toISOString();
    const lastWeekISO = lastWeekStart.toISOString();
    const nowISO = now.toISOString();

    // Get XMR balance change this week (latest balance - earliest balance of the week)
    const getXMRChange = (startISO, endISO) => {
      const earliest = this.db.prepare(`
        SELECT balance_atomic, xmr_price_usd FROM revenue_snapshots
        WHERE source = 'xmr-mining' AND collected_at >= ? AND collected_at < ?
          AND balance_atomic IS NOT NULL
        ORDER BY collected_at ASC LIMIT 1
      `).get(startISO, endISO);

      const latest = this.db.prepare(`
        SELECT balance_atomic, paid_atomic, xmr_price_usd FROM revenue_snapshots
        WHERE source = 'xmr-mining' AND collected_at >= ? AND collected_at < ?
          AND balance_atomic IS NOT NULL
        ORDER BY collected_at DESC LIMIT 1
      `).get(startISO, endISO);

      if (!earliest || !latest) return null;

      // Total earned = (latest balance + latest paid) - (earliest balance + earliest paid_at_start)
      // Simplified: use balance delta (ignoring payouts within the week for now)
      const price = latest.xmr_price_usd || 0;
      const balanceChangeAtomic = latest.balance_atomic - earliest.balance_atomic + ((latest.paid_atomic || 0) - 0);
      const changeXMR = balanceChangeAtomic / 1e12;
      return { changeXMR, changeUSD: changeXMR * price, price };
    };

    // Get MLX request count for period
    const getMLXRequests = (startISO, endISO) => {
      const earliest = this.db.prepare(`
        SELECT requests_served FROM revenue_snapshots
        WHERE source = 'mlx-api' AND collected_at >= ? AND collected_at < ?
          AND requests_served IS NOT NULL
        ORDER BY collected_at ASC LIMIT 1
      `).get(startISO, endISO);

      const latest = this.db.prepare(`
        SELECT requests_served FROM revenue_snapshots
        WHERE source = 'mlx-api' AND collected_at >= ? AND collected_at < ?
          AND requests_served IS NOT NULL
        ORDER BY collected_at DESC LIMIT 1
      `).get(startISO, endISO);

      if (!earliest || !latest) return null;
      // Handle counter resets (service restarts)
      const delta = latest.requests_served - earliest.requests_served;
      return { requests: delta >= 0 ? delta : latest.requests_served };
    };

    return {
      thisWeek: {
        xmr: getXMRChange(thisWeekISO, nowISO),
        mlx: getMLXRequests(thisWeekISO, nowISO),
      },
      lastWeek: {
        xmr: getXMRChange(lastWeekISO, thisWeekISO),
        mlx: getMLXRequests(lastWeekISO, thisWeekISO),
      },
    };
  }

  _maybePrune() {
    const retentionDays = this.config.revenue?.retentionDays || 90;
    // Only prune once per day
    if (!this._lastPruneTime || Date.now() - this._lastPruneTime > 86400000) {
      const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
      this.db.prepare('DELETE FROM revenue_snapshots WHERE collected_at < ?').run(cutoff);
      this._lastPruneTime = Date.now();
    }
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

module.exports = RevenueTracker;
