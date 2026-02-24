'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createMockDeps } = require('./helpers');

const WebServer = require('../lib/web-server');

/**
 * Make an HTTP request and return { statusCode, headers, body }.
 */
function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: '127.0.0.1',
      port: 8051,
      path,
      method,
      headers: {},
    };
    if (body) {
      const payload = typeof body === 'string' ? body : JSON.stringify(body);
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, headers: res.headers, body: data });
      });
    });
    req.on('error', reject);
    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

describe('WebServer', () => {
  let server;
  let mockDeps;

  before(async () => {
    mockDeps = createMockDeps({
      scanner: {
        scanAll: () => [
          { name: 'test-project', hasState: true, progress: 50, status: 'active', phase: 1, totalPhases: 5, needsAttention: false },
        ],
      },
      aiBrain: {
        getStatus: () => ({ enabled: true, lastThinkTime: null, thinking: false, autonomyLevel: 'observe', recentDecisions: 0 }),
        getLastDecision: () => null,
        isEnabled: () => true,
      },
      commands: {
        route: async (text) => `Executed: ${text}`,
      },
      config: {
        projects: ['test-project'],
        ai: { enabled: true, autonomyLevel: 'observe' },
        myNumber: '+15555555555',
        claudeNumber: 'secret@icloud.com',
        revenue: { enabled: true, xmrWallet: 'SECRET_WALLET_ADDRESS' },
        quietHours: { enabled: true, start: '22:00', end: '07:00' },
      },
    });

    server = new WebServer(mockDeps);
    await server.start();
  });

  after(() => {
    server.close();
  });

  it('GET / returns HTML', async () => {
    const res = await request('GET', '/');
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.headers['content-type'].includes('text/html'));
    assert.ok(res.body.includes('ONE Claude'));
  });

  it('GET /api/overview returns correct shape', async () => {
    const res = await request('GET', '/api/overview');
    assert.strictEqual(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.ok(data.resources);
    assert.ok('activeSessions' in data);
    assert.ok('projectCount' in data);
    assert.ok('uptimeSeconds' in data);
    assert.ok('quietMode' in data);
    assert.ok('timestamp' in data);
    assert.ok(data.health);
  });

  it('GET /api/projects returns projects array', async () => {
    const res = await request('GET', '/api/projects');
    assert.strictEqual(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.ok(Array.isArray(data.projects));
    assert.strictEqual(data.projects.length, 1);
    assert.strictEqual(data.projects[0].name, 'test-project');
  });

  it('GET /api/health returns results and stats', async () => {
    const res = await request('GET', '/api/health');
    assert.strictEqual(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.ok('results' in data);
    assert.ok('stats' in data);
    assert.ok('total' in data.stats);
  });

  it('GET /api/sessions returns sessions array', async () => {
    const res = await request('GET', '/api/sessions');
    assert.strictEqual(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.ok(Array.isArray(data.sessions));
  });

  it('GET /api/ai returns status and decision info', async () => {
    const res = await request('GET', '/api/ai');
    assert.strictEqual(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.ok(data.status);
    assert.strictEqual(data.status.enabled, true);
    assert.strictEqual(data.status.autonomyLevel, 'observe');
    assert.ok('lastDecision' in data);
    assert.ok('decisionCount' in data);
  });

  it('GET /api/history returns executions and evaluations', async () => {
    const res = await request('GET', '/api/history');
    assert.strictEqual(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.ok(Array.isArray(data.executions));
    assert.ok(Array.isArray(data.evaluations));
  });

  it('GET /api/revenue returns latest and trend', async () => {
    const res = await request('GET', '/api/revenue');
    assert.strictEqual(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.ok('latest' in data);
    assert.ok('weeklyTrend' in data);
  });

  it('GET /api/config strips sensitive fields', async () => {
    const res = await request('GET', '/api/config');
    assert.strictEqual(res.statusCode, 200);
    const data = JSON.parse(res.body);
    const cfg = data.config;
    // Sensitive fields must be stripped
    assert.strictEqual(cfg.myNumber, undefined);
    assert.strictEqual(cfg.claudeNumber, undefined);
    assert.strictEqual(cfg.revenue?.xmrWallet, undefined);
    // Non-sensitive fields should remain
    assert.ok(cfg.ai);
    assert.ok(cfg.quietHours);
  });

  it('POST /api/command routes through CommandRouter', async () => {
    const res = await request('POST', '/api/command', { text: 'status' });
    assert.strictEqual(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.strictEqual(data.response, 'Executed: status');
  });

  it('POST /api/command rejects missing text', async () => {
    const res = await request('POST', '/api/command', { foo: 'bar' });
    assert.strictEqual(res.statusCode, 400);
    const data = JSON.parse(res.body);
    assert.ok(data.error.includes('text'));
  });

  it('POST /api/command rejects invalid JSON', async () => {
    const res = await request('POST', '/api/command', 'not json{{{');
    assert.strictEqual(res.statusCode, 400);
    const data = JSON.parse(res.body);
    assert.ok(data.error.includes('Invalid JSON'));
  });

  it('returns 404 for unknown routes', async () => {
    const res = await request('GET', '/api/nonexistent');
    assert.strictEqual(res.statusCode, 404);
    const data = JSON.parse(res.body);
    assert.ok(data.error);
  });

  it('GET /api/events returns SSE stream', async () => {
    const data = await new Promise((resolve, reject) => {
      const req = http.get({
        hostname: '127.0.0.1',
        port: 8051,
        path: '/api/events',
      }, res => {
        assert.strictEqual(res.statusCode, 200);
        assert.ok(res.headers['content-type'].includes('text/event-stream'));

        let buf = '';
        res.on('data', chunk => {
          buf += chunk;
          // We got at least one event — close and resolve
          if (buf.includes('event: update')) {
            res.destroy();
            resolve(buf);
          }
        });

        // Safety timeout
        setTimeout(() => {
          res.destroy();
          reject(new Error('SSE timeout — no event received'));
        }, 3000);
      });
      req.on('error', () => {}); // Suppress ECONNRESET from destroy
    });

    assert.ok(data.includes('event: update'));
    assert.ok(data.includes('"overview"'));
  });
});
