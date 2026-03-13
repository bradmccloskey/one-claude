/**
 * ONE Claude v4.0 — Persistent Brain Architecture
 *
 * The Node.js process is the "nervous system" — handling SMS I/O, background
 * crons, and health monitoring. The "brain" is a persistent Claude Code session
 * running in tmux, accessible via both SMS and SSH.
 *
 * Architecture:
 *   launchd → node index.js
 *     ├── ClaudeSession (tmux "one-claude")
 *     ├── SMSBridge (iMessage ↔ Claude)
 *     └── Background Crons (health, scans, Upwork, revenue, etc.)
 */

const fs = require('fs');
const path = require('path');

// ── Config ──────────────────────────────────────────────────────────────────
const CONFIG = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8')
);

// ── Utility ─────────────────────────────────────────────────────────────────
function log(tag, msg) {
  console.log(`[${new Date().toISOString()}] [${tag}] ${msg}`);
}

// ── Initialize kept modules ─────────────────────────────────────────────────
const StateManager = require('./lib/state');
const ProjectScanner = require('./lib/scanner');
const ProcessMonitor = require('./lib/process-monitor');
const Messenger = require('./lib/messenger');
const WebServer = require('./lib/web-server');
const Scheduler = require('./lib/scheduler');
const SessionManager = require('./lib/session-manager');
const { SignalProtocol } = require('./lib/signal-protocol');
const GitTracker = require('./lib/git-tracker');
const ResourceMonitor = require('./lib/resource-monitor');
const NotificationManager = require('./lib/notification-manager');
const HealthMonitor = require('./lib/health-monitor');
const { SessionEvaluator } = require('./lib/session-evaluator');
const RevenueTracker = require('./lib/revenue-tracker');
const TrustTracker = require('./lib/trust-tracker');
const ReminderManager = require('./lib/reminder-manager');
const SessionLearner = require('./lib/session-learner');
const ScanDB = require('./lib/scan-db');
const EmailDigest = require('./lib/email-digest');
const UpworkScanner = require('./lib/upwork-scanner');
const UpworkDB = require('./lib/upwork-db');
const UpworkProposals = require('./lib/upwork-proposals');
const UpworkSubmitter = require('./lib/upwork-submitter');

// ── v4.0: Persistent Brain ─────────────────────────────────────────────────
const ClaudeSession = require('./lib/claude-session');
const SMSBridge = require('./lib/sms-bridge');

const state = new StateManager();
const scanDb = new ScanDB();
const scanner = new ProjectScanner(CONFIG.projectsDir, CONFIG.projects, { scanDb });
const processMonitor = new ProcessMonitor(CONFIG.projectsDir, CONFIG.idleThresholdMinutes);
const messenger = new Messenger(CONFIG);
const scheduler = new Scheduler(CONFIG);
const sessionManager = new SessionManager(CONFIG);
const signalProtocol = new SignalProtocol(CONFIG.projectsDir);
const gitTracker = new GitTracker();
const resourceMonitor = new ResourceMonitor();
const sessionLearner = new SessionLearner({ config: CONFIG });

const sessionEvaluator = new SessionEvaluator({
  gitTracker, state, config: CONFIG, sessionLearner,
});

const notificationManager = new NotificationManager({
  messenger, config: CONFIG, scheduler,
});
notificationManager.startBatchTimer();

const healthMonitor = new HealthMonitor({
  config: CONFIG, notificationManager, state,
});

const revenueTracker = new RevenueTracker({ config: CONFIG });
const trustTracker = new TrustTracker({ config: CONFIG, state });
const reminderManager = new ReminderManager({ config: CONFIG, notificationManager });

// ── Upwork Stack ────────────────────────────────────────────────────────────
const Database = require('better-sqlite3');
const ORCHESTRATOR_DB_PATH = path.join(__dirname, 'orchestrator.db');
const orchestratorDb = new Database(ORCHESTRATOR_DB_PATH);
orchestratorDb.pragma('journal_mode = WAL');

const upworkScanner = new UpworkScanner({ db: orchestratorDb, messenger, config: CONFIG });
upworkScanner.init().catch(e => log('UPWORK', `Browser init error: ${e.message}`));

const upworkDb = new UpworkDB(orchestratorDb);
upworkDb.ensureSchema();
const upworkProposals = new UpworkProposals({ db: upworkDb, log: (msg) => log('UPWORK', msg) });
const upworkSubmitter = new UpworkSubmitter({
  scanner: upworkScanner, db: upworkDb, messenger, notificationManager, config: CONFIG,
});

