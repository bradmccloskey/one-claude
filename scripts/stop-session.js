#!/usr/bin/env node
'use strict';

/**
 * stop-session.js — Stop a child Claude Code session for a project.
 * Outputs JSON result.
 *
 * Usage: node scripts/stop-session.js <project-name>
 */

const fs = require('fs');
const path = require('path');

const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf-8'));
const SessionManager = require('../lib/session-manager');

const sessionManager = new SessionManager(CONFIG);

const projectName = process.argv[2];
if (!projectName) {
  console.log(JSON.stringify({ success: false, message: 'Usage: stop-session.js <project-name>' }));
  process.exit(1);
}

const result = sessionManager.stopSession(projectName);
console.log(JSON.stringify(result, null, 2));
