#!/usr/bin/env node
/**
 * Spin up all projects one at a time, let them assess status,
 * and report which ones need human attention.
 */
const config = require("./config.json");
const SessionManager = require("./lib/session-manager");
const { SignalProtocol } = require("./lib/signal-protocol");
const Scanner = require("./lib/scanner");
const fs = require("fs");
const path = require("path");

const sm = new SessionManager(config);
const sp = new SignalProtocol(config.projectsDir);
const scanner = new Scanner(config.projectsDir, config.projects);

const CHECK_PROMPT =
  "Review this project quickly. Check the current state: read README, recent git log (last 5 commits), " +
  "any .planning/STATE.md or .planning/PROJECT.md, and the overall code state. " +
  "Then write ONE of these signal files and stop:\n" +
  "- .orchestrator/needs-input.json if the project needs human decisions\n" +
  "- .orchestrator/completed.json if everything looks good/complete\n" +
  "- .orchestrator/error.json if something is broken\n" +
  "Example: Write '{\"question\":\"...\",\"timestamp\":\"...\"}' to .orchestrator/needs-input.json\n" +
  "Be quick — just assess and signal, don't start any actual work.";

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function launchAndWait(name) {
  sp.injectClaudeMd(name);
  const result = sm.startSession(name, CHECK_PROMPT);
  if (!result.success) {
    console.log(`  ${name}: ${result.message}`);
    return { name, type: "skip", data: { summary: result.message } };
  }
  console.log(`  ${name}: launched, waiting for signal...`);

  // Wait up to 2.5 min for signal
  const signalDir = path.join(config.projectsDir, name, ".orchestrator");
  for (let i = 0; i < 10; i++) {
    await sleep(15000);
    for (const type of ["needs-input", "completed", "error"]) {
      const file = path.join(signalDir, `${type}.json`);
      if (fs.existsSync(file)) {
        try {
          const data = JSON.parse(fs.readFileSync(file, "utf-8"));
          console.log(`  ${name}: signaled ${type}`);
          sm.stopSession(name);
          return { name, type, data };
        } catch {}
      }
    }
    // Check if session died
    try {
      require("child_process").execSync(`tmux has-session -t "orch-${name}" 2>/dev/null`, { timeout: 3000 });
    } catch {
      console.log(`  ${name}: session ended`);
      return { name, type: "ended", data: { summary: "Session ended" } };
    }
    console.log(`  ${name}: still working (${(i+1)*15}s)...`);
  }

  // Timeout - stop it
  console.log(`  ${name}: timed out`);
  sm.stopSession(name);
  return { name, type: "timeout", data: { summary: "Still working after 2.5 min" } };
}

async function main() {
  const allProjects = scanner.scanAll().filter(p => p.exists !== false);

  // Categorize
  const complete = [];
  const toCheck = [];

  for (const p of allProjects) {
    if (p.hasState && p.progress === 100 && p.status && p.status.toLowerCase().includes("complete")) {
      complete.push(p);
    } else {
      toCheck.push(p);
    }
  }

  console.log(`\n=== Project Check-All ===`);
  console.log(`Skipping (complete): ${complete.map(p=>p.name).join(", ") || "none"}`);
  console.log(`Checking: ${toCheck.map(p=>p.name).join(", ")}`);
  console.log(`(launching 3 at a time with 8s startup delay)\n`);

  const results = [];

  // Launch in batches of 3
  for (let i = 0; i < toCheck.length; i += 3) {
    const batch = toCheck.slice(i, i + 3);
    console.log(`--- Batch ${Math.floor(i/3)+1}: ${batch.map(p=>p.name).join(", ")} ---`);

    const promises = batch.map(p => launchAndWait(p.name));
    const batchResults = await Promise.all(promises);
    results.push(...batchResults);
    console.log();
  }

  // Final report
  console.log(`\n========== FINAL REPORT ==========\n`);

  const needsAttention = [];
  const allGood = [];
  const unknown = [];

  for (const r of results) {
    switch (r.type) {
      case "needs-input":
        needsAttention.push({ name: r.name, reason: r.data.question || "needs input" });
        break;
      case "error":
        needsAttention.push({ name: r.name, reason: `ERROR: ${r.data.error || "unknown"}` });
        break;
      case "completed":
        allGood.push({ name: r.name, summary: r.data.summary || "looks good" });
        break;
      default:
        unknown.push({ name: r.name, note: r.data.summary || r.type });
    }
  }

  for (const p of complete) {
    allGood.push({ name: p.name, summary: "Already complete (100%)" });
  }

  if (needsAttention.length > 0) {
    console.log("NEEDS YOUR ATTENTION:");
    for (const p of needsAttention) console.log(`  * ${p.name}: ${p.reason}`);
    console.log();
  }

  if (unknown.length > 0) {
    console.log("COULDN'T DETERMINE (timed out or ended):");
    for (const p of unknown) console.log(`  ? ${p.name}: ${p.note}`);
    console.log();
  }

  if (allGood.length > 0) {
    console.log("ALL GOOD:");
    for (const p of allGood) console.log(`  - ${p.name}: ${p.summary}`);
    console.log();
  }

  console.log("=================================");
}

main().catch(console.error);
