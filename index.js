const fs = require("fs");
const path = require("path");

const StateManager = require("./lib/state");
const ProjectScanner = require("./lib/scanner");
const ProcessMonitor = require("./lib/process-monitor");
const Messenger = require("./lib/messenger");
const DigestFormatter = require("./lib/digest");
const Scheduler = require("./lib/scheduler");
const CommandRouter = require("./lib/commands");
const SessionManager = require("./lib/session-manager");
const { SignalProtocol } = require("./lib/signal-protocol");
const ContextAssembler = require("./lib/context-assembler");
const AIBrain = require("./lib/ai-brain");
const DecisionExecutor = require("./lib/decision-executor");
const NotificationManager = require("./lib/notification-manager");
const ConversationStore = require("./lib/conversation-store");
const GitTracker = require("./lib/git-tracker");
const ResourceMonitor = require("./lib/resource-monitor");
const HealthMonitor = require("./lib/health-monitor");
const { SessionEvaluator } = require("./lib/session-evaluator");
const RevenueTracker = require("./lib/revenue-tracker");
const TrustTracker = require("./lib/trust-tracker");
const ReminderManager = require("./lib/reminder-manager");

// ── Config ──────────────────────────────────────────────────────────────────
const CONFIG = JSON.parse(
  fs.readFileSync(path.join(__dirname, "config.json"), "utf-8")
);

// ── Initialize modules ──────────────────────────────────────────────────────
const state = new StateManager();
const scanner = new ProjectScanner(CONFIG.projectsDir, CONFIG.projects);
const processMonitor = new ProcessMonitor(CONFIG.projectsDir, CONFIG.idleThresholdMinutes);
const messenger = new Messenger(CONFIG);
const digest = new DigestFormatter();
const scheduler = new Scheduler(CONFIG);
const sessionManager = new SessionManager(CONFIG);
const signalProtocol = new SignalProtocol(CONFIG.projectsDir);
const gitTracker = new GitTracker();
const resourceMonitor = new ResourceMonitor();

// ── Session Evaluator ────────────────────────────────────────────────────────
const sessionEvaluator = new SessionEvaluator({
  gitTracker,
  state,
  config: CONFIG,
});

// ── Notifications ────────────────────────────────────────────────────────────
const notificationManager = new NotificationManager({
  messenger,
  config: CONFIG,
  scheduler,
});
notificationManager.startBatchTimer();

// ── Health Monitor (v4.0 Phase 05) ──────────────────────────────────────────
const healthMonitor = new HealthMonitor({
  config: CONFIG,
  notificationManager,
  state,
});

// ── Revenue Tracker (v4.0 Phase 06) ─────────────────────────────────────────
const revenueTracker = new RevenueTracker({ config: CONFIG });

// ── Trust Tracker (v4.0 Phase 06) ───────────────────────────────────────────
const trustTracker = new TrustTracker({ config: CONFIG, state });

// ── Reminder Manager (v4.0 Phase 07) ────────────────────────────────────────
const reminderManager = new ReminderManager({ config: CONFIG, notificationManager });

// ── AI Brain (v3.0) ─────────────────────────────────────────────────────────
const contextAssembler = new ContextAssembler({
  scanner,
  sessionManager,
  processMonitor,
  state,
  config: CONFIG,
  resourceMonitor,
  healthMonitor,
  revenueTracker,
  trustTracker,
});

const decisionExecutor = new DecisionExecutor({
  sessionManager,
  messenger,
  notificationManager,
  signalProtocol,
  state,
  config: CONFIG,
});

const aiBrain = new AIBrain({
  contextAssembler,
  decisionExecutor,
  state,
  messenger,
  config: CONFIG,
});

const conversationStore = new ConversationStore();

const commands = new CommandRouter({
  scanner,
  processMonitor,
  digest,
  scheduler,
  sessionManager,
  signalProtocol,
  state,
  projectNames: CONFIG.projects,
  aiBrain,
  decisionExecutor,
  messenger,
  conversationStore,
  reminderManager,
});

// ── Utility ─────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(tag, msg) {
  console.log(`[${new Date().toISOString()}] [${tag}] ${msg}`);
}