// ── Email Digest ────────────────────────────────────────────────────────────
const emailDigest = new EmailDigest({ scanner, healthMonitor, sessionManager, scanDb });

// ── Web Dashboard ───────────────────────────────────────────────────────────
const Commands = require('./lib/commands');
const commands = new Commands({
  scanner, processMonitor, scheduler, sessionManager, signalProtocol,
  state, projectNames: CONFIG.projects, messenger, trustTracker,
});
const webServer = new WebServer({
  scanner, healthMonitor, sessionManager, state, resourceMonitor,
  revenueTracker, trustTracker, commands, config: CONFIG, scheduler, scanDb,
  upworkDb, upworkProposals, upworkSubmitter,
  aiBrain: { getStatus: () => ({ enabled: false }), getLastDecision: () => null },
});
webServer.start().catch(e => log('WEB', `Dashboard start error: ${e.message}`));

// ── v4.0: Claude Session + SMS Bridge ───────────────────────────────────────
const claudeSession = new ClaudeSession({
  config: CONFIG, log, notificationManager,
});

const smsBridge = new SMSBridge({
  messenger, claudeSession, state, config: CONFIG, log,
});

// ── Session Evaluation ──────────────────────────────────────────────────────
async function evaluateSession(projectName) {
  try {
    const projectDir = path.join(CONFIG.projectsDir, projectName);
    const sessionFile = path.join(projectDir, '.orchestrator', 'session.json');
    if (!fs.existsSync(sessionFile)) return;

    const sessionData = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));

    const evalFile = path.join(projectDir, '.orchestrator', 'evaluation.json');
    if (fs.existsSync(evalFile)) {
      try {
        const existingEval = JSON.parse(fs.readFileSync(evalFile, 'utf-8'));
        if (new Date(existingEval.evaluatedAt) > new Date(sessionData.startedAt)) return;
      } catch {}
    }

    log('EVAL', `Evaluating session for ${projectName}...`);
    const evaluation = await sessionEvaluator.evaluate({
      projectName: sessionData.projectName || projectName,
      projectDir,
      sessionName: sessionData.sessionName,
      startedAt: sessionData.startedAt,
      headBefore: sessionData.headBefore || null,
      prompt: sessionData.prompt || '',
    });

    log('EVAL', `${projectName}: score=${evaluation.score}/5, recommendation=${evaluation.recommendation}`);

    if (evaluation.score <= 2) {
      notificationManager.notify(
        `Session ${projectName} scored ${evaluation.score}/5: ${evaluation.reasoning.substring(0, 200)}`,
        NotificationManager.URGENT
      );
    }
  } catch (e) {
    log('EVAL', `Error evaluating ${projectName}: ${e.message}`);
  }
}

// ── Proactive Scans (signals, sessions, STATE.md) ───────────────────────────
let lastScanResults = {};
let lastSignalState = {};

function proactiveScan() {
  if (scheduler.isQuietTime()) return;

  try {
    const s = state.load();
    const projects = scanner.scanAll();

    // 1. Scan STATE.md files for attention-needed changes
    for (const project of projects) {
      if (!project.needsAttention) continue;
      if (state.wasRecentlyAlerted(s, project.name)) continue;
      if (lastScanResults[project.name]?.needsAttention) continue;

      // Inject into Claude session instead of direct SMS
      if (claudeSession.isAlive()) {
        claudeSession.sendInput(
          `[SIGNAL] ${project.name} needs attention: ${project.attentionReason}`
        );
      }
      state.recordAlert(s, project.name, project.attentionReason);
      log('ALERT', `Injected alert for ${project.name}: ${project.attentionReason}`);
    }

    lastScanResults = {};
    for (const p of projects) {
      lastScanResults[p.name] = { needsAttention: p.needsAttention };
    }

    // 2. Scan signal files from managed child sessions
    const signals = signalProtocol.scanSignals(CONFIG.projects);
    for (const signal of signals) {
      const signalKey = `${signal.projectName}:${signal.type}`;
      if (lastSignalState[signalKey]) continue;

      // Inject signal into Claude session
      const notification = signalProtocol.formatSignalNotification(signal);
      if (claudeSession.isAlive()) {
        claudeSession.sendInput(`[SIGNAL] ${notification}`);
      }
      lastSignalState[signalKey] = true;
      log('SIGNAL', `${signal.type} from ${signal.projectName} → injected into Claude session`);
      signalProtocol.clearSignal(signal.projectName, signal.type);
    }

    // Clean up cleared signals
    const activeSignalKeys = new Set(signals.map(s => `${s.projectName}:${s.type}`));
    for (const key of Object.keys(lastSignalState)) {
      if (!activeSignalKeys.has(key)) delete lastSignalState[key];
    }

    // 3. Check for ended child sessions
    const sessions = sessionManager.getSessionStatuses();
    for (const session of sessions) {
      if (session.ended && !lastSignalState[`${session.projectName}:ended`]) {
        if (claudeSession.isAlive()) {
          claudeSession.sendInput(
            `[SIGNAL] ${session.projectName} session ended. Last output: ${(session.lastOutput || 'none').substring(0, 200)}`
          );
        }
        lastSignalState[`${session.projectName}:ended`] = true;
        log('SESSION', `Session ended for ${session.projectName}`);
        evaluateSession(session.projectName);
      }
    }

    s.lastScan = new Date().toISOString();
    state.save(s);
  } catch (e) {
    log('SCAN', `Error: ${e.message}`);
  }
}

