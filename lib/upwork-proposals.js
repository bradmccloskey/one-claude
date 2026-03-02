'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { claudePWithSemaphore } = require('./exec');

const PROFILE_PATH = '/Users/claude/projects/revenue/ai-automation-agency/content/upwork/profile.md';
const PROPOSALS_DIR = '/Users/claude/projects/revenue/ai-automation-agency/content/upwork/proposal-templates/';
const WINNING_DIR = '/Users/claude/projects/revenue/ai-automation-agency/content/upwork/winning-proposals/';
const PROPOSAL_TIMEOUT = 120000; // 2 minutes

/**
 * UpworkProposals — AI-powered proposal generation via claude -p.
 *
 * Generates tailored cover letters using job context, Brad's profile,
 * and the 2 most relevant past proposal templates. Handles screening
 * question answers when present.
 *
 * Designed for fire-and-forget usage — generateAndSave() catches all
 * errors internally and never rethrows.
 */
class UpworkProposals {
  /**
   * @param {Object} opts
   * @param {import('./upwork-db')} opts.db - UpworkDB instance (already instantiated)
   * @param {Function} [opts.log] - Logger function
   */
  constructor({ db, log }) {
    this._udb = db;
    this._log = log || console.log;
  }

  /**
   * Generate a proposal and save it to the database. Fire-and-forget safe.
   * @param {Object} job - Job row from upwork_jobs
   */
  async generateAndSave(job) {
    try {
      const { coverLetter, screeningAnswers } = await this._generateProposal(job);
      this._udb.upsertProposal(job.id, coverLetter, screeningAnswers);
      this._udb.updateJobStatus(job.uid, 'proposal_ready');
      this._log(`[UPWORK-PROP] Generated proposal for "${job.title}" (${job.uid})`);
    } catch (err) {
      this._log(`[UPWORK-PROP] Failed for ${job.uid}: ${err.message}`);
    }
  }

  /**
   * Build the prompt and call claude -p to generate a proposal.
   * @param {Object} job
   * @returns {{ coverLetter: string, screeningAnswers: string|null }}
   */
  async _generateProposal(job) {
    // Load Brad's profile
    let profile = '';
    try {
      profile = fs.readFileSync(PROFILE_PATH, 'utf-8');
    } catch (e) {
      this._log(`[UPWORK-PROP] WARNING: Could not read profile: ${e.message}`);
    }

    // Load relevant templates and winning proposals
    const templates = this._loadRelevantTemplates(job.title);
    const winningExamples = this._loadWinningProposals(job.title, job.description);

    // Format rate text
    let rateText = 'Rate unknown';
    if (job.job_type === 'hourly' && (job.rate_min != null || job.rate_max != null)) {
      const min = job.rate_min != null ? `$${job.rate_min}` : '?';
      const max = job.rate_max != null ? `$${job.rate_max}` : '?';
      rateText = `${min}-${max}/hr`;
    } else if (job.job_type === 'fixed' && job.budget != null) {
      rateText = `$${job.budget} fixed`;
    }

    const screeningQuestions = job.screening_questions || null;

    const prompt = `You are writing a winning Upwork proposal for Brad McCloskey, an AI automation engineer.

## Job Posting
Title: ${job.title}
Rate: ${rateText}
Client rating: ${job.client_rating || 'unknown'}
Client total spent: ${job.client_total_spent || 'unknown'}

### Job Description
${job.description || '(no description available)'}

### Screening Questions
${screeningQuestions || '(none)'}

## Brad's Profile
${profile}

## Proposal Templates (structure and format reference)
${templates}

${winningExamples ? `## Real Winning Proposals (match this voice, confidence, and specificity)
${winningExamples}` : ''}

## Instructions
Write a complete cover letter (250-400 words) in Brad's voice — direct, confident, specific to the job.
Open with a hook showing you understand the client's problem. Reference 1-2 relevant past projects.
Close with a clear next step.

${screeningQuestions ? 'After the cover letter, answer each screening question separately. Label each: "Q: [question]" followed by "A: [answer]". Keep answers concise (2-4 sentences each).' : ''}

Output ONLY the proposal text — no preamble, no meta-commentary, no markdown headers.`;

    const output = await claudePWithSemaphore(prompt, {
      timeout: PROPOSAL_TIMEOUT,
      maxTurns: 1,
    });

    // Parse cover letter vs screening answers
    let coverLetter = output;
    let screeningAnswers = null;

    if (screeningQuestions) {
      const qIndex = output.indexOf('\nQ:');
      if (qIndex > 0) {
        coverLetter = output.substring(0, qIndex).trim();
        screeningAnswers = output.substring(qIndex).trim();
      }
    }

    return { coverLetter, screeningAnswers };
  }

  /**
   * Load the top 2 most relevant proposal templates by keyword overlap.
   * @param {string} jobTitle
   * @returns {string}
   */
  _loadRelevantTemplates(jobTitle) {
    try {
      if (!fs.existsSync(PROPOSALS_DIR)) return '';

      const files = fs.readdirSync(PROPOSALS_DIR).filter(f => f.endsWith('.md'));
      if (!files.length) return '';

      const titleWords = (jobTitle || '').toLowerCase().split(/[\s\-_]+/);

      const scored = files.map(file => {
        const keywords = file.replace('.md', '').split('-');
        const overlap = keywords.filter(k => titleWords.some(w => w.includes(k) || k.includes(w))).length;
        return { file, score: overlap };
      });

      // Sort by score descending, take top 2
      scored.sort((a, b) => b.score - a.score);
      const top = scored.slice(0, 2);

      const contents = top.map(({ file }) => {
        try {
          return fs.readFileSync(path.join(PROPOSALS_DIR, file), 'utf-8');
        } catch {
          return '';
        }
      }).filter(Boolean);

      return contents.join('\n\n---\n\n');
    } catch (e) {
      return '';
    }
  }

  /**
   * Load the best matching winning proposal by category tags and content overlap.
   * Returns at most 1 winning proposal to keep context lean.
   * @param {string} jobTitle
   * @param {string} [jobDescription]
   * @returns {string}
   */
  _loadWinningProposals(jobTitle, jobDescription) {
    try {
      if (!fs.existsSync(WINNING_DIR)) return '';

      const files = fs.readdirSync(WINNING_DIR).filter(f => f.endsWith('.md'));
      if (!files.length) return '';

      const searchText = `${jobTitle || ''} ${jobDescription || ''}`.toLowerCase();
      const searchWords = searchText.split(/[\s\-_,.:;]+/).filter(w => w.length > 2);

      const scored = files.map(file => {
        try {
          const content = fs.readFileSync(path.join(WINNING_DIR, file), 'utf-8');
          // Extract category tags from HTML comment
          const catMatch = content.match(/<!-- category: (.+?) -->/);
          const categories = catMatch ? catMatch[1].split(/,\s*/) : [];

          // Score by category tag matches against job text
          const catScore = categories.filter(cat =>
            searchWords.some(w => cat.includes(w) || w.includes(cat))
          ).length;

          // Score by filename keyword overlap
          const keywords = file.replace('.md', '').split('-');
          const nameScore = keywords.filter(k =>
            searchWords.some(w => w.includes(k) || k.includes(w))
          ).length;

          return { file, content, score: catScore * 2 + nameScore };
        } catch {
          return { file, content: '', score: 0 };
        }
      });

      scored.sort((a, b) => b.score - a.score);
      const best = scored[0];

      // Only include if there's meaningful overlap
      if (!best || best.score < 1) return '';

      return best.content;
    } catch (e) {
      return '';
    }
  }
}

module.exports = UpworkProposals;