// ── Send morning digest ─────────────────────────────────────────────────────
async function sendDigest() {
  try {
    // Try AI-generated digest first
    if (aiBrain.isEnabled()) {
      log("DIGEST", "Generating AI digest...");
      const aiDigest = await aiBrain.generateDigest();
      if (aiDigest) {
        messenger.send(aiDigest);
        const s = state.load();
        s.lastDigest = new Date().toISOString();
        state.save(s);
        log("DIGEST", "Sent AI-generated morning digest");
        return;
      }
      log("DIGEST", "AI digest failed, falling back to template");
    }

    // Fallback to template digest
    const projects = scanner.scanAll();
    const processStatus = processMonitor.checkProjects(CONFIG.projects);
    const text = digest.formatMorningDigest(projects, processStatus);
    messenger.send(text);
    const s = state.load();
    s.lastDigest = new Date().toISOString();
    state.save(s);
    log("DIGEST", "Sent template morning digest");
  } catch (e) {
    log("DIGEST", `Error: ${e.message}`);
  }
}

// ── Send evening wind-down digest ────────────────────────────────────────────
async function sendEveningDigest() {
  try {
    const { claudePWithSemaphore } = require('./lib/exec');

    // Gather today's data
    const stateData = state.load();
    const today = new Date().toISOString().split('T')[0];
    const todayExecs = (stateData.executionHistory || []).filter(e =>
      e.timestamp && e.timestamp.startsWith(today)
    );
    const todayEvals = (stateData.evaluationHistory || []).filter(e =>
      e.evaluatedAt && e.evaluatedAt.startsWith(today)
    );

    // Get commits across all projects today
    const commitSummaries = [];
    for (const projectName of CONFIG.projects) {
      try {
        const projectDir = path.join(CONFIG.projectsDir, projectName);
        const progress = gitTracker.getProgress(projectDir, 24);
        if (progress.commitCount > 0) {
          commitSummaries.push(`${projectName}: ${progress.commitCount} commits (+${progress.insertions}/-${progress.deletions})`);
        }
      } catch {}
    }

    const prompt = [
      'You are the AI brain of a project orchestrator. Generate a concise evening wind-down digest SMS (max 500 chars).',
      '',
      `Date: ${today}`,
      '',
      `Sessions today: ${todayExecs.filter(e => e.action === 'start').length} started`,
      `Evaluations today: ${todayEvals.length} (avg score: ${todayEvals.length > 0 ? (todayEvals.reduce((s, e) => s + (e.score || 0), 0) / todayEvals.length).toFixed(1) : 'N/A'})`,
      '',
      'Commits today:',
      commitSummaries.length > 0 ? commitSummaries.join('\n') : 'None',
      '',
      'Summarize the day\'s accomplishments and suggest what to focus on tomorrow. Be brief and actionable.',
    ].join('\n');

    const digest = await claudePWithSemaphore(prompt, { maxTurns: 1 });
    if (digest) {
      messenger.send(digest.substring(0, 1500));
      log('DIGEST', 'Sent evening wind-down digest');
    }
  } catch (e) {
    log('DIGEST', `Evening digest error: ${e.message}`);
  }
}

// ── Send weekly revenue summary ─────────────────────────────────────────────
async function sendWeeklyRevenueSummary() {
  try {
    const trend = revenueTracker.getWeeklyTrend();
    const latest = revenueTracker.getLatest();

    const lines = ['Weekly Revenue Summary:'];
    lines.push('');

    // XMR Mining section
    lines.push('XMR Mining:');
    const xmr = latest['xmr-mining'];
    if (xmr && xmr.balance_atomic !== null) {
      const balXMR = (xmr.balance_atomic / 1e12).toFixed(6);
      const balUSD = xmr.xmr_price_usd ? (xmr.balance_atomic / 1e12 * xmr.xmr_price_usd).toFixed(2) : '?';
      lines.push(`  Balance: ${balXMR} XMR ($${balUSD})`);
      lines.push(`  Hashrate: ${xmr.hashrate || 0} H/s`);
    } else {
      lines.push('  No data available');
    }

    if (trend.thisWeek.xmr) {
      const tw = trend.thisWeek.xmr;
      lines.push(`  This week: ${tw.changeXMR >= 0 ? '+' : ''}${tw.changeXMR.toFixed(6)} XMR ($${tw.changeUSD.toFixed(2)})`);
      if (trend.lastWeek.xmr) {
        const lw = trend.lastWeek.xmr;
        const pctChange = lw.changeUSD !== 0
          ? Math.round((tw.changeUSD - lw.changeUSD) / Math.abs(lw.changeUSD) * 100)
          : null;
        lines.push(`  WoW: ${pctChange !== null ? (pctChange >= 0 ? '+' : '') + pctChange + '%' : 'N/A (first week)'}`);
      } else {
        lines.push('  WoW: N/A (first week)');
      }
    }

    lines.push('');

    // MLX API section
    lines.push('MLX API:');
    if (trend.thisWeek.mlx) {
      lines.push(`  Requests this week: ${trend.thisWeek.mlx.requests}`);
    } else {
      lines.push('  No data available');
    }
    lines.push('  Revenue: $0.00 (no active subscribers)');

    messenger.send(lines.join('\n'));
    log('REVENUE', 'Sent weekly revenue summary');
  } catch (e) {
    log('REVENUE', `Weekly summary error: ${e.message}`);
  }
}

