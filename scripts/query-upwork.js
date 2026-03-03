#!/usr/bin/env node
'use strict';

/**
 * query-upwork.js — Query the Upwork job/proposal database.
 * Outputs JSON with job listings and proposal status.
 *
 * Usage:
 *   node scripts/query-upwork.js                    # Show recent jobs
 *   node scripts/query-upwork.js --status <status>  # Filter by status (new, proposal_ready, applied)
 *   node scripts/query-upwork.js --stats            # Show summary statistics
 */

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'orchestrator.db');

let db;
try {
  db = new Database(DB_PATH, { readonly: true });
} catch (e) {
  console.log(JSON.stringify({ error: `Cannot open database: ${e.message}` }));
  process.exit(1);
}

const showStats = process.argv.includes('--stats');
const statusFilter = process.argv.includes('--status')
  ? process.argv[process.argv.indexOf('--status') + 1]
  : null;

try {
  if (showStats) {
    const stats = {};
    const rows = db.prepare('SELECT status, COUNT(*) as count FROM upwork_jobs GROUP BY status').all();
    for (const row of rows) {
      stats[row.status] = row.count;
    }
    const total = db.prepare('SELECT COUNT(*) as count FROM upwork_jobs').get();
    const recent = db.prepare('SELECT COUNT(*) as count FROM upwork_jobs WHERE created_at > datetime("now", "-7 days")').get();

    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      total: total.count,
      lastWeek: recent.count,
      byStatus: stats,
    }, null, 2));
  } else {
    let query = 'SELECT uid, title, status, match_score, rate_max, budget, created_at FROM upwork_jobs';
    const params = [];

    if (statusFilter) {
      query += ' WHERE status = ?';
      params.push(statusFilter);
    }

    query += ' ORDER BY created_at DESC LIMIT 20';

    const jobs = db.prepare(query).all(...params);
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      count: jobs.length,
      jobs,
    }, null, 2));
  }
} catch (e) {
  console.log(JSON.stringify({ error: e.message }));
} finally {
  db.close();
}
