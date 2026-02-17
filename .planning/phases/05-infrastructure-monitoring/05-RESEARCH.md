# Phase 05 Research: Infrastructure Monitoring

**Phase:** 05 - Infrastructure Monitoring
**Researched:** 2026-02-17
**Objective:** What do I need to know to PLAN this phase well?

---

## 1. Requirements Recap

| Req | Summary | Key Constraint |
|-----|---------|----------------|
| INFRA-01 | Health monitor: 8+ services, HTTP/TCP/process/Docker types, per-service intervals/timeouts, configurable registry in `config.json` | Zero new npm dependencies |
| INFRA-02 | Auto-restart: `launchctl kickstart` + `docker restart`, gated by autonomy level, restart budget (2/hr), correlated failure detection (3+ simultaneous = infrastructure event) | moderate+ only |
| INFRA-03 | MCP bridge: `claude -p --allowedTools` for GitHub/Docker/Calendar/Reminders/Memory, circuit breaker per MCP server (3 consecutive failures = 5-min backoff) | Semaphore-gated, max 2 concurrent claude -p |

---

## 2. Current Service Landscape (Verified on Machine)

### 2a. Launchd Services (User Agents)

All are user-level launch agents at `/Users/claude/Library/LaunchAgents/`. User ID is 502 (used for `launchctl kickstart gui/502/<label>`).

| Label | Port | Type | Current Status | Restart Command |
|-------|------|------|----------------|-----------------|
| `com.income-dashboard` | 8060 | HTTP | PID 20378, exit 0 | `launchctl kickstart -kp gui/502/com.income-dashboard` |
| `com.site-monitor` | 8070 | HTTP | PID 41412, exit -15 (crash loop) | `launchctl kickstart -kp gui/502/com.site-monitor` |
| `com.mlx-inference-api` | 8100 | HTTP | PID 40220, exit -15 (crash loop) | `launchctl kickstart -kp gui/502/com.mlx-inference-api` |
| `com.scraping.api` | 8002 | HTTP | PID 40229, exit 0 | `launchctl kickstart -kp gui/502/com.scraping.api` |
| `com.ttyd.ssh-terminal` | 7681 | HTTP | PID 19213, exit 0 | `launchctl kickstart -kp gui/502/com.ttyd.ssh-terminal` |
| `com.cloudflare.scraping-api` | (tunnel) | process | PID 78201, exit 0 | `launchctl kickstart -kp gui/502/com.cloudflare.scraping-api` |
| `com.xmr-miner` | (none) | process | PID 20369, exit 0 | `launchctl kickstart -kp gui/502/com.xmr-miner` |
| `com.claude.orchestrator` | (none) | process | PID 60957, exit 0 | (self -- skip) |
| `com.mlx-inference-tunnel` | (none) | process | PID 20384, exit 0 | `launchctl kickstart -kp gui/502/com.mlx-inference-tunnel` |
| `com.scraping.tunnel` | (none) | process | PID 37458, exit 0 | `launchctl kickstart -kp gui/502/com.scraping.tunnel` |
| `com.scraping.leadgen` | (none) | process | PID 53248, exit 0 | `launchctl kickstart -kp gui/502/com.scraping.leadgen` |
| `com.ttyd.pwa-proxy` | (none) | process | PID 94446, exit 0 | `launchctl kickstart -kp gui/502/com.ttyd.pwa-proxy` |
| `com.youtube-automation` | (none) | process | N/A | N/A |
| `com.youtube-ambient` | (none) | process | N/A | N/A |
| `com.crypto-trader.bot` | (none) | process | N/A | N/A |