// ── Proactive alert scan (STATE.md changes + signal files) ──────────────────
let lastScanResults = {};
let lastSignalState = {};

function proactiveScan() {
  if (scheduler.isQuietTime()) return;

  try {
    const s = state.load();

    // 1. Scan STATE.md files for attention-needed changes
    const projects = scanner.scanAll();

    for (const project of projects) {
      if (!project.needsAttention) continue;
      if (commands.isPaused(project.name)) continue;
      if (state.wasRecentlyAlerted(s, project.name)) continue;

      const prevAttention = lastScanResults[project.name]?.needsAttention;
      if (prevAttention) continue;

      const processStatus = processMonitor.checkProjects([project.name]);
      const detail = digest.formatProjectDetail(project, processStatus[project.name]);
      messenger.send(`${project.name} needs attention:\n\n${detail}`);
      commands.setContext(project.name, "needs-attention");
      state.recordAlert(s, project.name, project.attentionReason);
      log("ALERT", `Sent alert for ${project.name}: ${project.attentionReason}`);
    }

    lastScanResults = {};
    for (const p of projects) {
      lastScanResults[p.name] = { needsAttention: p.needsAttention };
    }

    // 2. Scan signal files from managed Claude sessions
    const signals = signalProtocol.scanSignals(CONFIG.projects);

    for (const signal of signals) {
      const signalKey = `${signal.projectName}:${signal.type}`;
      if (lastSignalState[signalKey]) continue; // Already notified
      if (commands.isPaused(signal.projectName)) continue;

      const notification = signalProtocol.formatSignalNotification(signal);
      messenger.send(notification);
      commands.setContext(signal.projectName, signal.type);
      lastSignalState[signalKey] = true;
      log("SIGNAL", `${signal.type} from ${signal.projectName} (set context)`);

      // Archive the signal after notifying
      signalProtocol.clearSignal(signal.projectName, signal.type);
    }

    // Clean up cleared signals from tracking
    const activeSignalKeys = new Set(signals.map((s) => `${s.projectName}:${s.type}`));
    for (const key of Object.keys(lastSignalState)) {
      if (!activeSignalKeys.has(key)) delete lastSignalState[key];
    }

    // 3. Check for ended sessions (tmux session gone but was running)
    const sessions = sessionManager.getSessionStatuses();
    for (const session of sessions) {
      if (session.ended && !lastSignalState[`${session.projectName}:ended`]) {
        const lastOutput = session.lastOutput || "No output captured";
        messenger.send(
          `${session.projectName} session ended.\n\nLast output:\n${lastOutput}`
        );
        commands.setContext(session.projectName, "ended");
        lastSignalState[`${session.projectName}:ended`] = true;
        log("SESSION", `Session ended for ${session.projectName}`);

        // Trigger evaluation for ended session
        evaluateSession(session.projectName);
      }
    }

    s.lastScan = new Date().toISOString();
    state.save(s);
  } catch (e) {
    log("SCAN", `Error: ${e.message}`);
  }
}

