'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');

const EmailDigest = require('../lib/email-digest');

function createTestDigest(overrides = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-test-'));

  const deps = {
    scanner: {
      scanAllEnriched: () => overrides.projects || [
        {
          name: 'revenue/test-project',
          hasState: true,
          status: 'Active',
          progress: 50,
          needsAttention: false,
          blockers: [],
          gitBranch: 'main',
          dirtyFiles: 2,
          gsdPhasesTotal: 5,
          gsdPhasesComplete: 3,
        },
        {
          name: 'apps/blocked-app',
          hasState: true,
          status: 'Blocked',
          progress: 20,
          needsAttention: true,
          blockers: ['Waiting on API key'],
          gitBranch: 'dev',
          dirtyFiles: 0,
          gsdPhasesTotal: 4,
          gsdPhasesComplete: 1,
        },
      ],
    },
    healthMonitor: {
      getLastResults: () => overrides.healthResults || {
        'income-dashboard': { name: 'income-dashboard', status: 'up', latencyMs: 45 },
        'mlx-api': { name: 'mlx-api', status: 'down', latencyMs: null },
      },
    },
    sessionManager: {
      getSessionStatuses: () => overrides.sessions || [
        { projectName: 'revenue/test-project', needsInput: false },
      ],
    },
    scanDb: overrides.scanDb || null,
  };

  const digest = new EmailDigest(deps);
  // Override snapshot path for test isolation
  digest._snapshotPath = path.join(tmpDir, 'snapshot.json');

  const cleanup = () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  };

  return { digest, tmpDir, cleanup };
}

describe('EmailDigest', () => {
  describe('_gatherData', () => {
    it('gathers projects, sessions, services, and summary', () => {
      const { digest, cleanup } = createTestDigest();
      try {
        const data = digest._gatherData();
        assert.equal(data.projects.length, 2);
        assert.equal(data.sessions.length, 1);
        assert.equal(data.services.length, 1); // only 'up' services
        assert.equal(data.services[0].name, 'income-dashboard');
        assert.equal(data.summary.total, 2);
        assert.equal(data.summary.blocked, 1);
      } finally {
        cleanup();
      }
    });

    it('detects status changes from previous snapshot', () => {
      const { digest, tmpDir, cleanup } = createTestDigest();
      try {
        // Write a previous snapshot with different status
        const dir = path.dirname(digest._snapshotPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(digest._snapshotPath, JSON.stringify({
          timestamp: new Date().toISOString(),
          statuses: { 'revenue/test-project': 'Blocked' },
        }));

        const data = digest._gatherData();
        assert.equal(data.changes.length, 1);
        assert.equal(data.changes[0].name, 'revenue/test-project');
        assert.equal(data.changes[0].from, 'Blocked');
        assert.equal(data.changes[0].to, 'Active');
      } finally {
        cleanup();
      }
    });

    it('handles missing snapshot gracefully', () => {
      const { digest, cleanup } = createTestDigest();
      try {
        const data = digest._gatherData();
        assert.equal(data.changes.length, 0);
      } finally {
        cleanup();
      }
    });
  });

  describe('_buildHtml', () => {
    it('produces valid HTML with key sections', () => {
      const { digest, cleanup } = createTestDigest();
      try {
        const data = digest._gatherData();
        const html = digest._buildHtml(data);
        assert.ok(html.includes('ONE Claude'));
        assert.ok(html.includes('Dashboard Digest'));
        assert.ok(html.includes('Status Changes'));
        assert.ok(html.includes('Blocked Projects'));
        assert.ok(html.includes('Active Sessions'));
        assert.ok(html.includes('All Projects'));
        assert.ok(html.includes('revenue/test-project'));
        assert.ok(html.includes('Waiting on API key'));
      } finally {
        cleanup();
      }
    });

    it('escapes HTML in project names', () => {
      const { digest, cleanup } = createTestDigest({
        projects: [{
          name: '<script>alert("xss")</script>',
          hasState: false,
          status: 'Active',
          needsAttention: false,
          blockers: [],
          gitBranch: null,
          dirtyFiles: 0,
          gsdPhasesTotal: 0,
          gsdPhasesComplete: 0,
        }],
      });
      try {
        const data = digest._gatherData();
        const html = digest._buildHtml(data);
        assert.ok(!html.includes('<script>alert'));
        assert.ok(html.includes('&lt;script&gt;'));
      } finally {
        cleanup();
      }
    });
  });

  describe('_buildText', () => {
    it('produces plain text with all sections', () => {
      const { digest, cleanup } = createTestDigest();
      try {
        const data = digest._gatherData();
        const text = digest._buildText(data);
        assert.ok(text.includes('ONE Claude'));
        assert.ok(text.includes('Summary'));
        assert.ok(text.includes('Total: 2'));
        assert.ok(text.includes('Blocked'));
        assert.ok(text.includes('Waiting on API key'));
        assert.ok(text.includes('revenue/test-project'));
      } finally {
        cleanup();
      }
    });
  });

  describe('send (dry run)', () => {
    it('completes without error in dry run mode', async () => {
      const { digest, cleanup } = createTestDigest();
      try {
        await digest.send({ dryRun: true });
      } finally {
        cleanup();
      }
    });

    it('saves snapshot after dry run', async () => {
      const { digest, cleanup } = createTestDigest();
      try {
        await digest.send({ dryRun: true });
        assert.ok(fs.existsSync(digest._snapshotPath));
        const snapshot = JSON.parse(fs.readFileSync(digest._snapshotPath, 'utf-8'));
        assert.ok(snapshot.timestamp);
        assert.ok(snapshot.statuses['revenue/test-project']);
      } finally {
        cleanup();
      }
    });
  });

  describe('send (no password)', () => {
    it('returns early without ICLOUD_APP_PASSWORD', async () => {
      const origPassword = process.env.ICLOUD_APP_PASSWORD;
      delete process.env.ICLOUD_APP_PASSWORD;
      const { digest, cleanup } = createTestDigest();
      try {
        // Should not throw, just log error and return
        await digest.send();
      } finally {
        process.env.ICLOUD_APP_PASSWORD = origPassword;
        cleanup();
      }
    });
  });

  describe('_esc', () => {
    it('escapes HTML special characters', () => {
      const { digest, cleanup } = createTestDigest();
      try {
        assert.equal(digest._esc('<b>"test"</b> & more'), '&lt;b&gt;&quot;test&quot;&lt;/b&gt; &amp; more');
      } finally {
        cleanup();
      }
    });

    it('handles null/empty input', () => {
      const { digest, cleanup } = createTestDigest();
      try {
        assert.equal(digest._esc(null), '');
        assert.equal(digest._esc(''), '');
      } finally {
        cleanup();
      }
    });
  });
});
