#!/usr/bin/env node
'use strict';

/**
 * check-health.js — Run health checks on all configured services.
 * Outputs JSON with service status, latency, and error details.
 *
 * Usage: node scripts/check-health.js [--service <name>]
 */

const fs = require('fs');
const path = require('path');

const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf-8'));
const HealthMonitor = require('../lib/health-monitor');

const healthMonitor = new HealthMonitor({ config: CONFIG });

(async () => {
  // Force check all services regardless of interval
  for (const service of healthMonitor.services) {
    await healthMonitor._checkAndRecord(service);
  }

  const results = healthMonitor.getLastResults();
  const targetService = process.argv.includes('--service')
    ? process.argv[process.argv.indexOf('--service') + 1]
    : null;

  if (targetService) {
    const result = results[targetService];
    if (result) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(JSON.stringify({ error: `Service "${targetService}" not found` }));
    }
  } else {
    const summary = {
      timestamp: new Date().toISOString(),
      total: Object.keys(results).length,
      up: Object.values(results).filter(r => r.status === 'up').length,
      down: Object.values(results).filter(r => r.status === 'down').length,
      services: results,
    };
    console.log(JSON.stringify(summary, null, 2));
  }
})();
