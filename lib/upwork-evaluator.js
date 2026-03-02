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
}

module.exports = UpworkEvaluator;
