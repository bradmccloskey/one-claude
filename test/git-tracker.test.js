'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const GitTracker = require('../lib/git-tracker');

const PROJECT_DIR = path.resolve(__dirname, '..');

describe('GitTracker', () => {
  const tracker = new GitTracker();

  it('getProgress() returns valid structure for current repo', () => {
    const result = tracker.getProgress(PROJECT_DIR);

    assert.ok(result.commitCount >= 1, `commitCount should be >= 1, got ${result.commitCount}`);
    assert.ok(result.insertions >= 0, 'insertions should be >= 0');
    assert.ok(result.deletions >= 0, 'deletions should be >= 0');
    assert.ok(result.filesChanged >= 0, 'filesChanged should be >= 0');
    assert.ok(Array.isArray(result.fileList), 'fileList should be an array');
    assert.equal(typeof result.lastCommitHash, 'string');
    assert.equal(result.lastCommitHash.length, 40, 'lastCommitHash should be 40-char SHA');
    assert.equal(typeof result.lastCommitTimestamp, 'string');
    assert.ok(!result.noGit, 'noGit should be false for a valid repo');
  });

  it('getProgress() returns noGit sentinel for non-repo directory', () => {
    const result = tracker.getProgress('/tmp');

    assert.equal(result.noGit, true);
    assert.equal(result.commitCount, 0);
    assert.equal(result.insertions, 0);
    assert.equal(result.deletions, 0);
    assert.deepEqual(result.fileList, []);
    assert.equal(result.lastCommitHash, null);
  });

  it('getProgress() returns noGit sentinel for nonexistent path', () => {
    const result = tracker.getProgress('/tmp/does-not-exist-' + Date.now());

    assert.equal(result.noGit, true);
    assert.equal(result.commitCount, 0);
    // Must never throw
  });

  it('getProgress() with future since parameter filters to zero commits', () => {
    const futureDate = new Date(Date.now() + 86400000).toISOString();
    const result = tracker.getProgress(PROJECT_DIR, futureDate);

    assert.equal(result.commitCount, 0, 'no commits should exist in the future');
  });
});
