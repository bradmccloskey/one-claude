'use strict';

const { execSync } = require('child_process');

/**
 * GitTracker - Stateless git progress tracking per project directory.
 *
 * Queries git state using execSync with `git -C`. Never stores data itself;
 * returns structured objects that callers persist. Never throws -- non-git
 * directories return a noGit sentinel object.
 */
class GitTracker {
  /**
   * Get git progress for a project directory, optionally filtered by time.
   *
   * @param {string} projectDir - Absolute path to project directory
   * @param {string} [since] - ISO timestamp (e.g., "2026-02-17T10:00:00Z") or git date string (e.g., "2 hours ago")
   * @returns {{ commitCount: number, insertions: number, deletions: number, filesChanged: number, fileList: string[], lastCommitHash: string|null, lastCommitMessage: string|null, lastCommitTimestamp: string|null, noGit: boolean }}
   */
  getProgress(projectDir, since) {
    const noGitResult = {
      commitCount: 0,
      insertions: 0,
      deletions: 0,
      filesChanged: 0,
      fileList: [],
      lastCommitHash: null,
      lastCommitMessage: null,
      lastCommitTimestamp: null,
      noGit: true,
    };

    try {
      const sinceArg = since ? `--since="${since}"` : '';

      // Count commits
      const countRaw = execSync(
        `git -C "${projectDir}" rev-list --count ${sinceArg} HEAD`,
        { encoding: 'utf-8', timeout: 5000 }
      ).trim();
      const commitCount = parseInt(countRaw, 10) || 0;

      // Aggregate diff stats via --numstat
      const numstatRaw = execSync(
        `git -C "${projectDir}" log --numstat --format='' ${sinceArg}`,
        { encoding: 'utf-8', timeout: 10000 }
      ).trim();

      let insertions = 0;
      let deletions = 0;
      const fileSet = new Set();

      if (numstatRaw) {
        for (const line of numstatRaw.split('\n')) {
          const parts = line.trim().split('\t');
          if (parts.length === 3) {
            // Binary files show '-' for added/deleted -- parseInt returns NaN, || 0 handles it
            const add = parseInt(parts[0], 10) || 0;
            const del = parseInt(parts[1], 10) || 0;
            insertions += add;
            deletions += del;
            fileSet.add(parts[2]);
          }
        }
      }

      // Last commit metadata
      const lastCommitRaw = execSync(
        `git -C "${projectDir}" log --format='%H|%s|%aI' -1`,
        { encoding: 'utf-8', timeout: 5000 }
      ).trim();

      let lastCommitHash = null;
      let lastCommitMessage = null;
      let lastCommitTimestamp = null;

      if (lastCommitRaw) {
        // Split with limit 3 to handle commit messages containing '|'
        const pipeIdx1 = lastCommitRaw.indexOf('|');
        if (pipeIdx1 !== -1) {
          lastCommitHash = lastCommitRaw.substring(0, pipeIdx1);
          const rest1 = lastCommitRaw.substring(pipeIdx1 + 1);
          const pipeIdx2 = rest1.lastIndexOf('|');
          if (pipeIdx2 !== -1) {
            lastCommitMessage = rest1.substring(0, pipeIdx2);
            lastCommitTimestamp = rest1.substring(pipeIdx2 + 1);
          } else {
            lastCommitMessage = rest1;
          }
        }
      }

      return {
        commitCount,
        insertions,
        deletions,
        filesChanged: fileSet.size,
        fileList: [...fileSet],
        lastCommitHash: lastCommitHash || null,
        lastCommitMessage: lastCommitMessage || null,
        lastCommitTimestamp: lastCommitTimestamp || null,
        noGit: false,
      };
    } catch {
      // Not a git repo, empty repo, or any other git error
      return noGitResult;
    }
  }
}

module.exports = GitTracker;
