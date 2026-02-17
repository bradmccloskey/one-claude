'use strict';

const net = require('net');
const { execSync } = require('child_process');

/**
 * HealthMonitor - Checks the health of infrastructure services.
 *
 * Supports four check types:
 * - HTTP: fetch with AbortController, any response = UP
 * - TCP: net.createConnection with timeout
 * - process: launchctl list <label> to extract PID/LastExitStatus
 * - docker: docker ps --format to detect running vs stopped containers
 *
 * Results are cached in-memory. checkAll() only runs checks whose
 * intervalMs has elapsed since their last check.
 *
 * After checks, _processResults() triggers alerts and auto-restarts with safety gates:
 * - Correlated failure detection (3+ down = infrastructure event, no restarts)
 * - Autonomy gating (moderate+ required for restarts)
 * - Restart budget (2/hr sliding window)
 * - Post-restart verification (30s re-check, escalate if still down)
 * - Self-exclusion (orchestrator is never in service config)
 */
class HealthMonitor {
  /**
   * @param {Object} deps
   * @param {Object} deps.config - Parsed config.json object
   * @param {Object} [deps.notificationManager] - NotificationManager instance
   * @param {Object} [deps.state] - StateManager instance
   */
  constructor({ config, notificationManager, state }) {
    this.config = config;
    this.notificationManager = notificationManager;
    this.state = state;

    // Service registry from config
    this.services = config.health?.services || [];
    this.enabled = config.health?.enabled !== false;
    this.consecutiveFailsBeforeAlert = config.health?.consecutiveFailsBeforeAlert || 3;

    // Runtime tracking (in-memory, resets on restart)
    this._lastCheckTime = {};    // { serviceName: timestampMs }
    this._results = {};          // { serviceName: { status, latencyMs, error, consecutiveFails, lastChecked } }
    this._restartTimestamps = []; // For restart budget (used by 05-02)
  }

