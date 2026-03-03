'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const RemoteScanner = require('./remote-scanner');

const DEFAULT_PORT = 8051;
const HOST = '0.0.0.0';
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
    this.scanDb = deps.scanDb || null;
    this.upworkDb = deps.upworkDb || null;
    this.upworkProposals = deps.upworkProposals || null;
    this.upworkSubmitter = deps.upworkSubmitter || null;

    this._port = deps.port ?? DEFAULT_PORT;
    this._startTime = Date.now();
    this._sseClients = new Set();
    this._sseTimer = null;
    this._server = null;
    this._remoteScanner = new RemoteScanner();

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

      this._server.listen(this._port, HOST, () => {
        this._port = this._server.address().port;
        console.log(`[WEB] Dashboard running at http://${HOST}:${this._port}`);
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
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
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
        case 'POST /api/command/stream':
          return await this._handleCommandStream(req, res);
        case 'GET /api/events':
          return this._handleSSE(req, res);
        case 'GET /api/remote-sessions':
          return this._jsonResponse(res, this._getRemoteSessions());
        case 'POST /api/remote-sessions':
          return await this._handleRegisterRemote(req, res);
        case 'GET /api/upwork/jobs':
          return this._jsonResponse(res, this._getUpworkJobs());
        case 'GET /api/upwork/settings':
          return this._jsonResponse(res, this._getUpworkSettings());
        case 'POST /api/upwork/dismiss':
          return await this._handleUpworkDismiss(req, res);
        case 'PUT /api/upwork/proposal':
          return await this._handleUpworkProposalEdit(req, res);
        case 'POST /api/upwork/generate-proposal':
          return await this._handleUpworkGenerateProposal(req, res);
        case 'POST /api/upwork/apply':
          return await this._handleUpworkApply(req, res);
        case 'GET /api/upwork/applied':
          return this._jsonResponse(res, this._getUpworkApplied());
        case 'PUT /api/upwork/outcome':
          return await this._handleUpworkOutcome(req, res);
        case 'GET /api/upwork/auto-apply':
          return this._jsonResponse(res, this._getUpworkAutoApply());
        case 'PUT /api/upwork/auto-apply':
          return await this._handleUpworkAutoApply(req, res);
        case 'GET /api/upwork/stats':
          return this._jsonResponse(res, this._getUpworkStats());
        default:
          // Handle parameterized routes
          if (req.method === 'DELETE' && pathname.startsWith('/api/remote-sessions/')) {
            const id = pathname.split('/').pop();
            return this._handleDeleteRemote(res, id);
          }
          if (req.method === 'GET' && pathname.startsWith('/api/projects/') && pathname.endsWith('/history')) {
            const projectName = decodeURIComponent(pathname.slice('/api/projects/'.length, -'/history'.length));
            return this._jsonResponse(res, this._getProjectHistory(projectName));
          }
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
    const projects = this.scanner.scanAllEnriched();
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

  _getProjectHistory(projectName) {
    if (!this.scanDb) return { history: [] };
    return { history: this.scanDb.getHistory(projectName) };
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

  /**
   * POST /api/command/stream — SSE streaming for NL commands.
   * Events: status (immediate), progress (stdout chunks), result (final), done (close).
   */
  async _handleCommandStream(req, res) {
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

    // Set up SSE response
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    // Send immediate status
    res.write(`event: status\ndata: ${JSON.stringify({ status: 'thinking' })}\n\n`);

    let closed = false;
    req.on('close', () => { closed = true; });

    const onProgress = (chunk) => {
      if (closed) return;
      try {
        res.write(`event: progress\ndata: ${JSON.stringify({ chunk })}\n\n`);
      } catch {}
    };

    // 5-minute timeout for streaming
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Command timed out after 300s')), 300000)
    );

    try {
      const response = await Promise.race([
        this.commands.route(text, { onProgress }),
        timeout,
      ]);

      if (!closed) {
        res.write(`event: result\ndata: ${JSON.stringify({ response })}\n\n`);
        res.write(`event: done\ndata: {}\n\n`);
        res.end();
      }
    } catch (err) {
      if (!closed) {
        res.write(`event: result\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
        res.write(`event: done\ndata: {}\n\n`);
        res.end();
      }
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

  // ── Upwork API ─────────────────────────────────────────────

  _getUpworkJobs() {
    if (!this.upworkDb) return { jobs: [], connects: { balance: null, lastChecked: null }, dryRun: false };
    return {
      jobs: this.upworkDb.getPendingJobs(50),
      connects: this.upworkDb.getConnectsBalance(),
      dryRun: this.upworkSubmitter ? this.upworkSubmitter.isDryRun : false,
    };
  }

  _getUpworkSettings() {
    if (!this.upworkDb) return { settings: {} };
    return { settings: this.upworkDb.getSettings() };
  }

  async _handleUpworkDismiss(req, res) {
    if (!this.upworkDb) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Upwork module not available' }));
      return;
    }

    const body = await this._readBody(req);
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    const { uid } = parsed;
    if (!uid) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing "uid" field' }));
      return;
    }

    this.upworkDb.updateJobStatus(uid, 'dismissed');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }

  async _handleUpworkProposalEdit(req, res) {
    if (!this.upworkDb) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Upwork module not available' }));
      return;
    }

    const body = await this._readBody(req);
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    const { jobId, coverLetter, screeningAnswers } = parsed;
    if (!jobId || !coverLetter) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing "jobId" or "coverLetter"' }));
      return;
    }

    const id = this.upworkDb.upsertProposal(jobId, coverLetter, screeningAnswers || null);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, proposalId: Number(id) }));
  }

  async _handleUpworkGenerateProposal(req, res) {
    if (!this.upworkDb || !this.upworkProposals) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Upwork module not available' }));
      return;
    }

    const body = await this._readBody(req);
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    const { uid } = parsed;
    if (!uid) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing "uid" field' }));
      return;
    }

    const job = this.upworkDb.getJobByUid(uid);
    if (!job) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Job not found' }));
      return;
    }

    // Fire off proposal generation (don't await — it could take 2 min)
    this.upworkProposals.generateAndSave(job);

    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: 'Proposal generation started' }));
  }

  async _handleUpworkApply(req, res) {
    if (!this.upworkSubmitter) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Submitter not configured' }));
      return;
    }
    if (!this.upworkDb) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Upwork module not available' }));
      return;
    }

    const body = await this._readBody(req);
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    const { uid, dryRun } = parsed;
    if (!uid) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing "uid" field' }));
      return;
    }

    const job = this.upworkDb.getJobWithProposal(uid);
    if (!job) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Job not found' }));
      return;
    }
    if (!job.cover_letter) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No proposal ready for this job — generate one first' }));
      return;
    }

    const effectiveDryRun = dryRun !== undefined ? !!dryRun : this.upworkSubmitter.isDryRun;
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: 'Submission started', dryRun: effectiveDryRun }));

    this.upworkSubmitter.submitJob(job, {
      coverLetter: job.cover_letter,
      screeningAnswers: job.proposal_screening_answers || null,
      dryRun: dryRun,
    }).catch(e => console.error('[UPWORK-SUBMIT] Unhandled error:', e.message));
  }

  _getUpworkApplied() {
    if (!this.upworkDb) return { jobs: [] };
    return { jobs: this.upworkDb.getAppliedJobs(50) };
  }

  async _handleUpworkOutcome(req, res) {
    if (!this.upworkDb) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Upwork module not available' }));
      return;
    }

    const body = await this._readBody(req);
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    const { uid, outcome } = parsed;
    const valid = ['pending', 'got_response', 'interview', 'hired', 'no_response'];
    if (!uid || !outcome || !valid.includes(outcome)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing "uid" or invalid "outcome". Valid: ' + valid.join(', ') }));
      return;
    }

    this.upworkDb.updateApplicationOutcome(uid, outcome);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }

  _getUpworkAutoApply() {
    if (!this.upworkDb) return { settings: {} };
    return { settings: this.upworkDb.getAutoApplySettings() };
  }

  async _handleUpworkAutoApply(req, res) {
    if (!this.upworkDb) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Upwork module not available' }));
      return;
    }

    const body = await this._readBody(req);
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    const allowedKeys = [
      'auto_apply_enabled', 'auto_apply_threshold', 'auto_apply_max_daily',
      'auto_apply_start_hour', 'auto_apply_end_hour', 'auto_apply_connects_floor',
      'notify_high_match', 'notify_high_match_threshold',
    ];

    let updated = 0;
    for (const [key, value] of Object.entries(parsed)) {
      if (allowedKeys.includes(key)) {
        this.upworkDb.updateSetting(key, value);
        updated++;
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, updated, settings: this.upworkDb.getAutoApplySettings() }));
  }

  _getUpworkStats() {
    if (!this.upworkDb) return { stats: {} };
    return { stats: this.upworkDb.getPipelineStats() };
  }

  // ── Remote Sessions ──────────────────────────────────────────

  _getRemoteSessions() {
    return this._remoteScanner.getAll();
  }

  async _handleRegisterRemote(req, res) {
    const body = await this._readBody(req);
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    const { url, label, pid } = parsed;
    if (!url) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing "url" field' }));
      return;
    }

    try {
      const entry = this._remoteScanner.register(url, label, pid);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(entry));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  _handleDeleteRemote(res, id) {
    const removed = this._remoteScanner.remove(id);
    if (removed) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found' }));
    }
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
      remoteSessions: this._getRemoteSessions(),
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