// ── Session evaluation ───────────────────────────────────────────────────────
async function evaluateSession(projectName) {
  try {
    const projectDir = path.join(CONFIG.projectsDir, projectName);
    const sessionFile = path.join(projectDir, '.orchestrator', 'session.json');
    if (!fs.existsSync(sessionFile)) {
      log('EVAL', `No session.json for ${projectName}, skipping evaluation`);
      return;
    }

    const sessionData = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));

    // Skip if already evaluated (check if evaluation.json is newer than session start)
    const evalFile = path.join(projectDir, '.orchestrator', 'evaluation.json');
    if (fs.existsSync(evalFile)) {
      try {
        const existingEval = JSON.parse(fs.readFileSync(evalFile, 'utf-8'));
        if (new Date(existingEval.evaluatedAt) > new Date(sessionData.startedAt)) {
          log('EVAL', `${projectName} already evaluated, skipping`);
          return;
        }
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

    // Notify user if score is low (escalation)
    if (evaluation.score <= 2) {
      const msg = `Session ${projectName} scored ${evaluation.score}/5: ${evaluation.reasoning.substring(0, 200)}`;
      notificationManager.notify(msg, 2); // tier 2 = action needed
    }
  } catch (e) {
    log('EVAL', `Error evaluating ${projectName}: ${e.message}`);
  }
}

// ── Session timeout enforcement ──────────────────────────────────────────────
function checkSessionTimeouts() {
  const maxDurationMs = CONFIG.ai?.maxSessionDurationMs || 2700000; // 45 min default

  try {
    const sessions = sessionManager.getActiveSessions();

    for (const session of sessions) {
      const startTime = new Date(session.created).getTime();
      const duration = Date.now() - startTime;

      if (duration > maxDurationMs) {
        const durationMin = Math.round(duration / 60000);
        log("TIMEOUT", `Session ${session.projectName} exceeded ${Math.round(maxDurationMs / 60000)}min (running ${durationMin}min), stopping...`);

        // Capture last output before stopping (best-effort)
        let lastOutput = "";
        try {
          const rawOutput = require("child_process").execSync(
            `tmux capture-pane -t "${session.name}" -p 2>/dev/null | tail -5`,
            { encoding: "utf-8", timeout: 5000 }
          );
          lastOutput = rawOutput.trim().substring(0, 300);
        } catch {}

        // Stop the session
        const result = sessionManager.stopSession(session.projectName);

        // Notify via notificationManager (tier 2 = action needed)
        const notification = `Session ${session.projectName} timed out after ${durationMin}min.${lastOutput ? "\n\nLast output:\n" + lastOutput : ""}`;

        if (notificationManager) {
          notificationManager.notify(notification, 2);
        } else {
          messenger.send(notification);
        }

        log("TIMEOUT", `Stopped ${session.projectName}: ${result.message}`);

        // Trigger evaluation asynchronously (don't block timeout processing)
        evaluateSession(session.projectName);
      }
    }
  } catch (e) {
    log("TIMEOUT", `Error checking timeouts: ${e.message}`);
  }
}

// ── Message polling ─────────────────────────────────────────────────────────
let polling = false;

async function pollMessages() {
  if (polling) return;
  polling = true;

  try {
    const s = state.load();

    // First run - initialize to current position
    if (s.lastRowId === 0) {
      const latest = messenger.getLatestRowId();
      if (latest) {
        s.lastRowId = latest;
        state.save(s);
        log("INIT", `Starting from ROWID: ${s.lastRowId}`);
      }
      polling = false;
      return;
    }

    const messages = messenger.getNewMessages(s.lastRowId);

    for (const msg of messages) {
      log("MSG", `Received: "${msg.text}" (ROWID: ${msg.ROWID})`);

      const response = await commands.route(msg.text);
      const preview = response.length > 80 ? response.substring(0, 80) + "..." : response;
      log("REPLY", preview);

      messenger.send(response);

      // Wait for our sent message to land in DB, then skip past it
      await sleep(2000);
      const latest = messenger.getLatestRowId();
      s.lastRowId = latest || Math.max(s.lastRowId, msg.ROWID);
      state.save(s);
    }
  } catch (e) {
    if (
      e.message.includes("authorization denied") ||
      e.message.includes("SQLITE_CANTOPEN")
    ) {
      console.error(
        "\nCannot access Messages database!\n" +
          "Grant Full Disk Access to your terminal app:\n" +
          "  System Settings > Privacy & Security > Full Disk Access\n"
      );
      process.exit(1);
    }
    log("POLL", `Error: ${e.message}`);
  }

  polling = false;
}

