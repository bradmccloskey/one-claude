#!/usr/bin/env node
'use strict';

/**
 * list-sessions.js — List all active orchestrator-managed tmux sessions.
 * Outputs JSON array of session objects.
 *
 * Usage: node scripts/list-sessions.js
 */

const fs = require('fs');
const path = require('path');

const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf-8'));
const SessionManager = require('../lib/session-manager');

const sessionManager = new SessionManager(CONFIG);
const sessions = sessionManager.getSessionStatuses();

const output = {
  timestamp: new Date().toISOString(),
  count: sessions.length,
  sessions: sessions.map(s => ({
    name: s.name,
    projectName: s.projectName,
    created: s.created,
    needsInput: !!s.needsInput,
    error: !!s.error,
    completed: !!s.completed,
  })),
};

console.log(JSON.stringify(output, null, 2));