// ── Session Timeout Enforcement ─────────────────────────────────────────────
// Track resume counts per project to enforce maxAutoResumes
const _sessionResumeCounts = {};

function checkSessionTimeouts() {
  const maxDurationMs = CONFIG.ai?.maxSessionDurationMs || 10800000;
  const maxAutoResumes = CONFIG.ai?.maxAutoResumes ?? 2;

  try {
    const sessions = sessionManager.getActiveSessions();
    for (const session of sessions) {
      const startTime = new Date(session.created).getTime();
      const duration = Date.now() - startTime;

      if (duration > maxDurationMs) {
        const durationMin = Math.round(duration / 60000);
        log('TIMEOUT', `Session ${session.projectName} exceeded ${Math.round(maxDurationMs / 60000)}min, stopping...`);

        // Evaluate before stopping (needs tmux pane output)
        evaluateSession(session.projectName).then((evaluation) => {
          sessionManager.stopSession(session.projectName);

          const resumeCount = _sessionResumeCounts[session.projectName] || 0;

          // Auto-resume if under the limit and evaluation recommends continuing
          const evalFile = path.join(CONFIG.projectsDir, session.projectName, '.orchestrator', 'evaluation.json');
          let shouldResume = false;
          let evalRec = 'unknown';
          try {
            if (fs.existsSync(evalFile)) {
              const evalData = JSON.parse(fs.readFileSync(evalFile, 'utf-8'));
              evalRec = evalData.recommendation;
              // Resume if evaluator says continue or retry, and we haven't hit the limit
              shouldResume = (evalRec === 'continue' || evalRec === 'retry') && resumeCount < maxAutoResumes;
            }
          } catch {}

          if (shouldResume) {
            _sessionResumeCounts[session.projectName] = resumeCount + 1;
            log('RESUME', `Auto-resuming ${session.projectName} (resume ${resumeCount + 1}/${maxAutoResumes}, eval=${evalRec})`);

            // Brief delay to let tmux session fully clean up
            setTimeout(() => {
              const result = sessionManager.startSession(session.projectName);
              if (result.success) {
                log('RESUME', `Successfully restarted ${session.projectName}`);
              } else {
                log('RESUME', `Failed to restart ${session.projectName}: ${result.message}`);
              }
              // Notify ONE Claude
              if (claudeSession.isAlive()) {
                claudeSession.sendInput(`[SYSTEM] Session ${session.projectName} timed out (${durationMin}min) and was auto-resumed (${resumeCount + 1}/${maxAutoResumes}). Eval: ${evalRec}.`);
              }
            }, 5000);
          } else {
            // No resume — final timeout
            delete _sessionResumeCounts[session.projectName];
            const reason = resumeCount >= maxAutoResumes
              ? `max resumes reached (${maxAutoResumes})`
              : `eval=${evalRec}`;
            const msg = `Session ${session.projectName} timed out (${durationMin}min). No auto-resume: ${reason}.`;
            log('TIMEOUT', msg);

            if (claudeSession.isAlive()) {
              claudeSession.sendInput(`[SYSTEM] ${msg}`);
            }
          }
        }).catch((e) => {
          // If evaluation fails, just stop without resume
          sessionManager.stopSession(session.projectName);
          const msg = `Session ${session.projectName} timed out (${Math.round(duration / 60000)}min). Eval failed: ${e.message}`;
          log('TIMEOUT', msg);
          if (claudeSession.isAlive()) {
            claudeSession.sendInput(`[SYSTEM] ${msg}`);
          }
        });
      }
    }
  } catch (e) {
    log('TIMEOUT', `Error: ${e.message}`);
  }
}