**Key observation:** `launchctl list <label>` returns PID and LastExitStatus. PID of `-` or `0` in first column means not running. Exit status of `-15` (SIGTERM) indicates crash-loop behavior (launchd's KeepAlive restarts).

**Health check mapping for launchd process-only services (no HTTP):**
- XMR Miner: check via `launchctl list com.xmr-miner` for PID != "-"
- Cloudflare Tunnel: check via `launchctl list com.cloudflare.scraping-api` for PID != "-"
- Orchestrator: skip (self-monitoring is a footgun)

### 2b. Docker Containers

Three Docker Compose stacks are running:

**bandwidth-sharing** (10 containers, `/Users/claude/projects/passive/bandwidth-sharing/`):
- `mac-mini-m4pro_honeygain`, `mac-mini-m4pro_earnapp`, `mac-mini-m4pro_pawns`, `mac-mini-m4pro_packetstream`, `mac-mini-m4pro_proxyrack`, `mac-mini-m4pro_repocket`, `mac-mini-m4pro_mysterium`, `mac-mini-m4pro_traffmonetizer`, `mac-mini-m4pro_theta`, `mac-mini-m4pro_watchtower`

**netbox-docker** (5 containers, `/Users/claude/projects/netbox-docker/`):
- `netbox-docker-netbox-1` (port 8001), `netbox-docker-netbox-worker-1`, `netbox-docker-postgres-1`, `netbox-docker-redis-1`, `netbox-docker-redis-cache-1`

**land-speculation** (3 containers, `/Users/claude/projects/land-speculation/`):
- `land-speculation-app-1` (port 8000), `land-speculation-martin-1` (port 3000), `land-speculation-db-1` (port 5432)

**Docker restart command:** `docker restart <container_name>` (e.g., `docker restart mac-mini-m4pro_honeygain`)

**Docker health check approach:** `docker ps --format '{{.Names}}|{{.Status}}'` -- Status starts with "Up" for running, includes "(healthy)" for containers with health checks.

### 2c. Service Count Summary

- HTTP-checkable services: 5 (ports 8060, 8070, 8100, 8002, 7681)
- Process-only launchd services: 7+ (XMR, cloudflare, tunnels, etc.)
- Docker containers: 18
- Total monitorable: 30+ entities

**For INFRA-01's "8+ services" requirement:** The 5 HTTP services + XMR miner + Cloudflare tunnel + bandwidth-sharing Docker stack = well over 8.

---

## 3. Health Check Implementation Analysis

### 3a. Check Types

**HTTP checks** (native `fetch`, AbortController for timeout):
```javascript
const controller = new AbortController();
const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
const response = await fetch(url, { signal: controller.signal });
clearTimeout(timeoutId);
// Accept any 2xx/3xx/4xx as "service is running" (even 404 means process is alive)
// Only 5xx or connection refused = truly unhealthy
```

Verified working against all 5 HTTP services. Important finding: MLX API (8100) and Scraping API (8002) return 404 on `/`, not 200. The health check should accept any HTTP response (including 4xx) as "alive" -- connection refused or timeout means "down."

**TCP checks** (Node.js `net` module):
```javascript
const net = require('net');
const sock = net.createConnection({ host, port }, () => { sock.destroy(); /* UP */ });
sock.setTimeout(timeoutMs);
sock.on('timeout', () => { sock.destroy(); /* DOWN */ });
sock.on('error', () => { /* DOWN */ });
```
Useful for services that don't speak HTTP (e.g., Redis on 6379, Postgres on 5432).

**Process checks** (`launchctl list <label>`):
```javascript
const { execSync } = require('child_process');
const output = execSync(`launchctl list ${label}`, { encoding: 'utf-8', timeout: 5000 });
// Parse output: check for "PID" = <number> (not "-")
// Also check "LastExitStatus" = 0 (healthy) vs negative (crash)
```

Alternative approach -- parse `launchctl list | grep <label>` which outputs `PID\tExitStatus\tLabel`. PID column is `-` when not running.

```javascript
const output = execSync(`launchctl list ${label}`, { encoding: 'utf-8', timeout: 3000 });
const match = output.match(/"PID"\s*=\s*(\d+)/);
const pid = match ? parseInt(match[1]) : null;
const exitMatch = output.match(/"LastExitStatus"\s*=\s*(-?\d+)/);
const exitCode = exitMatch ? parseInt(exitMatch[1]) : null;
```

**Docker checks** (`docker ps`):
```javascript
const output = execSync(
  'docker ps --format "{{.Names}}|{{.Status}}" 2>/dev/null',
  { encoding: 'utf-8', timeout: 10000 }
).trim();
// Parse each line: name|Up 2 hours (healthy) or name|Exited (1) 5 minutes ago
```

### 3b. Per-Service Intervals

Not all services need the same check frequency:

| Service Type | Suggested Interval | Rationale |
|--------------|-------------------|-----------|
| HTTP endpoints | 60s | User-facing, detect quickly |
| Cloudflare tunnel | 120s | Transient reconnects are normal, don't over-alert |
| XMR miner | 300s | Not user-facing, only revenue impact |
| Docker bandwidth containers | 300s | Passive income, not urgent |
| Docker app containers (netbox, land-spec) | 120s | Semi-user-facing |

### 3c. Config Schema for Service Registry

```json
{
  "health": {
    "enabled": true,
    "services": [
      {
        "name": "income-dashboard",
        "type": "http",
        "url": "http://localhost:8060/",
        "intervalMs": 60000,
        "timeoutMs": 5000,
        "launchdLabel": "com.income-dashboard"
      },
      {
        "name": "site-monitor",
        "type": "http",
        "url": "http://localhost:8070/",
        "intervalMs": 60000,
        "timeoutMs": 5000,
        "launchdLabel": "com.site-monitor"
      },
      {
        "name": "mlx-api",
        "type": "http",
        "url": "http://localhost:8100/",
        "intervalMs": 60000,
        "timeoutMs": 5000,
        "launchdLabel": "com.mlx-inference-api"
      },
      {
        "name": "scraping-api",
        "type": "http",
        "url": "http://localhost:8002/",
        "intervalMs": 60000,
        "timeoutMs": 5000,
        "launchdLabel": "com.scraping.api"
      },
      {
        "name": "ssh-terminal",
        "type": "http",
        "url": "http://localhost:7681/",
        "intervalMs": 60000,
        "timeoutMs": 5000,
        "launchdLabel": "com.ttyd.ssh-terminal"
      },
      {
        "name": "cloudflare-tunnel",
        "type": "process",
        "launchdLabel": "com.cloudflare.scraping-api",
        "intervalMs": 120000
      },
      {
        "name": "xmr-miner",
        "type": "process",
        "launchdLabel": "com.xmr-miner",
        "intervalMs": 300000
      },
      {
        "name": "bandwidth-sharing",
        "type": "docker",
        "containers": ["mac-mini-m4pro_honeygain", "mac-mini-m4pro_earnapp", "mac-mini-m4pro_pawns", "mac-mini-m4pro_packetstream", "mac-mini-m4pro_proxyrack", "mac-mini-m4pro_repocket", "mac-mini-m4pro_mysterium", "mac-mini-m4pro_traffmonetizer", "mac-mini-m4pro_theta"],
        "intervalMs": 300000,
        "timeoutMs": 10000
      }
    ],
    "consecutiveFailsBeforeAlert": 3,
    "restartBudget": { "maxPerHour": 2 },
    "correlatedFailureThreshold": 3
  }
}
```

---

## 4. Auto-Restart Implementation Analysis (INFRA-02)

### 4a. Restart Mechanisms

**launchd services:**
```bash
launchctl kickstart -kp gui/502/<label>
```
- `-k` kills the current instance before restarting
- `-p` prints the new PID
- `gui/502/` is the user domain for UID 502

Verified working syntax. The command is synchronous -- it returns after starting the new process.

**Docker containers:**
```bash
docker restart <container_name>
```
Docker restart is also synchronous and returns the container name on success.

### 4b. Restart Safety Gates

From PITFALLS.md research and requirements:

1. **Autonomy level gate:** Only `moderate` or higher can auto-restart. At `observe`/`cautious`, send SMS notification only.

2. **Restart budget:** Max 2 restarts per hour. Track in a sliding window:
   ```javascript
   // Track restart timestamps in an array
   this._restartTimestamps = [];

   canRestart() {
     const oneHourAgo = Date.now() - 3600000;
     this._restartTimestamps = this._restartTimestamps.filter(t => t > oneHourAgo);
     return this._restartTimestamps.length < 2;
   }
   ```

3. **Correlated failure detection:** If 3+ services fail simultaneously (same check cycle), treat as infrastructure event. Do NOT restart anything. Send tier-1 URGENT notification instead.
   ```javascript
   const failures = results.filter(r => r.status === 'down');
   if (failures.length >= 3) {
     // Infrastructure event -- notify, don't restart
     return;
   }
   ```

4. **Consecutive failure threshold:** Require 3 consecutive check failures before taking action. Single failures are transient (network blip, momentary overload).

5. **Recovery verification:** After restart, wait 30-60s and re-check. If still down after restart, escalate to user -- do NOT retry restart.

6. **Self-exclusion:** Never restart `com.claude.orchestrator` (self). This is a configuration-level exclusion.

### 4c. Autonomy Matrix Extension

Current `DecisionExecutor.AUTONOMY_MATRIX` only covers: start, stop, restart, notify, skip.

Phase 05 adds a new action type: `restart_service`. The matrix needs extending:

```javascript
static AUTONOMY_MATRIX = {
  observe:  { ..., restart_service: false },
  cautious: { ..., restart_service: false },
  moderate: { ..., restart_service: true },
  full:     { ..., restart_service: true },
};
```

However, service restart is **not a decision executor action** in the same way session actions are. Service restarts are reactive (triggered by health checks) not proactive (triggered by AI think cycle). The health monitor should gate restart authority directly based on autonomy level, using `state.getAutonomyLevel()`.

**Recommendation:** Do NOT route service restarts through the decision executor. The health monitor should handle restarts directly, consulting autonomy level. The decision executor is for session management decisions made by the AI brain.

---

## 5. MCP Bridge Implementation Analysis (INFRA-03)

### 5a. Available MCP Servers

From `claude mcp list` (verified on this machine):

| Server | Status | Key Tools for Orchestrator |
|--------|--------|---------------------------|
| `github` | Connected | `mcp__github__list_pull_requests`, `mcp__github__list_issues`, `mcp__github__search_code` |
| `docker-mcp` | Connected | `mcp__docker-mcp__list-containers`, `mcp__docker-mcp__get-logs` |
| `google-calendar` | Connected | `mcp__google-calendar__list-events`, `mcp__google-calendar__get-freebusy` |
| `apple-mcp` | Connected | `mcp__apple-mcp__reminders`, `mcp__apple-mcp__calendar`, `mcp__apple-mcp__notes` |
| `memory` | Connected | `mcp__memory__create_entities`, `mcp__memory__search_nodes` |
| `playwright` | Connected | Browser automation (session use only) |
| `firecrawl` | Connected | Web scraping (session use only) |
| `filesystem` | Connected | `mcp__filesystem__read_file`, `mcp__filesystem__list_directory` |
| `apple-shortcuts` | Connected | `mcp__apple-shortcuts__run_shortcut` |
| `context7` | Connected | Library docs (session use only) |
| `glif` | Connected | AI generation (not needed) |

### 5b. --allowedTools Syntax

From `claude --help`:
```
--allowedTools, --allowed-tools <tools...>  Comma or space-separated list of tool names
```

Supports glob patterns: `"mcp__github__*"` matches all github MCP tools.

**Integration with existing `exec.js`:**

The existing `claudeP()` function already supports `allowedTools`:
```javascript
if (allowedTools && allowedTools.length > 0) {
  for (const tool of allowedTools) {
    parts.push('--allowedTools', tool);
  }
}
```

This means the MCP bridge is already partially built. We just need:
1. A higher-level `queryMCP()` function
2. Circuit breaker wrapping
3. maxTurns > 1 for MCP calls (MCP tools require the model to call the tool, get the result, then respond -- so maxTurns needs to be at least 3)

### 5c. Circuit Breaker Pattern

Per-MCP-server circuit breaker state:

```javascript
class CircuitBreaker {
  constructor(name, { failureThreshold = 3, resetTimeMs = 300000 } = {}) {
    this.name = name;
    this.failureThreshold = failureThreshold;
    this.resetTimeMs = resetTimeMs;
    this.consecutiveFailures = 0;
    this.lastFailureTime = 0;
    this.state = 'closed'; // closed = normal, open = disabled
  }

  isOpen() {
    if (this.state === 'open') {
      // Check if reset time has passed (half-open)
      if (Date.now() - this.lastFailureTime > this.resetTimeMs) {
        this.state = 'half-open';
        return false;
      }
      return true;
    }
    return false;
  }

  recordSuccess() {
    this.consecutiveFailures = 0;
    this.state = 'closed';
  }

  recordFailure() {
    this.consecutiveFailures++;
    this.lastFailureTime = Date.now();
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.state = 'open';
    }
  }
}
```

**State persistence:** Circuit breaker state should be persisted to `.state.json` (or a separate `.state-health.json`) so it survives daemon restarts. But this is an optimization -- it is acceptable for circuit breakers to reset on restart since the orchestrator uses `KeepAlive` and restarts are rare.

**MCP server grouping:** Each MCP server name maps to one circuit breaker:
- `github` -> CircuitBreaker('github')
- `docker-mcp` -> CircuitBreaker('docker-mcp')
- `google-calendar` -> CircuitBreaker('google-calendar')
- `apple-mcp` -> CircuitBreaker('apple-mcp')
- `memory` -> CircuitBreaker('memory')

### 5d. MCP Bridge Function

```javascript
async function queryMCP(prompt, tools, options = {}) {
  const { model = 'sonnet', maxTurns = 3, timeout = 60000 } = options;

  // Extract MCP server name from tool names for circuit breaker
  // e.g., "mcp__github__list_pull_requests" -> "github"
  const servers = [...new Set(tools.map(t => t.split('__')[1]))];

  // Check circuit breakers
  for (const server of servers) {
    if (circuitBreakers[server]?.isOpen()) {
      throw new Error(`MCP server '${server}' circuit breaker is open`);
    }
  }

  try {
    const result = await claudePWithSemaphore(prompt, {
      model,
      maxTurns,
      outputFormat: 'text',
      allowedTools: tools,
      timeout,
    });

    // Record success for all servers
    for (const server of servers) {
      circuitBreakers[server]?.recordSuccess();
    }

    return result;
  } catch (err) {
    // Record failure for all servers
    for (const server of servers) {
      circuitBreakers[server]?.recordFailure();
    }
    throw err;
  }
}
```

**Important consideration:** MCP calls via `claude -p` are SLOW (10-30s per call because of MCP server startup time). Every MCP call goes through the semaphore, consuming one of 2 slots. This makes MCP calls inherently low-frequency. Phase 05 should introduce the MCP bridge as a foundation -- it will be used more heavily in Phases 06-07.

---

## 6. Integration Points with Existing Codebase

### 6a. New Module: `lib/health-monitor.js`

**Constructor dependencies:**
- `config` (health service registry)
- `notificationManager` (for SMS alerts)
- `state` (for persisting health history, reading autonomy level)

**No dependency on:** scanner, sessionManager, AIBrain, decisionExecutor

**Methods:**
- `checkAll()` -- Run all due health checks (respects per-service intervals)
- `getLastResults()` -- Return cached results for context assembler
- `formatForContext()` -- Compact text for AI context
- `restartService(service)` -- Attempt restart with budget/autonomy gating
- `getStats()` -- Return health stats (up/down counts, restart budget remaining)

### 6b. New Module: `lib/mcp-bridge.js`

**Constructor dependencies:**
- `config` (MCP server list, circuit breaker settings)

**Methods:**
- `queryMCP(prompt, tools, options)` -- Execute a `claude -p --allowedTools` call
- `isServerAvailable(serverName)` -- Check circuit breaker state
- `getCircuitBreakerStates()` -- Return all breaker states for context/debugging

### 6c. Modified: `config.json`

Add `health` section with service registry (see schema in Section 3c).

### 6d. Modified: `index.js`

- Import and construct `HealthMonitor`
- Add health check interval: `setInterval(() => healthMonitor.checkAll(), healthCheckIntervalMs)`
- Wire health monitor results into context assembler
- Import and construct `MCPBridge` (may defer to Phase 07 for full usage)

### 6e. Modified: `lib/context-assembler.js`

- Accept `healthMonitor` in constructor
- Add `_buildHealthSection()` method that formats health status into AI context
- Add MCP capability list to response format section

### 6f. Modified: `lib/state.js`

- Add health history tracking (last N check results per service)
- Add restart history tracking (timestamps for budget enforcement)
- Add circuit breaker state persistence (optional, can be in-memory only)

### 6g. Modified: `test/helpers.js`

- Add `healthMonitor` mock to `createMockDeps()`

---

## 7. Architectural Decisions (Pre-Resolved)

These decisions were made in prior research (SUMMARY.md, ARCHITECTURE.md, PITFALLS.md) and STATE.md:

| Decision | Rationale |
|----------|-----------|
| Zero new npm dependencies | v4.0 constraint. Native `fetch` for HTTP, `net` for TCP, `child_process` for launchctl/docker |
| Polling over fs.watch | macOS fs.watch has known bugs (Node.js #49916, #52601). Polling is reliable. |
| Hybrid MCP: direct Node.js for simple, `claude -p --allowedTools` for complex | Health pings are simple/frequent (Node.js). GitHub PR analysis is complex/infrequent (MCP). |
| Localhost-first health checks | External URL failures could be tunnel, not service. Check localhost first. |
| Health check at ALL autonomy levels, restart at moderate+ only | Monitoring should always run. Recovery authority is earned. |
| Service restarts NOT routed through DecisionExecutor | Health restarts are reactive, not AI-deliberated. Direct autonomy check is sufficient. |
| Circuit breaker per MCP server, not per tool | Granularity of server is right -- if GitHub MCP is down, all GitHub tools are down. |

---

## 8. Risk Analysis for Phase 05

### 8a. Addressed by Design

| Risk | Mitigation in Phase 05 |
|------|----------------------|
| Alert storm on tunnel reconnect | Correlated failure detection (3+ = infrastructure event) |
| Cascade restart exhausting resources | Restart budget (2/hr), consecutive failure threshold (3) |
| MCP server hang blocking main loop | Circuit breaker (3 fails = 5-min disable), semaphore-gated |
| Self-restart loop | Exclude `com.claude.orchestrator` from health registry |
| Health check itself becoming slow | Per-check timeout (5s HTTP, 10s Docker, 3s launchctl) |

### 8b. Risks to Monitor

| Risk | Likelihood | Impact | Watch For |
|------|-----------|--------|-----------|
| `docker ps` command slow when Docker daemon is under load | Medium | Low | Check duration >10s in logs |
| launchctl kickstart requires Full Disk Access permissions | Low | High | Test on fresh boot |
| MCP server startup time in claude -p makes queryMCP too slow | High | Medium | Track duration_ms in state |
| Health check interval creates CPU overhead with 30+ checks | Low | Low | ResourceMonitor will show it |

---

## 9. Suggested Plan Decomposition

Based on the dependency analysis, Phase 05 should be split into 3-4 plans:

### Plan 05-01: Health Monitor Foundation
- Create `lib/health-monitor.js` with HTTP, TCP, process, and Docker check types
- Add `health` section to `config.json` with the 8+ service registry
- Add health check interval to `index.js`
- Add `_buildHealthSection()` to `context-assembler.js`
- Wire into startup banner and AI context
- **Test:** health-monitor.test.js (mock fetch, mock execSync, test all check types)

### Plan 05-02: Alert Routing and Auto-Restart
- Add consecutive failure tracking and correlated failure detection
- Add SMS alerting via `notificationManager.notify()` (tier 1 URGENT for down)
- Add `restartService()` method with launchctl/docker restart
- Add restart budget tracking (sliding window, 2/hr max)
- Add autonomy level gating (moderate+ for restart)
- Add recovery verification (re-check after restart)
- **Test:** restart budget, correlated failure detection, autonomy gating

### Plan 05-03: MCP Bridge with Circuit Breaker
- Create `lib/mcp-bridge.js` with `queryMCP()` and `CircuitBreaker` class
- Wire into AI brain and/or context assembler
- Add circuit breaker state tracking
- Add MCP capability awareness to context assembler
- **Test:** circuit breaker state transitions, queryMCP error handling

### Plan 05-04: Integration Tests
- End-to-end test: service goes down -> health monitor detects -> SMS sent
- End-to-end test: 3+ services fail -> correlated failure -> no restart
- End-to-end test: circuit breaker opens -> MCP call rejected -> breaker resets after timeout
- Add healthMonitor mock to test helpers

---

## 10. Key Implementation Details

### 10a. Health Monitor Timer Architecture

Each service has its own check interval. Rather than running N timers, use a single timer at the GCD of all intervals and check which services are due:

```javascript
// In checkAll(), only check services whose interval has elapsed
const now = Date.now();
for (const service of this.services) {
  const lastCheck = this._lastCheckTime[service.name] || 0;
  if (now - lastCheck >= service.intervalMs) {
    await this._checkService(service);
    this._lastCheckTime[service.name] = now;
  }
}
```

The main interval in `index.js` can be 30s or 60s (the smallest service interval), and each service's own `intervalMs` controls its actual frequency.

### 10b. HTTP Check Semantics

A service is "up" if it responds to HTTP at all (any status code). A service is "down" only if:
- Connection refused (ECONNREFUSED)
- Timeout (AbortError after 5s)
- DNS resolution failure

4xx responses (like MLX API's 404 on `/`) mean the process is running and accepting connections. Only connection-level failures indicate a service is truly down.

### 10c. Notification Format

```
SERVICE DOWN: mlx-api
3 consecutive failures (last check: 2m ago)
Port 8100 - connection refused

Autonomy: moderate
Action: Restarting com.mlx-inference-api...
```

vs. at observe/cautious:

```
SERVICE DOWN: mlx-api
3 consecutive failures (last check: 2m ago)
Port 8100 - connection refused

Autonomy: observe (restart requires moderate+)
```

### 10d. Health Context for AI Brain

```
Service Health:
- income-dashboard: UP (120ms) [8060]
- site-monitor: DOWN 3x (ECONNREFUSED) [8070] -- launchd exit -15
- mlx-api: UP (45ms) [8100]
- scraping-api: UP (200ms) [8002]
- ssh-terminal: UP (15ms) [7681]
- cloudflare-tunnel: UP (pid 78201)
- xmr-miner: UP (pid 20369)
- Docker: 18/18 containers running
Restart budget: 2/2 remaining this hour
```

---

## 11. Open Questions (Resolve During Planning)

1. **Should health results persist to `.state.json` or a separate file?** STATE.md prefers splitting. Recommend `.state-health.json` for health history and circuit breaker state.

2. **Should the health monitor run checks in parallel or sequentially?** Parallel is faster (all HTTP checks fire at once with Promise.all), sequential is simpler. Recommend parallel for HTTP checks, sequential for shell commands (launchctl, docker).

3. **How many consecutive failures for Docker container restart vs. launchd restart?** Suggest same threshold (3) for both, but Docker containers with built-in healthchecks that report unhealthy should count as failures too.

4. **Should the MCP bridge be a standalone module or a method on AIBrain?** Recommend standalone `lib/mcp-bridge.js` -- it is reused by multiple callers (AI brain think cycle, natural language commands, future personal assistant features).

5. **Should MCP bridge queryMCP return structured JSON or raw text?** Recommend supporting both via options parameter -- JSON schema for structured responses, text for freeform. The existing `claudeP()` options already support this.

---

## 12. Dependencies and Constraints Summary

**Depends on (from Phase 03-04):**
- `lib/exec.js`: `claudeP()`, `claudePWithSemaphore()`, `ClaudeSemaphore` -- used by MCP bridge
- `lib/state.js`: `StateManager` -- used for health history, autonomy level checks
- `lib/notification-manager.js`: `NotificationManager` -- used for alert routing
- `lib/context-assembler.js`: `ContextAssembler` -- extended with health section
- `config.json` structure: extended with `health` section
- `test/helpers.js`: extended with healthMonitor mock

**Does NOT depend on:**
- `lib/session-manager.js` (service health is separate from session management)
- `lib/ai-brain.js` (health checks don't need AI deliberation)
- `lib/decision-executor.js` (service restarts bypass decision executor)
- `lib/scanner.js` (project scanning is unrelated to service health)

**Constraint: Zero new npm dependencies.** All health checks use Node.js built-ins:
- `fetch` (global, Node 25.6.1) for HTTP
- `net` (built-in) for TCP
- `child_process.execSync` (built-in) for launchctl/docker CLI
- `AbortController` (global) for timeouts