// ── Startup ─────────────────────────────────────────────────────────────────
console.log("╔═══════════════════════════════════════════════╗");
console.log("║       Project Orchestrator v3.0               ║");
console.log("╠═══════════════════════════════════════════════╣");
console.log(`║  Your #:    ${CONFIG.myNumber.padEnd(33)}║`);
console.log(`║  Bot:       ${CONFIG.claudeNumber.padEnd(33)}║`);
console.log(`║  Projects:  ${String(CONFIG.projects.length).padEnd(33)}║`);
console.log(`║  Max sess:  ${String(CONFIG.maxConcurrentSessions || 5).padEnd(33)}║`);
console.log(`║  Msg poll:  ${(CONFIG.pollIntervalMs + "ms").padEnd(33)}║`);
console.log(`║  Scan:      ${(CONFIG.scanIntervalMs + "ms").padEnd(33)}║`);
console.log(`║  Quiet:     ${(CONFIG.quietHours.start + "-" + CONFIG.quietHours.end).padEnd(33)}║`);
console.log(`║  Digest:    ${CONFIG.morningDigest.cron.padEnd(33)}║`);
console.log(`║  AI:        ${(CONFIG.ai?.enabled ? "enabled (" + CONFIG.ai.autonomyLevel + ")" : "disabled").padEnd(33)}║`);
console.log(`║  Health:    ${(CONFIG.health?.enabled ? CONFIG.health.services.length + " services" : "disabled").padEnd(33)}║`);
console.log(`║  Revenue:  ${(CONFIG.revenue?.enabled ? 'enabled' : 'disabled').padEnd(33)}║`);
console.log(`║  Trust:    ${(CONFIG.trust?.enabled ? 'enabled' : 'disabled').padEnd(33)}║`);
console.log(`║  Reminders: ${(CONFIG.reminders?.enabled !== false ? 'enabled' : 'disabled').padEnd(33)}║`);
console.log("╚═══════════════════════════════════════════════╝");
console.log("");

// Run initial scan
log("BOOT", "Running initial project scan...");
const initialProjects = scanner.scanAll();
const withState = initialProjects.filter((p) => p.hasState);
const needAttention = initialProjects.filter((p) => p.needsAttention);
log("BOOT", `${initialProjects.length} projects, ${withState.length} with state, ${needAttention.length} need attention`);

for (const p of withState) {
  const pct = p.progress != null ? `${p.progress}%` : "no %";
  const status = p.status || "unknown";
  log("BOOT", `  ${p.name}: ${status} (${pct})`);
}

// Check for existing tmux sessions from a previous run
const existingSessions = sessionManager.getActiveSessions();
if (existingSessions.length > 0) {
  log("BOOT", `Found ${existingSessions.length} existing session(s):`);
  for (const s of existingSessions) {
    log("BOOT", `  ${s.projectName} (since ${s.created})`);
  }
}

// Start scheduled jobs
scheduler.startMorningDigest(sendDigest);
scheduler.startEveningDigest(sendEveningDigest);
scheduler.startWeeklySummary(sendWeeklyRevenueSummary);

// Daily trust promotion check (10 AM)
if (CONFIG.trust?.enabled) {
  const promotionJob = require('node-cron').schedule(
    CONFIG.trust.promotionCheckCron || '0 10 * * *',
    () => {
      try {
        const recommendation = trustTracker.checkPromotion();
        if (recommendation) {
          notificationManager.notify(recommendation, 2); // tier 2 = action needed
          log('TRUST', 'Promotion recommendation sent');
        }
      } catch (e) {
        log('TRUST', `Promotion check error: ${e.message}`);
      }
    },
    { timezone: CONFIG.quietHours?.timezone || 'America/New_York' }
  );
}

// Start polling loops
const msgInterval = setInterval(pollMessages, CONFIG.pollIntervalMs);
let scanCount = 0;
const scanInterval = setInterval(() => {
  scanCount++;
  proactiveScan();
  checkSessionTimeouts();
  healthMonitor.checkAll();

  // Revenue collection every N scans (default 5 = every 5 minutes)
  const collectionInterval = CONFIG.revenue?.collectionIntervalScans || 5;
  if (CONFIG.revenue?.enabled && scanCount % collectionInterval === 0) {
    revenueTracker.collect().catch(e => log('REVENUE', `Collection error: ${e.message}`));
  }

  // Trust metrics update every scan
  if (CONFIG.trust?.enabled) {
    try { trustTracker.update(); } catch (e) { log('TRUST', `Update error: ${e.message}`); }
  }

  // Reminder check every scan (fire pending reminders)
  if (CONFIG.reminders?.enabled !== false) {
    try { reminderManager.checkAndFire(); } catch (e) { log('REMINDER', `Check error: ${e.message}`); }
  }
}, CONFIG.scanIntervalMs);

