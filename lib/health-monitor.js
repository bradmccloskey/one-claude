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
 * Alert routing and auto-restart are NOT implemented here (see 05-02).
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
