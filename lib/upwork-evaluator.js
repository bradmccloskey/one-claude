'use strict';

/**
 * UpworkEvaluator — Evaluates scraped Upwork jobs against configurable filters.
 *
 * Filters are applied in order — first match wins:
 *   1. Rate floor (hourly jobs only)
 *   2. Payment verification
 *   3. Video interview detection (text-based)
 *
 * Returns { status: 'new'|'filtered', reason: string|null }
 */
class UpworkEvaluator {
  /**
   * Evaluate a job against the current settings.
   *
   * @param {Object} job
   * @param {string} job.jobType - 'hourly', 'fixed', or 'unknown'
   * @param {number|null} job.rateMin
   * @param {number|null} job.rateMax
   * @param {number|null} job.budget
   * @param {number} job.clientPaymentVerified - 0 or 1
   * @param {string|null} job.description
   *
   * @param {Object} settings
   * @param {string} settings.rate_floor_hourly - e.g. '40'
   * @param {string} settings.require_payment_verified - '0' or '1'
   * @param {string} settings.min_client_spent - seeded but unused in Phase 1
   *
   * @returns {{ status: 'new'|'filtered', reason: string|null }}
   */
  evaluate(job, settings) {
    // Filter 1 — Rate floor (hourly only)
    // Critical: this filter ONLY fires when job.jobType === 'hourly'.
    // Fixed-price jobs and unknown type jobs pass regardless of budget value.
    const rateFloor = parseFloat(settings.rate_floor_hourly || '40');
    if (job.jobType === 'hourly' && job.rateMax !== null && job.rateMax < rateFloor) {
      return { status: 'filtered', reason: `rate_below_floor:${job.rateMax}<${rateFloor}` };
    }

    // Filter 2 — Payment verification
    const requireVerified = parseInt(settings.require_payment_verified || '0') === 1;
    if (requireVerified && !job.clientPaymentVerified) {
      return { status: 'filtered', reason: 'payment_not_verified' };
    }

    // EVAL-02: min_client_spent filter deferred to Phase 2 when detail-page scraping
    // provides clientTotalSpent data. The setting is seeded in upwork_settings but
    // clientTotalSpent is always null from card-level scraping in Phase 1.

    // Filter 3 — Video interview (text-based, best-effort)
    const descLower = (job.description || '').toLowerCase();
    const videoPatterns = [
      'video interview',
      'instant interview',
      'uma interview',
      /recorded.{0,20}interview/i,
    ];
    const hasVideo = videoPatterns.some(p =>
      p instanceof RegExp ? p.test(descLower) : descLower.includes(p)
    );
    if (hasVideo) {
      return { status: 'filtered', reason: 'video_interview_required' };
    }

    // No filter matched — job passes
    return { status: 'new', reason: null };
  }

  /**
   * Compute a weighted match score (0-100) for a job.
   * Weights: skill match (0-40), rate alignment (0-20), client quality (0-25), scope fit (0-15).
   *
   * @param {Object} job
   * @returns {number} 0-100
   */
  static scoreJob(job) {
    // 1. Skill match (0-40)
    const bradSkills = ['python', 'javascript', 'playwright', 'automation', 'ai', 'claude',
      'scraping', 'fastapi', 'sqlite', 'docker', 'cloudflare', 'network', 'n8n', 'llm',
      'node', 'typescript', 'api', 'web'];
    const jobText = `${job.title || ''} ${job.description || ''} ${job.skills || ''}`.toLowerCase();
    const matchedSkills = bradSkills.filter(s => jobText.includes(s));
    const skillScore = Math.min(40, Math.round((matchedSkills.length / 5) * 40));

    // 2. Rate alignment (0-20)
    let rateScore = 10; // neutral for fixed-price / unknown
    if (job.jobType === 'hourly' && job.rateMax != null) {
      if (job.rateMax >= 100) rateScore = 20;
      else if (job.rateMax >= 60) rateScore = 15;
      else if (job.rateMax >= 40) rateScore = 10;
      else rateScore = 0;
    }

    // 3. Client quality (0-25)
    let clientScore = 0;
    if (job.clientPaymentVerified) clientScore += 10;
    if (job.clientRating != null) clientScore += Math.round((job.clientRating / 5) * 10);
    if (job.clientTotalSpent) {
      if (/1m\+/i.test(job.clientTotalSpent)) clientScore += 5;
      else if (/[0-9]+k\+/i.test(job.clientTotalSpent)) {
        const k = parseInt(job.clientTotalSpent, 10);
        if (k >= 100) clientScore += 5;
        else if (k >= 10) clientScore += 3;
      }
    }
    clientScore = Math.min(25, clientScore);

    // 4. Scope fit (0-15)
    let scopeScore = 10;
    if (job.proposalsCount) {
      if (/less than 5/i.test(job.proposalsCount)) scopeScore = 15;
      else if (/5.{0,5}10/i.test(job.proposalsCount)) scopeScore = 12;
      else if (/[2-4][0-9]\+/i.test(job.proposalsCount)) scopeScore = 5;
    }

    return Math.min(100, skillScore + rateScore + clientScore + scopeScore);
  }
}

module.exports = UpworkEvaluator;
