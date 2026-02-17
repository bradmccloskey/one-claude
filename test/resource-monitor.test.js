'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const ResourceMonitor = require('../lib/resource-monitor');

describe('ResourceMonitor', () => {
  const monitor = new ResourceMonitor();

  it('getSnapshot() returns system metrics with correct types', () => {
    const snap = monitor.getSnapshot();

    assert.equal(typeof snap.cpuLoadAvg1m, 'number');
    assert.equal(typeof snap.cpuLoadAvg5m, 'number');
    assert.ok(snap.cpuCount >= 1, `cpuCount should be >= 1, got ${snap.cpuCount}`);
    assert.ok(snap.freeMemMB > 0, `freeMemMB should be > 0, got ${snap.freeMemMB}`);
    assert.ok(snap.totalMemMB > 0, `totalMemMB should be > 0, got ${snap.totalMemMB}`);
    assert.ok(snap.memUsedPct >= 0 && snap.memUsedPct <= 100,
      `memUsedPct should be 0-100, got ${snap.memUsedPct}`);
    assert.ok(snap.uptimeHours >= 0, `uptimeHours should be >= 0, got ${snap.uptimeHours}`);

    // diskUsedPct can be null or a number 0-100
    if (snap.diskUsedPct !== null) {
      assert.equal(typeof snap.diskUsedPct, 'number');
      assert.ok(snap.diskUsedPct >= 0 && snap.diskUsedPct <= 100,
        `diskUsedPct should be 0-100, got ${snap.diskUsedPct}`);
    }
  });

  it('formatForContext() returns formatted string with expected sections', () => {
    const snap = monitor.getSnapshot();
    const result = monitor.formatForContext(snap);

    assert.equal(typeof result, 'string');
    assert.ok(result.startsWith('System:'), `should start with 'System:', got: ${result}`);
    assert.ok(result.includes('CPU'), 'should contain CPU');
    assert.ok(result.includes('RAM'), 'should contain RAM');
    assert.ok(result.includes('Disk'), 'should contain Disk');
    assert.ok(result.includes('Uptime'), 'should contain Uptime');
  });

  it('formatForContext() handles null diskUsedPct', () => {
    const snap = {
      cpuLoadAvg1m: 1.5,
      cpuLoadAvg5m: 1.2,
      cpuCount: 4,
      freeMemMB: 2048,
      totalMemMB: 8192,
      memUsedPct: 75,
      diskUsedPct: null,
      uptimeHours: 50,
    };
    const result = monitor.formatForContext(snap);

    assert.ok(result.includes('Disk N/A'), `should contain 'Disk N/A', got: ${result}`);
  });
});
