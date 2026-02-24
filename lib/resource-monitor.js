'use strict';

const os = require('os');
const { execSync } = require('child_process');

/**
 * ResourceMonitor - System resource data collection.
 *
 * Collects CPU load, memory, disk usage, and uptime using Node.js os module
 * and df command. Provides a compact text format suitable for AI prompt context.
 * No constructor dependencies needed -- stateless.
 */
class ResourceMonitor {
  /**
   * Get a snapshot of current system resource usage.
   *
   * @returns {{ cpuLoadAvg1m: number, cpuLoadAvg5m: number, cpuCount: number, freeMemMB: number, totalMemMB: number, memUsedPct: number, diskUsedPct: number|null, uptimeHours: number }}
   */
  getSnapshot() {
    const loadAvg = os.loadavg();
    const totalMem = os.totalmem();

    // On macOS, os.freemem() only reports "free" pages, ignoring inactive/purgeable
    // memory that's reclaimable. Use vm_stat to get a realistic "available" figure.
    let availableMemBytes = os.freemem(); // fallback
    try {
      const vmstat = execSync('vm_stat', { encoding: 'utf-8', timeout: 3000 });
      const pageSize = 16384; // macOS ARM page size
      const parse = (label) => {
        const m = vmstat.match(new RegExp(`${label}:\\s+(\\d+)`));
        return m ? parseInt(m[1], 10) * pageSize : 0;
      };
      const free = parse('Pages free');
      const inactive = parse('Pages inactive');
      const purgeable = parse('Pages purgeable');
      availableMemBytes = free + inactive + purgeable;
    } catch {
      // vm_stat failed -- fall back to os.freemem()
    }

    // Disk usage -- wrap in try/catch, return null on failure
    let diskUsedPct = null;
    try {
      const dfOutput = execSync('df -k / | tail -1', {
        encoding: 'utf-8',
        timeout: 3000,
      }).trim();
      const parts = dfOutput.split(/\s+/);
      // 5th field is usage percentage with '%' suffix (e.g., "45%")
      diskUsedPct = parseInt(parts[4], 10) || null;
    } catch {
      // df command failed -- leave as null
    }

    return {
      cpuLoadAvg1m: loadAvg[0],
      cpuLoadAvg5m: loadAvg[1],
      cpuCount: os.cpus().length,
      freeMemMB: Math.round(availableMemBytes / 1024 / 1024),
      totalMemMB: Math.round(totalMem / 1024 / 1024),
      memUsedPct: Math.round((1 - availableMemBytes / totalMem) * 100),
      diskUsedPct,
      uptimeHours: Math.round(os.uptime() / 3600),
    };
  }

  /**
   * Format a resource snapshot as a single compact line for AI context.
   *
   * @param {{ cpuLoadAvg1m: number, cpuCount: number, freeMemMB: number, totalMemMB: number, memUsedPct: number, diskUsedPct: number|null, uptimeHours: number }} snapshot
   * @returns {string} Compact single-line summary
   */
  formatForContext(snapshot) {
    const diskPart = snapshot.diskUsedPct != null
      ? `Disk ${snapshot.diskUsedPct}% used`
      : 'Disk N/A';

    return (
      `System: CPU ${snapshot.cpuLoadAvg1m.toFixed(1)}/${snapshot.cpuCount} cores | ` +
      `RAM ${snapshot.freeMemMB}MB free/${snapshot.totalMemMB}MB (${snapshot.memUsedPct}% used) | ` +
      `${diskPart} | ` +
      `Uptime ${snapshot.uptimeHours}h`
    );
  }
}

module.exports = ResourceMonitor;