// ── Startup ─────────────────────────────────────────────────────────────────
console.log('╔═══════════════════════════════════════════════╗');
console.log('║       ONE Claude v4.0 — Persistent Brain     ║');
console.log('╠═══════════════════════════════════════════════╣');
console.log(`║  Your #:    ${CONFIG.myNumber.padEnd(33)}║`);
console.log(`║  Bot:       ${CONFIG.claudeNumber.padEnd(33)}║`);
console.log(`║  Projects:  ${String(CONFIG.projects.length).padEnd(33)}║`);
console.log(`║  Session:   ${(CONFIG.claudeSession?.sessionName || 'one-claude').padEnd(33)}║`);
console.log(`║  Msg poll:  ${(CONFIG.pollIntervalMs + 'ms').padEnd(33)}║`);
console.log(`║  Scan:      ${(CONFIG.scanIntervalMs + 'ms').padEnd(33)}║`);
console.log(`║  Quiet:     ${(CONFIG.quietHours.start + '-' + CONFIG.quietHours.end).padEnd(33)}║`);
console.log(`║  Health:    ${(CONFIG.health?.enabled ? CONFIG.health.services.length + ' services' : 'disabled').padEnd(33)}║`);
console.log(`║  Upwork:    ${(CONFIG.upwork?.enabled ? 'enabled' + (CONFIG.upwork.dryRun ? ' (DRY-RUN)' : '') : 'disabled').padEnd(33)}║`);
console.log('╚═══════════════════════════════════════════════╝');
console.log('');

// Run initial project scan
log('BOOT', 'Running initial project scan...');
const initialProjects = scanner.scanAll();
const withState = initialProjects.filter(p => p.hasState);
const needAttention = initialProjects.filter(p => p.needsAttention);
log('BOOT', `${initialProjects.length} projects, ${withState.length} with state, ${needAttention.length} need attention`);

// Check for existing child tmux sessions
const existingSessions = sessionManager.getActiveSessions();
if (existingSessions.length > 0) {
  log('BOOT', `Found ${existingSessions.length} existing child session(s):`);
  for (const s of existingSessions) {
    log('BOOT', `  ${s.projectName} (since ${s.created})`);
  }
}

// ── Start Claude Session ────────────────────────────────────────────────────
log('BOOT', 'Starting ONE Claude session...');
// Wait 5s for tmux to be ready
setTimeout(() => {
  const result = claudeSession.start();
  log('BOOT', `Claude session: ${result.message}`);

  // Start SMS bridge after Claude session is up
  // Wait for Claude to fully boot (MCP servers, hooks, etc.)
  setTimeout(() => {
    smsBridge.start();
    log('BOOT', 'SMS bridge started');
  }, 15000);
}, 5000);

// ── SMS Digest Helpers ───────────────────────────────────────────────────────

/**
 * Build and send a morning project status SMS directly from live data.
 * No Claude session injection — reliable and self-contained.
 */
function sendMorningSMS() {
  try {
    const projects = scanner.scanAllEnriched();
    const healthResults = healthMonitor.getLastResults();

    const active = projects.filter(p => p.hasState && !(p.status || '').toLowerCase().includes('complete')).length;
    const blocked = projects.filter(p => p.needsAttention && p.blockers.length > 0);
    const servicesUp = Object.values(healthResults).filter(s => s.status === 'up').length;
    const servicesTotal = Object.values(healthResults).length;
    const dirty = projects.filter(p => p.dirtyFiles > 0).map(p => p.name.split('/').pop());

    const lines = [`Good morning! ONE Claude status:`];
    lines.push(`${active}/${projects.length} projects active | ${servicesUp}/${servicesTotal} services up`);

    if (blocked.length > 0) {
      lines.push(`BLOCKED: ${blocked.map(p => p.name.split('/').pop()).join(', ')}`);
    }
    if (dirty.length > 0) {
      lines.push(`Uncommitted: ${dirty.slice(0, 3).join(', ')}${dirty.length > 3 ? ` +${dirty.length - 3}` : ''}`);
    }
    if (blocked.length === 0 && dirty.length === 0) {
      lines.push('All clear — no blockers or uncommitted changes.');
    }

    const msg = lines.join('\n');
    messenger.send(msg.length > 500 ? msg.slice(0, 497) + '...' : msg);
    log('DIGEST', 'Morning SMS sent');
  } catch (e) {
    log('DIGEST', `Morning SMS error: ${e.message}`);
  }
}

