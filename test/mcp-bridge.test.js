'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { MCPBridge, CircuitBreaker } = require('../lib/mcp-bridge');

describe('CircuitBreaker', () => {
  it('starts in closed state', () => {
    const cb = new CircuitBreaker('test');
    assert.equal(cb.state, 'closed');
    assert.equal(cb.isOpen(), false);
    assert.equal(cb.consecutiveFailures, 0);
  });

  it('stays closed after fewer than threshold failures', () => {
    const cb = new CircuitBreaker('test', { failureThreshold: 3 });
    cb.recordFailure();
    cb.recordFailure();
    assert.equal(cb.isOpen(), false);
    assert.equal(cb.state, 'closed');
    assert.equal(cb.consecutiveFailures, 2);
  });

  it('opens after threshold consecutive failures', () => {
    const cb = new CircuitBreaker('test', { failureThreshold: 3 });
    cb.recordFailure();
    cb.recordFailure();
    assert.equal(cb.isOpen(), false); // Only 2 failures
    cb.recordFailure();
    assert.equal(cb.isOpen(), true); // 3 failures = open
    assert.equal(cb.state, 'open');
  });

  it('rejects calls when open', () => {
    const cb = new CircuitBreaker('test', { failureThreshold: 1 });
    cb.recordFailure();
    assert.equal(cb.isOpen(), true);
    // Repeated calls should still show open
    assert.equal(cb.isOpen(), true);
    assert.equal(cb.state, 'open');
  });

  it('transitions to half-open after reset time', () => {
    const cb = new CircuitBreaker('test', { failureThreshold: 1, resetTimeMs: 100 });
    cb.recordFailure();
    assert.equal(cb.isOpen(), true);

    // Simulate time passing by backdating lastFailureTime
    cb.lastFailureTime = Date.now() - 200;
    assert.equal(cb.isOpen(), false); // Should be half-open now
    assert.equal(cb.state, 'half-open');
  });

  it('closes again after success in half-open state', () => {
    const cb = new CircuitBreaker('test', { failureThreshold: 1, resetTimeMs: 100 });
    cb.recordFailure();
    cb.lastFailureTime = Date.now() - 200;
    cb.isOpen(); // Trigger transition to half-open
    assert.equal(cb.state, 'half-open');

    cb.recordSuccess();
    assert.equal(cb.state, 'closed');
    assert.equal(cb.consecutiveFailures, 0);
  });

  it('re-opens after failure in half-open state', () => {
    const cb = new CircuitBreaker('test', { failureThreshold: 1, resetTimeMs: 100 });
    cb.recordFailure();
    cb.lastFailureTime = Date.now() - 200;
    cb.isOpen(); // Trigger half-open
    assert.equal(cb.state, 'half-open');

    // A single failure in half-open should re-open (threshold is 1)
    cb.recordFailure();
    assert.equal(cb.state, 'open');
    assert.equal(cb.isOpen(), true);
  });

  it('resets failure count on success', () => {
    const cb = new CircuitBreaker('test', { failureThreshold: 5 });
    cb.recordFailure();
    cb.recordFailure();
    assert.equal(cb.consecutiveFailures, 2);

    cb.recordSuccess();
    assert.equal(cb.consecutiveFailures, 0);
    assert.equal(cb.state, 'closed');
  });

  it('getState returns correct state object', () => {
    const cb = new CircuitBreaker('github', { failureThreshold: 3 });
    cb.recordFailure();
    cb.recordFailure();

    const state = cb.getState();
    assert.equal(state.name, 'github');
    assert.equal(state.state, 'closed');
    assert.equal(state.consecutiveFailures, 2);
    assert.ok(state.lastFailureTime > 0);
  });
});