  /**
   * Run health checks for all services whose intervalMs has elapsed.
   * Never throws -- errors are recorded per-service as failures.
   */
  async checkAll() {
    if (!this.enabled || this.services.length === 0) return;

    const now = Date.now();
    const checkPromises = [];

    for (const service of this.services) {
      const lastCheck = this._lastCheckTime[service.name] || 0;
      if (now - lastCheck < (service.intervalMs || 60000)) continue;

      this._lastCheckTime[service.name] = now;

      // HTTP/TCP checks can run in parallel; shell commands run sequentially after
      if (service.type === 'http' || service.type === 'tcp') {
        checkPromises.push(this._checkAndRecord(service));
      } else {
        // Process and Docker checks use execSync -- run after parallel HTTP checks
        checkPromises.push(Promise.resolve({ service, deferred: true }));
      }
    }

    // Run HTTP/TCP checks in parallel
    const results = await Promise.allSettled(checkPromises);

    // Run deferred process/docker checks sequentially
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value?.deferred) {
        await this._checkAndRecord(result.value.service);
      }
    }

    // Process results for alerts and auto-restarts
    this._processResults();
  }

  /**
   * Run the check for a single service and record the result.
   * @param {Object} service - Service config object
   */
  async _checkAndRecord(service) {
    const startMs = Date.now();
    let status = 'down';
    let error = null;
    let details = null;

    try {
      switch (service.type) {
        case 'http':
          details = await this._checkHTTP(service);
          status = details.up ? 'up' : 'down';
          error = details.error || null;
          break;
        case 'tcp':
          details = await this._checkTCP(service);
          status = details.up ? 'up' : 'down';
          error = details.error || null;
          break;
        case 'process':
          details = this._checkProcess(service);
          status = details.up ? 'up' : 'down';
          error = details.error || null;
          break;
        case 'docker':
          details = this._checkDocker(service);
          status = details.up ? 'up' : 'down';
          error = details.error || null;
          break;
        default:
          error = `Unknown check type: ${service.type}`;
      }
    } catch (err) {
      error = err.message;
    }

    const latencyMs = Date.now() - startMs;
    const prev = this._results[service.name];
    const consecutiveFails = status === 'down'
      ? (prev?.consecutiveFails || 0) + 1
      : 0;

    this._results[service.name] = {
      name: service.name,
      type: service.type,
      status,
      latencyMs,
      error,
      consecutiveFails,
      lastChecked: new Date().toISOString(),
      details,
    };
  }

  /**
   * HTTP health check. ANY HTTP response (including 4xx) means UP.
   * Only connection refused, timeout, or DNS failure means DOWN.
   * @param {Object} service
   * @returns {Promise<Object>} { up, statusCode?, error? }
   */
  async _checkHTTP(service) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), service.timeoutMs || 5000);
    try {
      const response = await fetch(service.url, { signal: controller.signal });
      clearTimeout(timeoutId);
      // ANY HTTP response means the service is up (even 404)
      return { up: true, statusCode: response.status };
    } catch (err) {
      clearTimeout(timeoutId);
      const errorMsg = err.name === 'AbortError' ? 'timeout' : (err.cause?.code || err.message);
      return { up: false, error: errorMsg };
    }
  }

  /**
   * TCP health check using net.createConnection.
   * @param {Object} service
   * @returns {Promise<Object>} { up, error? }
   */
  async _checkTCP(service) {
    return new Promise((resolve) => {
      const sock = net.createConnection({ host: service.host || 'localhost', port: service.port }, () => {
        sock.destroy();
        resolve({ up: true });
      });
      sock.setTimeout(service.timeoutMs || 5000);
      sock.on('timeout', () => { sock.destroy(); resolve({ up: false, error: 'timeout' }); });
      sock.on('error', (err) => { resolve({ up: false, error: err.code || err.message }); });
    });
  }

  /**
   * Process health check via launchctl list.
   * Parses PID and LastExitStatus from output.
   * @param {Object} service
   * @returns {Object} { up, pid, exitCode, error? }
   */
  _checkProcess(service) {
    try {
      const output = execSync(`launchctl list ${service.launchdLabel}`, { encoding: 'utf-8', timeout: 3000 });
      const pidMatch = output.match(/"PID"\s*=\s*(\d+)/);
      const exitMatch = output.match(/"LastExitStatus"\s*=\s*(-?\d+)/);
      const pid = pidMatch ? parseInt(pidMatch[1]) : null;
      const exitCode = exitMatch ? parseInt(exitMatch[1]) : null;
      return { up: pid !== null, pid, exitCode };
    } catch (err) {
      return { up: false, error: err.message.substring(0, 200) };
    }
  }

  /**
   * Docker health check via docker ps.
   * Checks which containers from the service config are running.
   * @param {Object} service
   * @returns {Object} { up, total, running, downContainers, error? }
   */
  _checkDocker(service) {
    try {
      const output = execSync(
        'docker ps --format "{{.Names}}|{{.Status}}" 2>/dev/null',
        { encoding: 'utf-8', timeout: service.timeoutMs || 10000 }
      ).trim();

      const running = new Set();
      for (const line of output.split('\n')) {
        if (!line) continue;
        const [name, status] = line.split('|');
        if (status && status.startsWith('Up')) {
          running.add(name);
        }
      }

      const containers = service.containers || [];
      const downContainers = containers.filter(c => !running.has(c));
      return {
        up: downContainers.length === 0,
        total: containers.length,
        running: containers.length - downContainers.length,
        downContainers,
        error: downContainers.length > 0 ? `${downContainers.length} containers down` : null,
      };
    } catch (err) {
      return {
        up: false,
        error: err.message.substring(0, 200),
        total: (service.containers || []).length,
        running: 0,
        downContainers: service.containers || [],
      };
    }
  }

  // --- Alert Routing & Auto-Restart (Phase 05-02) ---

  /**
   * Examine all current results and trigger alerts/restarts as needed.
   * Called at the end of every checkAll() cycle.
   */
  _processResults() {
    const results = Object.values(this._results);
    const downServices = results.filter(r => r.status === 'down' && r.consecutiveFails >= this.consecutiveFailsBeforeAlert);

    // Correlated failure detection: 3+ services down simultaneously = infrastructure event
    const correlatedThreshold = this.config.health?.correlatedFailureThreshold || 3;
    if (downServices.length >= correlatedThreshold) {
      this._handleInfrastructureEvent(downServices);
      return;
    }

    // Process individual service failures
    for (const result of downServices) {
      const service = this.services.find(s => s.name === result.name);
      if (!service) continue;

      // Only alert/restart when consecutiveFails exactly equals threshold (first time crossing it)
      if (result.consecutiveFails === this.consecutiveFailsBeforeAlert) {
        this._handleServiceDown(service, result);
      }
    }
  }

  /**
   * Handle correlated failure: 3+ services down simultaneously.
   * Send tier-1 URGENT notification. Do NOT restart anything.
   * @param {Array} downServices - Array of result objects for down services
   */
  _handleInfrastructureEvent(downServices) {
    const names = downServices.map(d => d.name).join(', ');
    const msg = `INFRASTRUCTURE EVENT: ${downServices.length} services down simultaneously!\n\n` +
      `Services: ${names}\n\n` +
      `Auto-restart DISABLED (correlated failure). Manual investigation required.`;

    if (this.notificationManager) {
      this.notificationManager.notify(msg, 1); // tier 1 = URGENT
    }
    console.log(`[HEALTH] Infrastructure event: ${names}`);
  }

  /**
   * Handle a single service being down. Decide whether to alert-only or
   * alert-and-restart based on autonomy level, budget, and restartability.
   * @param {Object} service - Service config object
   * @param {Object} result - Check result object
   */
  _handleServiceDown(service, result) {
    const autonomyLevel = this._getAutonomyLevel();
    const canRestart = (autonomyLevel === 'moderate' || autonomyLevel === 'full');
    const hasRestartBudget = this._checkRestartBudget();
    const isRestartable = this._isRestartable(service);

    if (canRestart && hasRestartBudget && isRestartable) {
      // Attempt restart
      this._restartService(service, result);
    } else {
      // Alert only
      const reason = !canRestart ? `restart requires moderate+ (current: ${autonomyLevel})`
        : !hasRestartBudget ? 'restart budget exhausted'
        : 'service not restartable';

      const msg = `SERVICE DOWN: ${service.name}\n` +
        `${result.consecutiveFails} consecutive failures\n` +
        `Error: ${result.error || 'unknown'}\n\n` +
        `No auto-restart: ${reason}`;

      if (this.notificationManager) {
        this.notificationManager.notify(msg, 1); // tier 1 = URGENT
      }
      console.log(`[HEALTH] Service down (alert only): ${service.name} -- ${reason}`);
    }
  }

  /**
   * Execute a restart command for a failed service and schedule verification.
   * Docker services: `docker restart <container>` (first down container only).
   * Launchd services: `launchctl kickstart -kp gui/502/<label>`.
   * @param {Object} service - Service config object
   * @param {Object} result - Check result object
   */
  async _restartService(service, result) {
    let restartCmd = null;
    let restartType = null;

    if (service.type === 'docker' && result.details?.downContainers?.length > 0) {
      // Restart first down container only (budget-conscious)
      const container = result.details.downContainers[0];
      restartCmd = `docker restart ${container}`;
      restartType = 'docker';
    } else if (service.launchdLabel) {
      restartCmd = `launchctl kickstart -kp gui/502/${service.launchdLabel}`;
      restartType = 'launchd';
    }

    if (!restartCmd) {
      console.log(`[HEALTH] No restart command for ${service.name}`);
      return;
    }

    // Record restart in budget tracker
    this._restartTimestamps.push(Date.now());

    // Send notification about the restart
    const msg = `SERVICE DOWN: ${service.name}\n` +
      `${result.consecutiveFails} consecutive failures\n` +
      `Error: ${result.error || 'unknown'}\n\n` +
      `Action: Restarting (${restartType})...`;

    if (this.notificationManager) {
      this.notificationManager.notify(msg, 2); // tier 2 = ACTION
    }

    try {
      console.log(`[HEALTH] Restarting ${service.name}: ${restartCmd}`);
      execSync(restartCmd, { encoding: 'utf-8', timeout: 15000 });
      console.log(`[HEALTH] Restart command completed for ${service.name}`);

      // Schedule verification re-check after 30 seconds
      setTimeout(async () => {
        await this._verifyRestart(service);
      }, 30000);
    } catch (err) {
      const errMsg = `Failed to restart ${service.name}: ${err.message.substring(0, 200)}`;
      console.error(`[HEALTH] ${errMsg}`);
      if (this.notificationManager) {
        this.notificationManager.notify(errMsg, 1); // tier 1 = URGENT
      }
    }
  }

  /**
   * Re-check a service after restart. If still down, escalate to user.
   * @param {Object} service - Service config object
   */
  async _verifyRestart(service) {
    try {
      await this._checkAndRecord(service);
      const result = this._results[service.name];

      if (result?.status === 'up') {
        const msg = `SERVICE RECOVERED: ${service.name} is back up after restart.`;
        if (this.notificationManager) {
          this.notificationManager.notify(msg, 3); // tier 3 = SUMMARY
        }
        console.log(`[HEALTH] ${service.name} recovered after restart`);
      } else {
        const msg = `SERVICE STILL DOWN: ${service.name}\n` +
          `Restart did not resolve the issue. Manual investigation required.`;
        if (this.notificationManager) {
          this.notificationManager.notify(msg, 1); // tier 1 = URGENT
        }
        console.log(`[HEALTH] ${service.name} still down after restart`);
      }
    } catch (err) {
      console.error(`[HEALTH] Verify restart error for ${service.name}: ${err.message}`);
    }
  }

  /**
   * Get current autonomy level from state.
   * Returns 'observe' as safe default if state is unavailable.
   * @returns {string}
   */
  _getAutonomyLevel() {
    if (!this.state) return 'observe';
    try {
      const s = this.state.load();
      return this.state.getAutonomyLevel(s, this.config);
    } catch {
      return 'observe';
    }
  }

  /**
   * Check if the restart budget allows another restart.
   * Sliding window: max N restarts per hour.
   * @returns {boolean}
   */
  _checkRestartBudget() {
    const maxPerHour = this.config.health?.restartBudget?.maxPerHour || 2;
    const oneHourAgo = Date.now() - 3600000;
    this._restartTimestamps = this._restartTimestamps.filter(t => t > oneHourAgo);
    return this._restartTimestamps.length < maxPerHour;
  }

  /**
   * Check if we know how to restart a service.
   * @param {Object} service - Service config object
   * @returns {boolean}
   */
  _isRestartable(service) {
    // Docker services with containers are restartable
    if (service.type === 'docker' && service.containers?.length > 0) return true;
    // Services with launchdLabel are restartable
    if (service.launchdLabel) return true;
    return false;
  }

  /**
   * Returns a shallow copy of cached check results keyed by service name.
   * @returns {Object}
   */
  getLastResults() {
    return { ...this._results };
  }

  /**
   * Build a compact multi-line string for the AI context prompt.
   * Returns null when no results exist yet.
   * @returns {string|null}
   */
  formatForContext() {
    const results = Object.values(this._results);
    if (results.length === 0) return null;

    const lines = ['Service Health:'];
    for (const r of results) {
      if (r.type === 'docker') {
        lines.push(`- ${r.name}: ${r.status === 'up' ? 'UP' : 'DOWN'} (${r.details?.running || 0}/${r.details?.total || 0} containers)`);
        if (r.details?.downContainers?.length > 0) {
          lines.push(`  Down: ${r.details.downContainers.join(', ')}`);
        }
      } else if (r.type === 'process') {
        const pidInfo = r.details?.pid ? `pid ${r.details.pid}` : 'no pid';
        lines.push(`- ${r.name}: ${r.status === 'up' ? 'UP' : 'DOWN'} (${pidInfo})`);
      } else {
        const latency = r.latencyMs ? `${r.latencyMs}ms` : '?';
        const errInfo = r.error ? ` -- ${r.error}` : '';
        lines.push(`- ${r.name}: ${r.status === 'up' ? 'UP' : 'DOWN'} (${latency})${r.consecutiveFails > 0 ? ` ${r.consecutiveFails}x fail` : ''}${errInfo}`);
      }
    }

    // Restart budget info (populated by 05-02, show if tracking exists)
    const budgetMax = this.config.health?.restartBudget?.maxPerHour || 2;
    const oneHourAgo = Date.now() - 3600000;
    const recentRestarts = this._restartTimestamps.filter(t => t > oneHourAgo).length;
    lines.push(`Restart budget: ${budgetMax - recentRestarts}/${budgetMax} remaining this hour`);

    return lines.join('\n');
  }

  /**
   * Returns summary stats for external consumers.
   * @returns {Object} { total, up, down, services }
   */
  getStats() {
    const results = Object.values(this._results);
    return {
      total: results.length,
      up: results.filter(r => r.status === 'up').length,
      down: results.filter(r => r.status === 'down').length,
      services: results.map(r => ({ name: r.name, status: r.status, consecutiveFails: r.consecutiveFails })),
    };
  }
}

module.exports = HealthMonitor;
