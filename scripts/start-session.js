#!/usr/bin/env node
'use strict';

/**
 * start-session.js — Start a child Claude Code session for a project.
 * Outputs JSON result.
 *
 * Usage: node scripts/start-session.js <project-name> [prompt...]
 */

const fs = require('fs');
const path = require('path');

const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf-8'));
const SessionManager = require('../lib/session-manager');

const sessionManager = new SessionManager(CONFIG);

const projectName = process.argv[2];
if (!projectName) {
  console.log(JSON.stringify({ success: false, message: 'Usage: start-session.js <project-name> [prompt...]' }));
  process.exit(1);
}

// Everything after the project name is the prompt
const prompt = process.argv.slice(3).join(' ') || undefined;

const result = sessionManager.startSession(projectName, prompt);
console.log(JSON.stringify(result, null, 2));