// Initial poll
pollMessages();

// Do an initial proactive scan after 5 seconds (let message polling init first)
setTimeout(proactiveScan, 5000);

// ── AI Think Cycle ────────────────────────────────────────────────────────
let thinkInterval = null;
let nextThinkTimeoutMs = null;

function startThinkCycle() {
  if (thinkInterval) return;
  const defaultIntervalMs = CONFIG.ai?.thinkIntervalMs || 300000;

  function scheduleNextThink() {
    const intervalMs = nextThinkTimeoutMs || defaultIntervalMs;
    nextThinkTimeoutMs = null; // Reset override

    thinkInterval = setTimeout(async () => {
      if (!aiBrain.isEnabled()) {
        scheduleNextThink();
        return;
      }
      if (scheduler.isQuietTime()) {
        scheduleNextThink();
        return;
      }

      try {
        log("AI", "Starting think cycle...");
        const decision = await aiBrain.think();

        if (decision && decision.recommendations?.length > 0) {
          const evaluated =
            decision.evaluated ||
            decisionExecutor.evaluate(decision.recommendations);

          // Get runtime autonomy level
          const s = state.load();
          const autonomyLevel = state.getAutonomyLevel(s, CONFIG);

          if (autonomyLevel === "observe") {
            // Observe mode: SMS only (Phase 1 behavior)
            const sms = decisionExecutor.formatForSMS(
              evaluated,
              decision.summary
            );
            if (sms) {
              notificationManager.notify(sms, 3); // tier 3 = summary
            }
          } else {
            // Active mode: execute validated recommendations
            for (const rec of evaluated) {
              if (!rec.validated) continue;

              try {
                const result = await decisionExecutor.execute(rec);
                log(
                  "AI",
                  `Executed: ${rec.action} ${rec.project} -> ${result.executed ? "success" : "rejected: " + (result.rejected || result.result?.message)}`
                );
              } catch (execErr) {
                log(
                  "AI",
                  `Execution error for ${rec.project}: ${execErr.message}`
                );
              }
            }
          }

          log(
            "AI",
            `Think cycle complete: ${decision.recommendations.length} recommendations`
          );
        } else {
          log("AI", "Think cycle complete: no recommendations");
        }

        // Honor nextThinkIn if AI suggested one
        if (decision?.nextThinkIn) {
          const suggestedSeconds = parseInt(decision.nextThinkIn, 10);
          if (!isNaN(suggestedSeconds) && suggestedSeconds > 0) {
            aiBrain.setNextThinkOverride(suggestedSeconds);
            const override = aiBrain.consumeNextThinkOverride();
            if (override) {
              nextThinkTimeoutMs = override;
              log(
                "AI",
                `Next think in ${Math.round(override / 1000)}s (AI suggested)`
              );
            }
          }
        }
      } catch (e) {
        log("AI", `Think cycle error: ${e.message}`);
      }

      scheduleNextThink();
    }, intervalMs);
  }

  scheduleNextThink();
  log(
    "AI",
    `Think cycle scheduled (default ${defaultIntervalMs / 1000}s, AI may adjust)`
  );
}

startThinkCycle();

log("BOOT", "Orchestrator running. Text 'help' for commands.");

// ── Graceful shutdown ───────────────────────────────────────────────────────
function shutdown(signal) {
  log("SHUTDOWN", `Received ${signal}, stopping orchestrator...`);
  log("SHUTDOWN", "Note: Managed tmux sessions will continue running independently.");
  clearInterval(msgInterval);
  clearInterval(scanInterval);
  if (thinkInterval) clearTimeout(thinkInterval);
  notificationManager.stopBatchTimer();
  scheduler.stop();
  revenueTracker.close();
  trustTracker.close();
  reminderManager.close();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ── Terminal input ──────────────────────────────────────────────────────────
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "orch> " });
rl.prompt();
rl.on("line", async (line) => {
  const input = line.trim();
  if (!input) { rl.prompt(); return; }
  const response = await commands.route(input);
  console.log("\n" + response + "\n");
  rl.prompt();
});
rl.on("close", () => {});