// ── Scheduled Jobs ──────────────────────────────────────────────────────────

// Morning digest (7 AM)
scheduler.startMorningDigest(async () => {
  try {
    emailDigest.send().catch(e => log('EMAIL', `Email digest error: ${e.message}`));
    sendMorningSMS();
  } catch (e) {
    log('DIGEST', `Morning digest error: ${e.message}`);
  }
});

// Evening digest (9:45 PM) — kept as session injection for now (conversational summary)
scheduler.startEveningDigest(async () => {
  // No-op: evening digest via Claude session removed (unreliable injection)
  // Future: add direct evening SMS similar to sendMorningSMS()
});

// Weekly revenue summary (Sunday 7 AM)
scheduler.startWeeklySummary(async () => {
  // No-op: weekly summary via Claude session removed (unreliable injection)
  // Future: pull revenue data directly from RevenueTracker and send SMS
});

// Daily trust promotion check (10 AM)
if (CONFIG.trust?.enabled && CONFIG.trust?.promotionCheckEnabled !== false) {
  require('node-cron').schedule(
    CONFIG.trust.promotionCheckCron || '0 10 * * *',
    () => {
      try {
        const recommendation = trustTracker.checkPromotion();
        if (recommendation) {
          notificationManager.notify(recommendation, NotificationManager.URGENT);
          log('TRUST', 'Promotion recommendation sent');
        }
      } catch (e) {
        log('TRUST', `Promotion check error: ${e.message}`);
      }
    },
    { timezone: CONFIG.quietHours?.timezone || 'America/New_York' }
  );
}

// Upwork scanner cron (30 min)
if (CONFIG.upwork?.enabled) {
  require('node-cron').schedule(
    CONFIG.upwork.pollCron || '*/30 * * * *',
    async () => {
      try {
        const result = await upworkScanner.poll();
        log('UPWORK', `Scan: found=${result.found}, filtered=${result.filtered}, inserted=${result.inserted}`);

        if (result.inserted > 0) {
          const pending = upworkDb.getPendingJobs(10);
          const needsProposal = pending.filter(j => j.status === 'new' && !j.cover_letter && (j.match_score || 0) >= 50);
          for (const job of needsProposal) {
            upworkProposals.generateAndSave(job);
          }
          if (needsProposal.length > 0) {
            log('UPWORK', `Queued ${needsProposal.length} proposal generation(s) (score >= 50)`);
          }

          // Notify for high-match jobs (budget must meet min_fixed_budget threshold)
          const autoSettings = upworkDb.getAutoApplySettings();
          if (autoSettings.notifyHighMatch) {
            const minBudget = autoSettings.minFixedBudget || 0;
            const highMatch = pending.filter(j => {
              if ((j.match_score || 0) < autoSettings.notifyThreshold) return false;
              // Require minimum budget — skip low-budget jobs
              const jobBudget = j.budget || j.rate_max || 0;
              if (minBudget > 0 && jobBudget < minBudget) return false;
              return true;
            });
            for (const job of highMatch) {
              const rate = job.rate_max ? `$${job.rate_max}/hr` : (job.budget ? `$${job.budget} fixed` : 'rate TBD');
              const msg = `UPWORK HIGH MATCH (${job.match_score}%)\n${job.title}\n${rate}\nhttps://www.upwork.com/jobs/~${job.uid}`;
              notificationManager.notify(msg, NotificationManager.URGENT);
            }
          }
        }

        // Auto-apply for qualifying jobs
        const autoApply = upworkDb.getAutoApplySettings();
        if (autoApply.enabled) {
          const hour = new Date().getHours();
          if (hour >= autoApply.startHour && hour < autoApply.endHour) {
            const dailyCount = upworkDb.getAutoApplyCountToday();
            if (dailyCount < autoApply.maxDaily) {
              const connects = upworkDb.getConnectsBalance();
              let currentBalance = connects.balance;
              if (currentBalance === null || currentBalance >= autoApply.connectsFloor) {
                const readyJobs = upworkDb.getPendingJobs(10).filter(
                  j => j.status === 'proposal_ready' && j.cover_letter && (j.match_score || 0) >= autoApply.threshold
                );
                const remaining = autoApply.maxDaily - dailyCount;
                const toApply = readyJobs.slice(0, remaining);
                for (const job of toApply) {
                  const connectsCost = 16;
                  if (currentBalance !== null && currentBalance < autoApply.connectsFloor) break;
                  upworkDb.updateJobStatus(job.uid, 'submitting', 'auto_applied');
                  if (currentBalance !== null) currentBalance -= connectsCost;
                  upworkSubmitter.submitJob(job, {
                    coverLetter: job.cover_letter,
                    screeningAnswers: job.proposal_screening_answers || null,
                  }).then(r => {
                    if (r.success) {
                      upworkDb.updateJobStatus(job.uid, 'applied', 'auto_applied');
                      const rateText = job.rate_max ? `$${job.rate_max}/hr` : (job.budget ? `$${job.budget} fixed` : '');
                      notificationManager.notify(
                        `UPWORK AUTO-APPLIED\n${job.title} ${rateText}\nScore: ${job.match_score}%`,
                        NotificationManager.URGENT
                      );
                    }
                  }).catch(e => log('UPWORK', `Auto-apply error for ${job.uid}: ${e.message}`));
                }
              }
            }
          }
        }
      } catch (e) {
        log('UPWORK', `Scan error: ${e.message}`);
      }
    },
    { timezone: CONFIG.quietHours?.timezone || 'America/New_York' }
  );
  log('UPWORK', 'Scanner cron scheduled');
}

