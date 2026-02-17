'use strict';

/**
 * CircuitBreaker - Tracks per-MCP-server failure state.
 *
 * States:
 * - closed: Normal operation, calls pass through
 * - open: Disabled after consecutive failures, calls rejected immediately
 * - half-open: Cooldown elapsed, one probe call allowed to test recovery
 */
class CircuitBreaker {
  /**
   * @param {string} name - MCP server name (e.g., 'github', 'docker-mcp')
   * @param {Object} [options]
   * @param {number} [options.failureThreshold=3] - Consecutive failures before opening
   * @param {number} [options.resetTimeMs=300000] - Time before half-open (5 minutes)
   */
  constructor(name, { failureThreshold = 3, resetTimeMs = 300000 } = {}) {
    this.name = name;
    this.failureThreshold = failureThreshold;
    this.resetTimeMs = resetTimeMs;
    this.consecutiveFailures = 0;
    this.lastFailureTime = 0;
    this.state = 'closed'; // closed | open | half-open
  }

  /**
   * Check if the circuit breaker is open (blocking calls).
   * Automatically transitions to half-open when reset time has passed.
   * @returns {boolean} True if open (calls should be blocked)
   */
  isOpen() {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailureTime > this.resetTimeMs) {
        this.state = 'half-open';
        return false; // Allow one probe call
      }
      return true;
    }
    return false;
  }

  /**
   * Record a successful call. Resets failure count and closes the breaker.
   */
  recordSuccess() {
    this.consecutiveFailures = 0;
    this.state = 'closed';
  }

  /**
   * Record a failed call. Increments failure count. Opens breaker at threshold.
   */
  recordFailure() {
    this.consecutiveFailures++;
    this.lastFailureTime = Date.now();
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.state = 'open';
    }
  }

  /**
   * Get current state for debugging/context.
   * @returns {{ name: string, state: string, consecutiveFailures: number, lastFailureTime: number }}
   */
  getState() {
    return {
      name: this.name,
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      lastFailureTime: this.lastFailureTime,
    };
  }
}

/**
 * MCPBridge - Enables external tool access via `claude -p --allowedTools`
 * with per-server circuit breaker protection.
 *
 * Each MCP call goes through claudePWithSemaphore (semaphore-gated)
 * and is protected by a CircuitBreaker per MCP server name.
 */
class MCPBridge {
  /**
   * Known MCP servers available on this machine.
   * Used for circuit breaker initialization and capability reporting.
   */
  static KNOWN_SERVERS = [
    { name: 'github', description: 'GitHub repos, PRs, issues', toolPrefix: 'mcp__github__' },
    { name: 'docker-mcp', description: 'Docker containers, logs', toolPrefix: 'mcp__docker-mcp__' },
    { name: 'google-calendar', description: 'Google Calendar events', toolPrefix: 'mcp__google-calendar__' },
    { name: 'apple-mcp', description: 'Reminders, Notes, Calendar', toolPrefix: 'mcp__apple-mcp__' },
    { name: 'memory', description: 'Knowledge graph memory', toolPrefix: 'mcp__memory__' },
    { name: 'filesystem', description: 'File read/write/search', toolPrefix: 'mcp__filesystem__' },
  ];

  /**
   * @param {Object} [options]
   * @param {number} [options.failureThreshold=3] - Circuit breaker failure threshold
   * @param {number} [options.resetTimeMs=300000] - Circuit breaker reset time (5 min)
   */
  constructor(options = {}) {
    const { failureThreshold = 3, resetTimeMs = 300000 } = options;

    // Create a circuit breaker for each known MCP server
    this._breakers = {};
    for (const server of MCPBridge.KNOWN_SERVERS) {
      this._breakers[server.name] = new CircuitBreaker(server.name, {
        failureThreshold,
        resetTimeMs,
      });
    }
  }

