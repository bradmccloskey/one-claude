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

// ── Notifications ────────────────────────────────────────────────────────────
const notificationManager = new NotificationManager({
  messenger,
  config: CONFIG,
  scheduler,
});
notificationManager.startBatchTimer();

// ── AI Brain (v3.0) ─────────────────────────────────────────────────────────
const contextAssembler = new ContextAssembler({
  scanner,
  sessionManager,
  processMonitor,
  state,
  config: CONFIG,
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
      }
    }

    s.lastScan = new Date().toISOString();
    state.save(s);
  } catch (e) {
    log("SCAN", `Error: ${e.message}`);
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

// Start polling loops
const msgInterval = setInterval(pollMessages, CONFIG.pollIntervalMs);
const scanInterval = setInterval(() => {
  proactiveScan();
  checkSessionTimeouts();
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