describe('MCPBridge', () => {
  // Preserve exec module state for cleanup
  const execModule = require('../lib/exec');
  let origClaudePWithSemaphore;

  afterEach(() => {
    // Restore exec module if patched
    if (origClaudePWithSemaphore) {
      execModule.claudePWithSemaphore = origClaudePWithSemaphore;
      origClaudePWithSemaphore = null;
    }
  });

  describe('constructor', () => {
    it('creates circuit breakers for all known servers', () => {
      const mb = new MCPBridge();
      const states = mb.getCircuitBreakerStates();
      const serverNames = Object.keys(states);

      assert.ok(serverNames.length > 0);
      assert.ok(serverNames.includes('github'));
      assert.ok(serverNames.includes('docker-mcp'));
      assert.ok(serverNames.includes('filesystem'));

      // All should start closed
      for (const state of Object.values(states)) {
        assert.equal(state.state, 'closed');
        assert.equal(state.consecutiveFailures, 0);
      }
    });

    it('accepts custom failure threshold', () => {
      const mb = new MCPBridge({ failureThreshold: 5 });
      const breaker = mb._breakers['github'];
      assert.equal(breaker.failureThreshold, 5);
    });
  });

  describe('isServerAvailable', () => {
    it('returns true for healthy servers', () => {
      const mb = new MCPBridge();
      assert.equal(mb.isServerAvailable('github'), true);
      assert.equal(mb.isServerAvailable('docker-mcp'), true);
    });

    it('returns false when circuit breaker is open', () => {
      const mb = new MCPBridge({ failureThreshold: 1 });
      mb._breakers['github'].recordFailure();
      assert.equal(mb.isServerAvailable('github'), false);
    });

    it('returns true for unknown server names', () => {
      const mb = new MCPBridge();
      assert.equal(mb.isServerAvailable('nonexistent-server'), true);
    });
  });

  describe('queryMCP', () => {
    it('rejects immediately when circuit breaker is open', async () => {
      const mb = new MCPBridge({ failureThreshold: 1 });
      // Open the github breaker
      mb._breakers['github'].recordFailure();
      assert.equal(mb._breakers['github'].isOpen(), true);

      await assert.rejects(
        () => mb.queryMCP('test prompt', ['mcp__github__list_issues']),
        /circuit breaker is open/
      );
    });

    it('calls claudePWithSemaphore with correct options', async () => {
      origClaudePWithSemaphore = execModule.claudePWithSemaphore;

      let capturedArgs = null;
      execModule.claudePWithSemaphore = async (prompt, options) => {
        capturedArgs = { prompt, options };
        return 'mock response';
      };

      const mb = new MCPBridge();
      const result = await mb.queryMCP('test prompt', ['mcp__github__list_issues'], { maxTurns: 5 });

      assert.equal(result, 'mock response');
      assert.equal(capturedArgs.prompt, 'test prompt');
      assert.deepEqual(capturedArgs.options.allowedTools, ['mcp__github__list_issues']);
      assert.equal(capturedArgs.options.maxTurns, 5);
    });

    it('records success on all involved servers', async () => {
      origClaudePWithSemaphore = execModule.claudePWithSemaphore;
      execModule.claudePWithSemaphore = async () => 'ok';

      const mb = new MCPBridge({ failureThreshold: 3 });
      // Add some failures first
      mb._breakers['github'].recordFailure();
      mb._breakers['github'].recordFailure();
      assert.equal(mb._breakers['github'].consecutiveFailures, 2);

      await mb.queryMCP('test', ['mcp__github__list_issues']);

      // Success should have reset failures
      assert.equal(mb._breakers['github'].consecutiveFailures, 0);
      assert.equal(mb._breakers['github'].state, 'closed');
    });

    it('records failure on all involved servers when call fails', async () => {
      origClaudePWithSemaphore = execModule.claudePWithSemaphore;
      execModule.claudePWithSemaphore = async () => {
        throw new Error('LLM unavailable');
      };

      const mb = new MCPBridge({ failureThreshold: 5 });

      await assert.rejects(
        () => mb.queryMCP('test', ['mcp__github__list_issues']),
        /LLM unavailable/
      );

      assert.equal(mb._breakers['github'].consecutiveFailures, 1);
    });
  });

  describe('_extractServerNames', () => {
    it('extracts server name from full tool name', () => {
      const mb = new MCPBridge();
      const servers = mb._extractServerNames(['mcp__github__list_pull_requests']);
      assert.deepEqual(servers, ['github']);
    });

    it('extracts server name from glob pattern', () => {
      const mb = new MCPBridge();
      const servers = mb._extractServerNames(['mcp__docker-mcp__*']);
      assert.deepEqual(servers, ['docker-mcp']);
    });

    it('deduplicates server names', () => {
      const mb = new MCPBridge();
      const servers = mb._extractServerNames([
        'mcp__github__list_issues',
        'mcp__github__list_pull_requests',
      ]);
      assert.deepEqual(servers, ['github']);
    });

    it('handles non-MCP tool names gracefully', () => {
      const mb = new MCPBridge();
      const servers = mb._extractServerNames(['Bash', 'Read', 'Write']);
      assert.deepEqual(servers, []);
    });

    it('handles mixed MCP and non-MCP tool names', () => {
      const mb = new MCPBridge();
      const servers = mb._extractServerNames([
        'mcp__github__list_issues',
        'Bash',
        'mcp__docker-mcp__list_containers',
      ]);
      assert.deepEqual(servers.sort(), ['docker-mcp', 'github']);
    });
  });

  describe('formatForContext', () => {
    it('lists all known MCP servers', () => {
      const mb = new MCPBridge();
      const output = mb.formatForContext();

      assert.ok(output.includes('MCP Capabilities'));
      assert.ok(output.includes('github'));
      assert.ok(output.includes('docker-mcp'));
      assert.ok(output.includes('filesystem'));
      assert.ok(output.includes('available'));
    });

    it('shows DISABLED for servers with open circuit breakers', () => {
      const mb = new MCPBridge({ failureThreshold: 1 });
      mb._breakers['github'].recordFailure();

      const output = mb.formatForContext();
      assert.ok(output.includes('github'));
      assert.ok(output.includes('DISABLED'));
      // Other servers should still be available
      assert.ok(output.includes('filesystem'));
    });
  });

  describe('getCircuitBreakerStates', () => {
    it('returns state for all known servers', () => {
      const mb = new MCPBridge();
      const states = mb.getCircuitBreakerStates();

      assert.equal(Object.keys(states).length, MCPBridge.KNOWN_SERVERS.length);
      for (const server of MCPBridge.KNOWN_SERVERS) {
        assert.ok(states[server.name], `should have state for ${server.name}`);
        assert.equal(states[server.name].name, server.name);
        assert.equal(states[server.name].state, 'closed');
      }
    });

    it('reflects failures in state', () => {
      const mb = new MCPBridge({ failureThreshold: 3 });
      mb._breakers['github'].recordFailure();
      mb._breakers['github'].recordFailure();
      mb._breakers['github'].recordFailure();

      const states = mb.getCircuitBreakerStates();
      assert.equal(states['github'].state, 'open');
      assert.equal(states['github'].consecutiveFailures, 3);
      assert.equal(states['docker-mcp'].state, 'closed');
    });
  });
});
