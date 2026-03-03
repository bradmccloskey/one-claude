'use strict';

const UpworkEvaluator = require('./lib/upwork-evaluator');

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${label}`);
  } else {
    failed++;
    console.error(`  FAIL: ${label}`);
  }
}

// ── scoreJob tests ──────────────────────────────────────────

console.log('\n=== Skill Matching (word boundaries) ===');

const skillJob = (text) => UpworkEvaluator.scoreJob({
  title: text, description: '', skills: '', jobType: 'hourly', rateMax: 50,
  clientPaymentVerified: 1, clientRating: 4.5, clientTotalSpent: '$10K+', proposalsCount: '5 to 10',
});

// "api" should match standalone "API" but not words containing "api"
const apiJob = skillJob('Build a REST API');
const capitalJob = skillJob('Capital investment platform');
assert(apiJob > capitalJob, '"REST API" scores higher than "Capital" (no false positive on "api")');

// "web" should match standalone but not "cobweb"
const webJob = skillJob('Web scraping project');
const cobwebJob = skillJob('Clean cobweb database');
assert(webJob > cobwebJob, '"Web scraping" scores higher than "cobweb" (no false positive on "web")');

// "node" should match "Node.js"
const nodeJob = skillJob('Node.js backend developer');
assert(nodeJob > 0, '"Node.js" gets a positive score');

// Multiple skill matches should score high
const multiSkill = skillJob('Python playwright automation Claude AI web scraping');
assert(multiSkill >= 40, `Multi-skill job scores 40+ (got ${multiSkill})`);

// New skills should match
const chatgptJob = skillJob('ChatGPT API integration');
assert(chatgptJob > capitalJob, '"ChatGPT" is recognized as a matching skill');

console.log('\n=== Client Spent Parsing ===');

const clientJob = (spent) => UpworkEvaluator.scoreJob({
  title: 'Python API', description: '', skills: '', jobType: 'hourly', rateMax: 50,
  clientPaymentVerified: 1, clientRating: 4.5, clientTotalSpent: spent, proposalsCount: '5 to 10',
});

const spent100k = clientJob('$100K+');
const spent10k = clientJob('$10K+');
const spent1k = clientJob('$1K+');
const spent500 = clientJob('$500');
const spentNone = clientJob(null);

assert(spent100k > spent10k, '$100K+ scores higher than $10K+');
assert(spent10k > spent1k, '$10K+ scores higher than $1K+');
assert(spent1k > spentNone, '$1K+ scores higher than no spend history');
assert(spent100k > spentNone, '$100K+ scores significantly higher than null');

// Test "$1M+" format
const spent1m = clientJob('$1M+');
assert(spent1m >= spent100k, '$1M+ scores at least as high as $100K+');

// Test raw number format
const spentRaw = clientJob('$50,000');
assert(spentRaw > spentNone, '"$50,000" raw number is parsed correctly');

console.log('\n=== Unvetted Client Penalty ===');

const newClient = UpworkEvaluator.scoreJob({
  title: 'Python automation', description: '', skills: '', jobType: 'hourly', rateMax: 60,
  clientPaymentVerified: 0, clientRating: null, clientTotalSpent: null, proposalsCount: '5 to 10',
});
const vetted = UpworkEvaluator.scoreJob({
  title: 'Python automation', description: '', skills: '', jobType: 'hourly', rateMax: 60,
  clientPaymentVerified: 1, clientRating: 4.5, clientTotalSpent: '$10K+', proposalsCount: '5 to 10',
});
assert(vetted > newClient, 'Vetted client scores higher than brand-new unverified client');
assert(newClient < 70, `Unvetted client doesn't score 70+ (got ${newClient})`);

console.log('\n=== Filter Tests ===');

const ev = new UpworkEvaluator();
const settings = {
  rate_floor_hourly: '40',
  require_payment_verified: '0',
  min_fixed_budget: '200',
};

// Hourly below floor
const r1 = ev.evaluate({ jobType: 'hourly', rateMax: 30, budget: null, clientPaymentVerified: 0, description: '' }, settings);
assert(r1.status === 'filtered', 'Hourly $30/hr filtered below $40 floor');

// Hourly above floor
const r2 = ev.evaluate({ jobType: 'hourly', rateMax: 50, budget: null, clientPaymentVerified: 0, description: '' }, settings);
assert(r2.status === 'new', 'Hourly $50/hr passes $40 floor');

// Fixed below budget floor
const r3 = ev.evaluate({ jobType: 'fixed', rateMax: null, budget: 100, clientPaymentVerified: 0, description: '' }, settings);
assert(r3.status === 'filtered', 'Fixed $100 filtered below $200 floor');

// Fixed above budget floor
const r4 = ev.evaluate({ jobType: 'fixed', rateMax: null, budget: 500, clientPaymentVerified: 0, description: '' }, settings);
assert(r4.status === 'new', 'Fixed $500 passes $200 floor');

// Video interview filter
const r5 = ev.evaluate({ jobType: 'hourly', rateMax: 60, budget: null, clientPaymentVerified: 0, description: 'Must complete video interview first' }, settings);
assert(r5.status === 'filtered', 'Video interview job filtered');
assert(r5.reason === 'video_interview_required', 'Correct filter reason for video interview');

// ── Summary ──────────────────────────────────────────

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
