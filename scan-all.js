#!/usr/bin/env node
const Scanner = require("./lib/scanner");
const config = require("./config.json");
const scanner = new Scanner(config.projectsDir, config.projects);
const projects = scanner.scanAll();
for (const p of projects) {
  if (p.exists === false) continue;
  let state = "no state";
  if (p.hasState) {
    state = p.progress !== null
      ? `${p.status} (${p.progress}%)`
      : (p.status || "has state");
  }
  const attn = p.needsAttention ? ` ** NEEDS ATTENTION: ${p.attentionReason}` : "";
  console.log(`${p.name} | ${state}${attn}`);
}
