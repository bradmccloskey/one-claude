'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = 8051;
const HOST = '127.0.0.1';
const SSE_INTERVAL_MS = 5000;

/**
 * WebServer — Embedded HTTP server for the orchestrator dashboard.
 *
 * Serves a single-page dashboard at GET / and a JSON API under /api/*.
 * SSE stream at /api/events pushes live updates every 5s.
 * Bound to 127.0.0.1 only — Cloudflare tunnel handles public access.
 */
class WebServer {
  /**
   * @param {Object} deps - All orchestrator dependencies
   */
  constructor(deps) {
    this.scanner = deps.scanner;
    this.healthMonitor = deps.healthMonitor;
    this.sessionManager = deps.sessionManager;
    this.aiBrain = deps.aiBrain;
    this.state = deps.state;
    this.resourceMonitor = deps.resourceMonitor;
    this.revenueTracker = deps.revenueTracker;
    this.trustTracker = deps.trustTracker;
    this.commands = deps.commands;
    this.config = deps.config;
    this.scheduler = deps.scheduler;

    this._startTime = Date.now();
    this._sseClients = new Set();
    this._sseTimer = null;
    this._server = null;

    // Cache index.html in memory
    const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
    try {
      this._html = fs.readFileSync(htmlPath, 'utf-8');
    } catch {
      this._html = '<html><body><h1>Dashboard HTML not found</h1></body></html>';
    }
  }

  /**
   * Start the HTTP server and SSE broadcast timer.
   * @returns {Promise<void>}
   */
  start() {
    return new Promise((resolve, reject) => {
      this._server = http.createServer((req, res) => this._handleRequest(req, res));

      this._server.listen(PORT, HOST, () => {
        console.log(`[WEB] Dashboard running at http://${HOST}:${PORT}`);
        resolve();
      });

      this._server.on('error', (err) => {
        console.error(`[WEB] Server error: ${err.message}`);
        reject(err);
      });

      // Start SSE broadcast
      this._sseTimer = setInterval(() => this._broadcastSSE(), SSE_INTERVAL_MS);
    });
  }

  /**
   * Gracefully close the HTTP server and SSE timer.
   */
  close() {
    if (this._sseTimer) {
      clearInterval(this._sseTimer);
      this._sseTimer = null;
    }
    // Close all SSE connections
    for (const client of this._sseClients) {
      try { client.end(); } catch {}
    }
    this._sseClients.clear();

    if (this._server) {
      this._server.close();
      this._server = null;
    }
  }

  /**
   * Route incoming HTTP requests.
   */
  async _handleRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;
    const route = req.method + ' ' + pathname;

    // CORS headers for local dev
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      switch (route) {
        case 'GET /':
          return this._serveHTML(res);
        case 'GET /api/overview':
          return this._jsonResponse(res, this._getOverview());
        case 'GET /api/projects':
          return this._jsonResponse(res, this._getProjects());
        case 'GET /api/health':
          return this._jsonResponse(res, this._getHealth());
        case 'GET /api/sessions':
          return this._jsonResponse(res, this._getSessions());
        case 'GET /api/ai':
          return this._jsonResponse(res, this._getAI());
        case 'GET /api/history':
          return this._jsonResponse(res, this._getHistory());
        case 'GET /api/revenue':
          return this._jsonResponse(res, this._getRevenue());
        case 'GET /api/config':
          return this._jsonResponse(res, this._getConfig());
        case 'POST /api/command':
          return await this._handleCommand(req, res);
        case 'GET /api/events':
          return this._handleSSE(req, res);
        default:
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
      }
    } catch (err) {
      console.error(`[WEB] Error handling ${route}: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }

  // ── Route handlers ────────────────────────────────────────────

  _serveHTML(res) {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
    res.end(this._html);
  }

  _jsonResponse(res, data) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  _getOverview() {
    const resources = this.resourceMonitor.getSnapshot();
    const healthStats = this.healthMonitor.getStats();
    const sessions = this.sessionManager.getActiveSessions();
    const s = this.state.load();

    return {
      resources,
      health: healthStats,
      activeSessions: sessions.length,
      projectCount: this.config.projects?.length || 0,
      uptimeSeconds: Math.floor((Date.now() - this._startTime) / 1000),
      quietMode: this.scheduler.isQuietTime(),
      autonomyLevel: this.state.getAutonomyLevel(s, this.config),
      timestamp: new Date().toISOString(),
    };
  }

  _getProjects() {
    const projects = this.scanner.scanAll();
    return { projects };
  }

  _getHealth() {
    return {
      results: this.healthMonitor.getLastResults(),
      stats: this.healthMonitor.getStats(),
    };
  }

  _getSessions() {
    return {
      sessions: this.sessionManager.getSessionStatuses(),
    };
  }

  _getAI() {
    const status = this.aiBrain.getStatus();
    const lastDecision = this.aiBrain.getLastDecision();
    const s = this.state.load();
    return {
      status,
      lastDecision,
      decisionCount: (s.aiDecisionHistory || []).length,
    };
  }

  _getHistory() {
    const s = this.state.load();
    return {
      executions: (s.executionHistory || []).slice(-50),
      evaluations: (s.evaluationHistory || []).slice(-50),
    };
  }

  _getRevenue() {
    return {
      latest: this.revenueTracker.getLatest(),
      weeklyTrend: this.revenueTracker.getWeeklyTrend(),
    };
  }

  _getConfig() {
    // Return sanitized config — strip sensitive fields
    const safe = JSON.parse(JSON.stringify(this.config));
    delete safe.myNumber;
    delete safe.claudeNumber;
    if (safe.revenue) delete safe.revenue.xmrWallet;
    return { config: safe };
  }

  async _handleCommand(req, res) {
    const body = await this._readBody(req);
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    const text = parsed.text;
    if (!text || typeof text !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing "text" field' }));
      return;
    }

    // Route command with 120s timeout
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Command timed out after 120s')), 120000)
    );

    try {
      const response = await Promise.race([
        this.commands.route(text),
        timeout,
      ]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ response }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  _handleSSE(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    // Send initial data immediately
    const data = this._getSSEPayload();
    res.write(`event: update\ndata: ${JSON.stringify(data)}\n\n`);

    this._sseClients.add(res);

    req.on('close', () => {
      this._sseClients.delete(res);
    });
  }

  // ── SSE broadcast ─────────────────────────────────────────────

  _broadcastSSE() {
    if (this._sseClients.size === 0) return;

    const data = this._getSSEPayload();
    const msg = `event: update\ndata: ${JSON.stringify(data)}\n\n`;

    for (const client of this._sseClients) {
      try {
        client.write(msg);
      } catch {
        this._sseClients.delete(client);
      }
    }
  }

  _getSSEPayload() {
    return {
      overview: this._getOverview(),
      health: this._getHealth(),
      sessions: this._getSessions(),
      ai: this._getAI(),
    };
  }

  // ── Helpers ───────────────────────────────────────────────────

  _readBody(req) {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', chunk => { data += chunk; });
      req.on('end', () => resolve(data));
      req.on('error', reject);
    });
  }
}

module.exports = WebServer;