// ── Background Scan Loop ────────────────────────────────────────────────────
let scanCount = 0;
const scanInterval = setInterval(() => {
  scanCount++;
  proactiveScan();
  checkSessionTimeouts();
  healthMonitor.checkAll();

  // Revenue collection every N scans
  const collectionInterval = CONFIG.revenue?.collectionIntervalScans || 5;
  if (CONFIG.revenue?.enabled && scanCount % collectionInterval === 0) {
    revenueTracker.collect().catch(e => log('REVENUE', `Collection error: ${e.message}`));
  }

  // Trust metrics update
  if (CONFIG.trust?.enabled) {
    try { trustTracker.update(); } catch (e) { log('TRUST', `Update error: ${e.message}`); }
  }

  // Scan DB cleanup every hour
  if (scanCount % 60 === 0) {
    try {
      const cleaned = scanDb.cleanup();
      if (cleaned > 0) log('SCANDB', `Cleaned ${cleaned} old scan records`);
    } catch (e) { log('SCANDB', `Cleanup error: ${e.message}`); }
  }

  // Reminder check
  if (CONFIG.reminders?.enabled !== false) {
    try { reminderManager.checkAndFire(); } catch (e) { log('REMINDER', `Check error: ${e.message}`); }
  }

  // Inject health alerts into Claude session on critical failures
  if (scanCount % 5 === 0 && claudeSession.isAlive()) {
    const healthStats = healthMonitor.getStats();
    if (healthStats.down > 0) {
      const downNames = healthStats.services
        .filter(s => s.status === 'down' && s.consecutiveFails >= 5)
        .map(s => s.name);
      if (downNames.length > 0) {
        claudeSession.sendInput(
          `[HEALTH] Services down: ${downNames.join(', ')}. Run \`node scripts/check-health.js\` for details.`
        );
      }
    }
  }
}, CONFIG.scanIntervalMs);

// Initial proactive scan after 5s
setTimeout(proactiveScan, 5000);

log('BOOT', 'ONE Claude v4.0 running. Persistent brain architecture active.');

// ── Graceful Shutdown ───────────────────────────────────────────────────────
function shutdown(signal) {
  log('SHUTDOWN', `Received ${signal}, stopping...`);
  log('SHUTDOWN', 'Note: ONE Claude tmux session will continue running independently.');
  clearInterval(scanInterval);
  smsBridge.stop();
  claudeSession.stop();
  notificationManager.stopBatchTimer();
  scheduler.stop();
  scanDb.close();
  revenueTracker.close();
  trustTracker.close();
  reminderManager.close();
  sessionLearner.close();
  upworkScanner.close().catch(() => {});
  orchestratorDb.close();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
