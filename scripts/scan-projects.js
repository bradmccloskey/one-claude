#!/usr/bin/env node
'use strict';

/**
 * scan-projects.js — Scan all projects for status, git info, and GSD progress.
 * Outputs JSON array of project status objects.
 *
 * Usage: node scripts/scan-projects.js [--project <name>] [--brief]
 */

const fs = require('fs');
const path = require('path');

const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf-8'));
const ProjectScanner = require('../lib/scanner');

const scanner = new ProjectScanner(CONFIG.projectsDir, CONFIG.projects);

const targetProject = process.argv.includes('--project')
  ? process.argv[process.argv.indexOf('--project') + 1]
  : null;

const brief = process.argv.includes('--brief');

if (targetProject) {
  const result = scanner.scanProject(targetProject);
  // Add git info
  const git = scanner._scanGit(result.path);
  Object.assign(result, git);
  const gsd = scanner._parseGsdRoadmap(result.path);
  Object.assign(result, gsd);
  console.log(JSON.stringify(result, null, 2));
} else {
  const projects = scanner.scanAll();

  if (brief) {
    const summary = projects.map(p => ({
      name: p.name,
      status: p.status || 'unknown',
      progress: p.progress,
      needsAttention: p.needsAttention,
      attentionReason: p.attentionReason,
    }));
    console.log(JSON.stringify(summary, null, 2));
  } else {
    // Enrich with git + GSD data
    for (const p of projects) {
      if (!p.exists) continue;
      const git = scanner._scanGit(p.path);
      Object.assign(p, git);
      const gsd = scanner._parseGsdRoadmap(p.path);
      Object.assign(p, gsd);
    }
    console.log(JSON.stringify(projects, null, 2));
  }
}