  /**
   * Execute a prompt with MCP tool access via claude -p --allowedTools.
   *
   * @param {string} prompt - The prompt text
   * @param {string[]} tools - MCP tool names or glob patterns (e.g., ["mcp__github__*"])
   * @param {Object} [options]
   * @param {string} [options.model='sonnet'] - Model to use
   * @param {number} [options.maxTurns=3] - Must be >= 3 for MCP (tool call + result + response)
   * @param {number} [options.timeout=60000] - Timeout in ms
   * @param {string} [options.outputFormat='text'] - Output format
   * @param {string} [options.jsonSchema] - Optional JSON schema for structured output
   * @returns {Promise<string>} The response text
   * @throws {Error} If circuit breaker is open or MCP call fails
   */
  async queryMCP(prompt, tools, options = {}) {
    const {
      model = 'sonnet',
      maxTurns = 3,
      timeout = 60000,
      outputFormat = 'text',
      jsonSchema = null,
    } = options;

    // Extract MCP server names from tool names for circuit breaker routing
    const servers = this._extractServerNames(tools);

    // Check circuit breakers BEFORE consuming a semaphore slot
    for (const server of servers) {
      const breaker = this._breakers[server];
      if (breaker && breaker.isOpen()) {
        const remainingSec = Math.round(
          (breaker.resetTimeMs - (Date.now() - breaker.lastFailureTime)) / 1000
        );
        throw new Error(
          `MCP server '${server}' circuit breaker is open (${breaker.consecutiveFailures} consecutive failures, resets in ${remainingSec}s)`
        );
      }
    }

    const { claudePWithSemaphore } = require('./exec');

    try {
      const result = await claudePWithSemaphore(prompt, {
        model,
        maxTurns,
        outputFormat: jsonSchema ? 'json' : outputFormat,
        jsonSchema,
        timeout,
        allowedTools: tools,
      });

      // Record success for all involved servers
      for (const server of servers) {
        this._breakers[server]?.recordSuccess();
      }

      return result;
    } catch (err) {
      // Record failure for all involved servers
      for (const server of servers) {
        this._breakers[server]?.recordFailure();
      }
      throw err;
    }
  }

  /**
   * Check if a specific MCP server is available (circuit breaker not open).
   * @param {string} serverName - MCP server name (e.g., 'github')
   * @returns {boolean}
   */
  isServerAvailable(serverName) {
    const breaker = this._breakers[serverName];
    if (!breaker) return true; // Unknown servers are assumed available
    return !breaker.isOpen();
  }

  /**
   * Get all circuit breaker states for debugging/context.
   * @returns {Object} Map of server name -> breaker state
   */
  getCircuitBreakerStates() {
    const states = {};
    for (const [name, breaker] of Object.entries(this._breakers)) {
      states[name] = breaker.getState();
    }
    return states;
  }

  /**
   * Format MCP capability info for AI context.
   * Shows available MCP servers and any that are circuit-broken.
   * @returns {string}
   */
  formatForContext() {
    const lines = ['MCP Capabilities (via claude -p --allowedTools):'];
    for (const server of MCPBridge.KNOWN_SERVERS) {
      const breaker = this._breakers[server.name];
      const available = breaker ? !breaker.isOpen() : true;
      const status = available ? 'available' : `DISABLED (${breaker.consecutiveFailures} failures)`;
      lines.push(`- ${server.name}: ${server.description} [${status}]`);
    }
    return lines.join('\n');
  }

  /**
   * Extract MCP server names from tool name patterns.
   * @param {string[]} tools - Tool names or glob patterns
   * @returns {string[]} Unique server names
   * @private
   */
  _extractServerNames(tools) {
    const servers = new Set();
    for (const tool of tools) {
      // Pattern: mcp__<server>__<toolname> or mcp__<server>__*
      const parts = tool.split('__');
      if (parts.length >= 2 && parts[0] === 'mcp') {
        servers.add(parts[1]);
      }
    }
    return [...servers];
  }
}

module.exports = { MCPBridge, CircuitBreaker };
