'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');
const path = require('path');

// Health monitor module path for cache clearing
const hmPath = path.resolve(__dirname, '../lib/health-monitor.js');

// Load HealthMonitor initially (for tests that don't need execSync patching)
let HealthMonitor = require('../lib/health-monitor');

// Preserve originals for cleanup
const origFetch = global.fetch;
const origExecSync = cp.execSync;

/**
 * Clear module cache for health-monitor and re-require it.
 * This is needed because health-monitor.js destructures execSync
 * at module load time, so patching cp.execSync after load has no effect.
 */
function reloadHealthMonitor() {
  delete require.cache[hmPath];
  HealthMonitor = require(hmPath);
  return HealthMonitor;
}

describe('HealthMonitor', () => {

  afterEach(() => {
    global.fetch = origFetch;
    // Restore execSync and re-require to get clean module
    cp.execSync = origExecSync;
    delete require.cache[hmPath];
    HealthMonitor = require(hmPath);
  });

  describe('constructor', () => {
    it('initializes with config services', () => {
      const services = [
        { name: 'api', type: 'http', url: 'http://localhost:8000' },
        { name: 'db', type: 'tcp', host: 'localhost', port: 5432 },
      ];
      const hm = new HealthMonitor({
        config: { health: { services } },
      });
      assert.equal(hm.services.length, 2);
      assert.equal(hm.services[0].name, 'api');
      assert.equal(hm.enabled, true);
    });

    it('defaults to enabled when health.enabled is not set', () => {
      const hm = new HealthMonitor({
        config: { health: { services: [] } },
      });
      assert.equal(hm.enabled, true);
    });

    it('respects enabled=false', () => {
      const hm = new HealthMonitor({
        config: { health: { enabled: false, services: [] } },
      });
      assert.equal(hm.enabled, false);
    });

    it('handles missing health config gracefully', () => {
      const hm = new HealthMonitor({ config: {} });
      assert.equal(hm.services.length, 0);
      assert.equal(hm.enabled, true);
    });
  });

  describe('_checkHTTP', () => {
    it('returns up when fetch succeeds with 200', async () => {
      global.fetch = async () => ({ status: 200 });
      const hm = new HealthMonitor({ config: { health: { services: [] } } });
      const result = await hm._checkHTTP({ url: 'http://localhost:9999/', timeoutMs: 5000 });
      assert.equal(result.up, true);
      assert.equal(result.statusCode, 200);
    });

    it('returns up when fetch succeeds with 404 (any HTTP response = alive)', async () => {
      global.fetch = async () => ({ status: 404 });
      const hm = new HealthMonitor({ config: { health: { services: [] } } });
      const result = await hm._checkHTTP({ url: 'http://localhost:9999/', timeoutMs: 5000 });
      assert.equal(result.up, true);
      assert.equal(result.statusCode, 404);
    });

    it('returns down when fetch throws ECONNREFUSED', async () => {
      global.fetch = async () => {
        const err = new Error('fetch failed');
        err.cause = { code: 'ECONNREFUSED' };
        throw err;
      };
      const hm = new HealthMonitor({ config: { health: { services: [] } } });
      const result = await hm._checkHTTP({ url: 'http://localhost:9999/', timeoutMs: 5000 });
      assert.equal(result.up, false);
      assert.equal(result.error, 'ECONNREFUSED');
    });

    it('returns down when fetch times out (AbortError)', async () => {
      global.fetch = async () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        throw err;
      };
      const hm = new HealthMonitor({ config: { health: { services: [] } } });
      const result = await hm._checkHTTP({ url: 'http://localhost:9999/', timeoutMs: 5000 });
      assert.equal(result.up, false);
      assert.equal(result.error, 'timeout');
    });
  });

  describe('_checkProcess', () => {
    it('returns up with PID when launchctl shows running service', () => {
      // Patch execSync BEFORE loading the module so it captures the patched version
      cp.execSync = (cmd, opts) => {
        if (cmd.includes('launchctl list')) return '"PID" = 12345;\n"LastExitStatus" = 0;';
        return origExecSync(cmd, opts);
      };
      const HM = reloadHealthMonitor();
      const hm = new HM({ config: { health: { services: [] } } });
      const result = hm._checkProcess({ launchdLabel: 'com.test' });
      assert.equal(result.up, true);
      assert.equal(result.pid, 12345);
      assert.equal(result.exitCode, 0);
    });

    it('returns down when launchctl shows no PID', () => {
      cp.execSync = (cmd, opts) => {
        if (cmd.includes('launchctl list')) return '"LastExitStatus" = 0;';
        return origExecSync(cmd, opts);
      };
      const HM = reloadHealthMonitor();
      const hm = new HM({ config: { health: { services: [] } } });
      const result = hm._checkProcess({ launchdLabel: 'com.test' });
      assert.equal(result.up, false);
      assert.equal(result.pid, null);
    });

    it('returns down when launchctl throws', () => {
      cp.execSync = (cmd, opts) => {
        if (cmd.includes('launchctl list')) throw new Error('Could not find service');
        return origExecSync(cmd, opts);
      };
      const HM = reloadHealthMonitor();
      const hm = new HM({ config: { health: { services: [] } } });
      const result = hm._checkProcess({ launchdLabel: 'com.test.missing' });
      assert.equal(result.up, false);
      assert.ok(result.error.includes('Could not find service'));
    });
  });

  describe('_checkDocker', () => {
    it('returns up when all containers are running', () => {
      cp.execSync = (cmd, opts) => {
        if (cmd.includes('docker ps')) return 'container1|Up 2 hours\ncontainer2|Up 2 hours\n';
        return origExecSync(cmd, opts);
      };
      const HM = reloadHealthMonitor();
      const hm = new HM({ config: { health: { services: [] } } });
      const result = hm._checkDocker({ containers: ['container1', 'container2'] });
      assert.equal(result.up, true);
      assert.equal(result.total, 2);
      assert.equal(result.running, 2);
      assert.deepEqual(result.downContainers, []);
    });

    it('returns down with list of stopped containers', () => {
      cp.execSync = (cmd, opts) => {
        if (cmd.includes('docker ps')) return 'container1|Up 2 hours\ncontainer2|Exited (1) 5 minutes ago\n';
        return origExecSync(cmd, opts);
      };
      const HM = reloadHealthMonitor();
      const hm = new HM({ config: { health: { services: [] } } });
      const result = hm._checkDocker({ containers: ['container1', 'container2'] });
      assert.equal(result.up, false);
      assert.equal(result.total, 2);
      assert.equal(result.running, 1);
      assert.deepEqual(result.downContainers, ['container2']);
    });

    it('returns down when docker command fails', () => {
      cp.execSync = (cmd, opts) => {
        if (cmd.includes('docker ps')) throw new Error('docker not found');
        return origExecSync(cmd, opts);
      };
      const HM = reloadHealthMonitor();
      const hm = new HM({ config: { health: { services: [] } } });
      const result = hm._checkDocker({ containers: ['c1', 'c2'] });
      assert.equal(result.up, false);
      assert.equal(result.running, 0);
      assert.equal(result.total, 2);
      assert.deepEqual(result.downContainers, ['c1', 'c2']);
    });
  });

  describe('consecutive failure tracking', () => {
    it('increments consecutiveFails on each failure', async () => {
      global.fetch = async () => {
        const err = new Error('refused');
        err.cause = { code: 'ECONNREFUSED' };
        throw err;
      };
      const hm = new HealthMonitor({
        config: { health: { services: [{ name: 'web', type: 'http', url: 'http://localhost:1/' }] } },
      });

      await hm._checkAndRecord({ name: 'web', type: 'http', url: 'http://localhost:1/' });
      assert.equal(hm._results['web'].consecutiveFails, 1);

      await hm._checkAndRecord({ name: 'web', type: 'http', url: 'http://localhost:1/' });
      assert.equal(hm._results['web'].consecutiveFails, 2);

      await hm._checkAndRecord({ name: 'web', type: 'http', url: 'http://localhost:1/' });
      assert.equal(hm._results['web'].consecutiveFails, 3);
    });

    it('resets consecutiveFails to 0 on success', async () => {
      // Start with failure
      global.fetch = async () => {
        const err = new Error('refused');
        err.cause = { code: 'ECONNREFUSED' };
        throw err;
      };
      const hm = new HealthMonitor({
        config: { health: { services: [] } },
      });

      await hm._checkAndRecord({ name: 'web', type: 'http', url: 'http://localhost:1/' });
      assert.equal(hm._results['web'].consecutiveFails, 1);

      // Now succeed
      global.fetch = async () => ({ status: 200 });
      await hm._checkAndRecord({ name: 'web', type: 'http', url: 'http://localhost:1/' });
      assert.equal(hm._results['web'].consecutiveFails, 0);
    });
  });

  describe('_processResults - alert routing', () => {
    it('sends URGENT notification after consecutiveFailsBeforeAlert failures', () => {
      const notifications = [];
      const hm = new HealthMonitor({
        config: {
          health: {
            services: [{ name: 'api', type: 'http', url: 'http://localhost:1/' }],
            consecutiveFailsBeforeAlert: 3,
          },
        },
        notificationManager: { notify: (msg, tier) => notifications.push({ msg, tier }) },
        state: { load: () => ({ runtimeAutonomyLevel: 'observe' }), getAutonomyLevel: () => 'observe' },
      });

      // Simulate exactly 3 consecutive failures (at threshold)
      hm._results = {
        api: { name: 'api', type: 'http', status: 'down', consecutiveFails: 3, error: 'ECONNREFUSED' },
      };

      hm._processResults();
      assert.equal(notifications.length, 1);
      assert.equal(notifications[0].tier, 1); // URGENT
    });

    it('does not send notification before threshold is reached', () => {
      const notifications = [];
      const hm = new HealthMonitor({
        config: {
          health: {
            services: [{ name: 'api', type: 'http', url: 'http://localhost:1/' }],
            consecutiveFailsBeforeAlert: 3,
          },
        },
        notificationManager: { notify: (msg, tier) => notifications.push({ msg, tier }) },
      });

      // Only 2 failures -- below threshold
      hm._results = {
        api: { name: 'api', type: 'http', status: 'down', consecutiveFails: 2, error: 'ECONNREFUSED' },
      };

      hm._processResults();
      assert.equal(notifications.length, 0);
    });
  });

  describe('_processResults - correlated failure detection', () => {
    it('sends infrastructure event notification when 3+ services are down', () => {
      const notifications = [];
      const hm = new HealthMonitor({
        config: {
          health: {
            services: [],
            correlatedFailureThreshold: 3,
            consecutiveFailsBeforeAlert: 1,
          },
        },
        notificationManager: { notify: (msg, tier) => notifications.push({ msg, tier }) },
      });

      hm._results = {
        svc1: { name: 'svc1', type: 'http', status: 'down', consecutiveFails: 1, error: 'refused' },
        svc2: { name: 'svc2', type: 'http', status: 'down', consecutiveFails: 1, error: 'refused' },
        svc3: { name: 'svc3', type: 'http', status: 'down', consecutiveFails: 1, error: 'refused' },
      };

      hm._processResults();
      assert.equal(notifications.length, 1);
      assert.equal(notifications[0].tier, 1); // URGENT
      assert.ok(notifications[0].msg.includes('INFRASTRUCTURE EVENT'));
    });

    it('does NOT attempt restarts during infrastructure event', () => {
      let restartAttempted = false;
      const hm = new HealthMonitor({
        config: {
          health: {
            services: [
              { name: 'svc1', type: 'process', launchdLabel: 'com.svc1' },
              { name: 'svc2', type: 'process', launchdLabel: 'com.svc2' },
              { name: 'svc3', type: 'process', launchdLabel: 'com.svc3' },
            ],
            correlatedFailureThreshold: 3,
            consecutiveFailsBeforeAlert: 1,
          },
        },
        notificationManager: { notify: () => {} },
        state: { load: () => ({ runtimeAutonomyLevel: 'full' }), getAutonomyLevel: () => 'full' },
      });

      // Monkey-patch _restartService to detect if it's called
      hm._restartService = () => { restartAttempted = true; };

      hm._results = {
        svc1: { name: 'svc1', type: 'process', status: 'down', consecutiveFails: 1, error: 'no pid' },
        svc2: { name: 'svc2', type: 'process', status: 'down', consecutiveFails: 1, error: 'no pid' },
        svc3: { name: 'svc3', type: 'process', status: 'down', consecutiveFails: 1, error: 'no pid' },
      };

      hm._processResults();
      assert.equal(restartAttempted, false);
    });
  });

  describe('restart budget', () => {
    it('allows restarts when budget has capacity', () => {
      const hm = new HealthMonitor({
        config: { health: { services: [], restartBudget: { maxPerHour: 2 } } },
      });
      hm._restartTimestamps = [];
      assert.equal(hm._checkRestartBudget(), true);
    });

    it('blocks restarts when budget is exhausted', () => {
      const hm = new HealthMonitor({
        config: { health: { services: [], restartBudget: { maxPerHour: 2 } } },
      });
      hm._restartTimestamps = [Date.now(), Date.now()];
      assert.equal(hm._checkRestartBudget(), false);
    });

    it('resets budget after sliding window expires', () => {
      const hm = new HealthMonitor({
        config: { health: { services: [], restartBudget: { maxPerHour: 2 } } },
      });
      // Two restarts from 2 hours ago (outside the 1-hour window)
      const twoHoursAgo = Date.now() - 7200000;
      hm._restartTimestamps = [twoHoursAgo, twoHoursAgo];
      assert.equal(hm._checkRestartBudget(), true);
      // Old timestamps should have been pruned
      assert.equal(hm._restartTimestamps.length, 0);
    });
  });

  describe('autonomy gating', () => {
    it('does not restart at observe autonomy level', () => {
      const notifications = [];
      const hm = new HealthMonitor({
        config: {
          health: {
            services: [{ name: 'api', type: 'process', launchdLabel: 'com.api' }],
            consecutiveFailsBeforeAlert: 1,
          },
        },
        notificationManager: { notify: (msg, tier) => notifications.push({ msg, tier }) },
        state: { load: () => ({}), getAutonomyLevel: () => 'observe' },
      });

      let restartCalled = false;
      hm._restartService = () => { restartCalled = true; };

      hm._results = {
        api: { name: 'api', type: 'process', status: 'down', consecutiveFails: 1, error: 'no pid' },
      };

      hm._processResults();
      assert.equal(restartCalled, false);
      // Should still get a notification
      assert.equal(notifications.length, 1);
      assert.ok(notifications[0].msg.includes('observe'));
    });

    it('does not restart at cautious autonomy level', () => {
      const hm = new HealthMonitor({
        config: {
          health: {
            services: [{ name: 'api', type: 'process', launchdLabel: 'com.api' }],
            consecutiveFailsBeforeAlert: 1,
          },
        },
        notificationManager: { notify: () => {} },
        state: { load: () => ({}), getAutonomyLevel: () => 'cautious' },
      });

      let restartCalled = false;
      hm._restartService = () => { restartCalled = true; };

      hm._results = {
        api: { name: 'api', type: 'process', status: 'down', consecutiveFails: 1, error: 'no pid' },
      };

      hm._processResults();
      assert.equal(restartCalled, false);
    });

    it('allows restart at moderate autonomy level', () => {
      const hm = new HealthMonitor({
        config: {
          health: {
            services: [{ name: 'api', type: 'process', launchdLabel: 'com.api' }],
            consecutiveFailsBeforeAlert: 1,
            restartBudget: { maxPerHour: 5 },
          },
        },
        notificationManager: { notify: () => {} },
        state: { load: () => ({}), getAutonomyLevel: () => 'moderate' },
      });

      let restartCalled = false;
      hm._restartService = () => { restartCalled = true; };

      hm._results = {
        api: {
          name: 'api', type: 'process', status: 'down', consecutiveFails: 1, error: 'no pid',
          details: {},
        },
      };

      hm._processResults();
      assert.equal(restartCalled, true);
    });

    it('allows restart at full autonomy level', () => {
      const hm = new HealthMonitor({
        config: {
          health: {
            services: [{ name: 'api', type: 'process', launchdLabel: 'com.api' }],
            consecutiveFailsBeforeAlert: 1,
            restartBudget: { maxPerHour: 5 },
          },
        },
        notificationManager: { notify: () => {} },
        state: { load: () => ({}), getAutonomyLevel: () => 'full' },
      });

      let restartCalled = false;
      hm._restartService = () => { restartCalled = true; };

      hm._results = {
        api: {
          name: 'api', type: 'process', status: 'down', consecutiveFails: 1, error: 'no pid',
          details: {},
        },
      };

      hm._processResults();
      assert.equal(restartCalled, true);
    });
  });

  describe('formatForContext', () => {
    it('returns null when no results exist', () => {
      const hm = new HealthMonitor({ config: { health: { services: [] } } });
      assert.equal(hm.formatForContext(), null);
    });

    it('returns formatted string with service statuses', () => {
      const hm = new HealthMonitor({
        config: { health: { services: [], restartBudget: { maxPerHour: 2 } } },
      });
      hm._results = {
        api: { name: 'api', type: 'http', status: 'up', latencyMs: 12, consecutiveFails: 0 },
        db: { name: 'db', type: 'tcp', status: 'down', latencyMs: 5001, consecutiveFails: 3, error: 'timeout' },
      };

      const output = hm.formatForContext();
      assert.ok(output.includes('Service Health:'));
      assert.ok(output.includes('api: UP'));
      assert.ok(output.includes('db: DOWN'));
      assert.ok(output.includes('3x fail'));
      assert.ok(output.includes('timeout'));
    });

    it('includes restart budget info', () => {
      const hm = new HealthMonitor({
        config: { health: { services: [], restartBudget: { maxPerHour: 2 } } },
      });
      hm._results = {
        api: { name: 'api', type: 'http', status: 'up', latencyMs: 10, consecutiveFails: 0 },
      };
      hm._restartTimestamps = [Date.now()]; // 1 restart used

      const output = hm.formatForContext();
      assert.ok(output.includes('Restart budget: 1/2 remaining'));
    });

    it('formats docker services with container counts', () => {
      const hm = new HealthMonitor({
        config: { health: { services: [], restartBudget: { maxPerHour: 2 } } },
      });
      hm._results = {
        bandwidth: {
          name: 'bandwidth', type: 'docker', status: 'up',
          details: { running: 9, total: 9 },
          consecutiveFails: 0,
        },
      };

      const output = hm.formatForContext();
      assert.ok(output.includes('9/9 containers'));
    });

    it('formats process services with pid', () => {
      const hm = new HealthMonitor({
        config: { health: { services: [], restartBudget: { maxPerHour: 2 } } },
      });
      hm._results = {
        ttyd: {
          name: 'ttyd', type: 'process', status: 'up',
          details: { pid: 12345 },
          consecutiveFails: 0,
        },
      };

      const output = hm.formatForContext();
      assert.ok(output.includes('pid 12345'));
    });
  });

  describe('getStats', () => {
    it('returns correct up/down counts', () => {
      const hm = new HealthMonitor({ config: { health: { services: [] } } });
      hm._results = {
        api: { name: 'api', status: 'up', consecutiveFails: 0 },
        db: { name: 'db', status: 'up', consecutiveFails: 0 },
        cache: { name: 'cache', status: 'down', consecutiveFails: 2 },
      };

      const stats = hm.getStats();
      assert.equal(stats.total, 3);
      assert.equal(stats.up, 2);
      assert.equal(stats.down, 1);
      assert.equal(stats.services.length, 3);
      assert.ok(stats.services.find(s => s.name === 'cache' && s.status === 'down'));
    });

    it('returns zeros when no results exist', () => {
      const hm = new HealthMonitor({ config: { health: { services: [] } } });
      const stats = hm.getStats();
      assert.equal(stats.total, 0);
      assert.equal(stats.up, 0);
      assert.equal(stats.down, 0);
    });
  });
});
