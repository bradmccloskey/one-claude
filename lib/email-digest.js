'use strict';

const nodemailer = require('nodemailer');
const path = require('node:path');
const fs = require('node:fs');

const FROM_EMAIL = 'miniclaude_mccloskey@icloud.com';
const FROM_NAME = 'ONE Claude';
const TO_EMAIL = 'brad.mccloskey@gmail.com';
const SMTP_HOST = 'smtp.mail.me.com';
const SMTP_PORT = 587;
const MAX_RETRIES = 3;

/**
 * EmailDigest — Generates and sends a daily HTML email digest
 * with project status, git info, GSD progress, and service health.
 *
 * Uses the orchestrator's scanner (enriched) and health monitor
 * instead of a separate Prisma database.
 */
class EmailDigest {
  /**
   * @param {Object} deps
   * @param {Object} deps.scanner - ProjectScanner instance
   * @param {Object} deps.healthMonitor - HealthMonitor instance
   * @param {Object} deps.sessionManager - SessionManager instance
   * @param {Object} deps.scanDb - ScanDB instance
   */
  constructor(deps) {
    this._scanner = deps.scanner;
    this._healthMonitor = deps.healthMonitor;
    this._sessionManager = deps.sessionManager;
    this._scanDb = deps.scanDb;
    this._snapshotPath = path.join(__dirname, '..', 'data', 'digest-snapshot.json');
  }

  /**
   * Send the daily email digest.
   * @param {Object} [opts]
   * @param {boolean} [opts.dryRun=false] - Print to stdout instead of sending
   * @returns {Promise<void>}
   */
  async send(opts = {}) {
    const dryRun = opts.dryRun || false;
    console.log(`[EMAIL] Starting digest${dryRun ? ' (DRY RUN)' : ''}...`);

    // Gather data
    const data = this._gatherData();
    console.log(`[EMAIL] Data: ${data.summary.total} projects, ${data.sessions.length} sessions, ${data.changes.length} changes`);

    // Build email
    const html = this._buildHtml(data);
    const text = this._buildText(data);
    const subject = `Dashboard Digest — ${this._formatDate()}`;

    if (dryRun) {
      console.log('\n--- HTML EMAIL ---\n');
      console.log(html);
      console.log('\n--- PLAIN TEXT ---\n');
      console.log(text);
      console.log('\n--- END DRY RUN ---');
      this._saveSnapshot(data.projects);
      return;
    }

    // Send via SMTP
    const password = process.env.ICLOUD_APP_PASSWORD;
    if (!password) {
      console.error('[EMAIL] FATAL: ICLOUD_APP_PASSWORD not set');
      return;
    }

    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: false,
      requireTLS: true,
      auth: { user: FROM_EMAIL, pass: password },
      tls: { rejectUnauthorized: true },
    });

    // Retry loop
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const result = await transporter.sendMail({
          from: `"${FROM_NAME}" <${FROM_EMAIL}>`,
          to: TO_EMAIL,
          subject,
          html,
          text,
        });
        console.log(`[EMAIL] Sent: ${result.messageId}`);
        this._saveSnapshot(data.projects);
        return;
      } catch (err) {
        if (attempt === MAX_RETRIES) {
          console.error(`[EMAIL] Failed after ${MAX_RETRIES} attempts:`, err.message);
          return;
        }
        const delay = attempt * 5000;
        console.warn(`[EMAIL] Attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}. Retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  // ── Data gathering ────────────────────────────────────────────

  _gatherData() {
    const previousStatuses = this._loadSnapshot();
    const projects = this._scanner.scanAllEnriched();
    const sessions = this._sessionManager.getSessionStatuses();
    const healthResults = this._healthMonitor.getLastResults();

    // Running services
    const services = Object.values(healthResults)
      .filter(s => s.status === 'up')
      .map(s => ({ name: s.name, latency: s.latencyMs }));

    // Detect status changes
    const changes = projects
      .filter(p => previousStatuses[p.name] && previousStatuses[p.name] !== (p.status || 'unknown'))
      .map(p => ({
        name: p.name,
        from: previousStatuses[p.name],
        to: p.status || 'unknown',
      }));

    // Summary
    const summary = {
      total: projects.length,
      active: projects.filter(p => p.hasState && !(p.status || '').toLowerCase().includes('complete')).length,
      blocked: projects.filter(p => p.needsAttention && p.blockers.length > 0).length,
      complete: projects.filter(p => (p.status || '').toLowerCase().includes('complete')).length,
    };

    return { projects, sessions, services, changes, summary };
  }

  // ── Snapshot (status change detection) ────────────────────────

  _loadSnapshot() {
    try {
      const raw = fs.readFileSync(this._snapshotPath, 'utf-8');
      return JSON.parse(raw).statuses || {};
    } catch {
      return {};
    }
  }

  _saveSnapshot(projects) {
    const snapshot = {
      timestamp: new Date().toISOString(),
      statuses: {},
    };
    for (const p of projects) {
      snapshot.statuses[p.name] = p.status || 'unknown';
    }
    const dir = path.dirname(this._snapshotPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this._snapshotPath, JSON.stringify(snapshot, null, 2));
  }

  // ── HTML template ─────────────────────────────────────────────

  _statusBadge(status) {
    const colors = {
      Active: { bg: '#166534', text: '#86efac' },
      Complete: { bg: '#1e293b', text: '#94a3b8' },
      Blocked: { bg: '#7f1d1d', text: '#fca5a5' },
    };
    const c = colors[status] || { bg: '#374151', text: '#9ca3af' };
    return `<span style="display:inline-block;padding:2px 10px;border-radius:9999px;font-size:12px;font-weight:600;background:${c.bg};color:${c.text}">${this._esc(status)}</span>`;
  }

  _formatDate() {
    return new Date().toLocaleDateString('en-US', {
      weekday: 'long', month: 'short', day: 'numeric',
    });
  }

  _esc(s) {
    if (!s) return '';
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  _buildHtml(data) {
    const { summary, changes, sessions, projects, services } = data;
    const dateStr = this._formatDate();
    const blockedProjects = projects.filter(p => p.needsAttention && p.blockers.length > 0);

    // Changes table rows
    const changesRows = changes.length === 0
      ? '<tr><td style="padding:12px 16px;color:#64748b;font-size:14px" colspan="3">No status changes since last digest</td></tr>'
      : changes.map(c =>
          `<tr><td style="padding:10px 16px;border-bottom:1px solid #1e293b;color:#e2e8f0;font-size:14px">${this._esc(c.name)}</td><td style="padding:10px 16px;border-bottom:1px solid #1e293b;font-size:13px">${this._statusBadge(c.from)}</td><td style="padding:10px 16px;border-bottom:1px solid #1e293b;font-size:13px">${this._statusBadge(c.to)}</td></tr>`
        ).join('');

    // Blocked projects rows
    const blockedRows = blockedProjects.length === 0
      ? '<tr><td style="padding:12px 16px;color:#64748b;font-size:14px">No blocked projects</td></tr>'
      : blockedProjects.map(p =>
          `<tr><td style="padding:10px 16px;border-bottom:1px solid #1e293b;color:#e2e8f0;font-size:14px">${this._esc(p.name)}</td><td style="padding:10px 16px;border-bottom:1px solid #1e293b;color:#94a3b8;font-size:13px">${this._esc(p.blockers[0] || 'No details')}</td></tr>`
        ).join('');

    // Sessions rows
    const sessionRows = sessions.length === 0
      ? '<tr><td style="padding:12px 16px;color:#64748b;font-size:14px">No active sessions</td></tr>'
      : sessions.map(s =>
          `<tr><td style="padding:10px 16px;border-bottom:1px solid #1e293b;color:#e2e8f0;font-size:14px">${this._esc(s.projectName || s.name)}</td><td style="padding:10px 16px;border-bottom:1px solid #1e293b;color:#94a3b8;font-size:13px">${s.needsInput ? 'needs input' : 'running'}</td></tr>`
        ).join('');

    // All projects rows with git + GSD
    const projectRows = projects.map(p => {
      const gsd = p.gsdPhasesTotal > 0 ? `${p.gsdPhasesComplete}/${p.gsdPhasesTotal}` : '-';
      const branch = p.gitBranch || '-';
      const dirty = p.dirtyFiles > 0 ? `${p.dirtyFiles}` : '-';
      const category = p.name.split('/')[0] || '-';
      return `<tr>
        <td style="padding:8px 16px;border-bottom:1px solid #1e293b;color:#e2e8f0;font-size:13px">${this._esc(p.name)}</td>
        <td style="padding:8px 16px;border-bottom:1px solid #1e293b;font-size:13px">${this._statusBadge(p.status || 'unknown')}</td>
        <td style="padding:8px 16px;border-bottom:1px solid #1e293b;color:#94a3b8;font-size:13px">${this._esc(branch)}</td>
        <td style="padding:8px 16px;border-bottom:1px solid #1e293b;color:${p.dirtyFiles > 0 ? '#eab308' : '#94a3b8'};font-size:13px">${dirty}</td>
        <td style="padding:8px 16px;border-bottom:1px solid #1e293b;color:#94a3b8;font-size:13px">${gsd}</td>
      </tr>`;
    }).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ONE Claude Digest</title></head>
<body style="margin:0;padding:0;background:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#e2e8f0">
<div style="max-width:700px;margin:0 auto;padding:24px 16px">

  <div style="background:#1e293b;border-radius:12px;padding:24px;margin-bottom:16px;border-left:4px solid #3b82f6">
    <h1 style="margin:0 0 4px;font-size:20px;font-weight:700;color:#f1f5f9">ONE Claude — Dashboard Digest</h1>
    <p style="margin:0;font-size:14px;color:#94a3b8">${dateStr}</p>
  </div>

  <table style="width:100%;border-collapse:separate;border-spacing:8px;margin-bottom:16px">
    <tr>
      <td style="width:25%;padding:16px;background:#1e293b;border-radius:8px;text-align:center">
        <div style="font-size:28px;font-weight:700;color:#f1f5f9">${summary.total}</div><div style="font-size:12px;color:#94a3b8;margin-top:4px">Total</div>
      </td>
      <td style="width:25%;padding:16px;background:#1e293b;border-radius:8px;text-align:center">
        <div style="font-size:28px;font-weight:700;color:#86efac">${summary.active}</div><div style="font-size:12px;color:#94a3b8;margin-top:4px">Active</div>
      </td>
      <td style="width:25%;padding:16px;background:#1e293b;border-radius:8px;text-align:center">
        <div style="font-size:28px;font-weight:700;color:#fca5a5">${summary.blocked}</div><div style="font-size:12px;color:#94a3b8;margin-top:4px">Blocked</div>
      </td>
      <td style="width:25%;padding:16px;background:#1e293b;border-radius:8px;text-align:center">
        <div style="font-size:28px;font-weight:700;color:#94a3b8">${summary.complete}</div><div style="font-size:12px;color:#94a3b8;margin-top:4px">Complete</div>
      </td>
    </tr>
  </table>

  <div style="background:#1e293b;border-radius:12px;margin-bottom:16px;overflow:hidden">
    <div style="padding:16px;border-bottom:1px solid #334155"><h2 style="margin:0;font-size:16px;font-weight:600;color:#f1f5f9">Status Changes</h2></div>
    <table style="width:100%;border-collapse:collapse">
      <thead><tr style="background:#0f172a">
        <th style="padding:10px 16px;text-align:left;font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.05em">Project</th>
        <th style="padding:10px 16px;text-align:left;font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.05em">From</th>
        <th style="padding:10px 16px;text-align:left;font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.05em">To</th>
      </tr></thead>
      <tbody>${changesRows}</tbody>
    </table>
  </div>

  <div style="background:#1e293b;border-radius:12px;margin-bottom:16px;overflow:hidden;border-left:4px solid #dc2626">
    <div style="padding:16px;border-bottom:1px solid #334155"><h2 style="margin:0;font-size:16px;font-weight:600;color:#fca5a5">Blocked Projects</h2></div>
    <table style="width:100%;border-collapse:collapse">
      <thead><tr style="background:#0f172a">
        <th style="padding:10px 16px;text-align:left;font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.05em">Project</th>
        <th style="padding:10px 16px;text-align:left;font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.05em">Blocker</th>
      </tr></thead>
      <tbody>${blockedRows}</tbody>
    </table>
  </div>

  <div style="background:#1e293b;border-radius:12px;margin-bottom:16px;overflow:hidden">
    <div style="padding:16px;border-bottom:1px solid #334155"><h2 style="margin:0;font-size:16px;font-weight:600;color:#f1f5f9">Active Sessions</h2></div>
    <table style="width:100%;border-collapse:collapse">
      <thead><tr style="background:#0f172a">
        <th style="padding:10px 16px;text-align:left;font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.05em">Project</th>
        <th style="padding:10px 16px;text-align:left;font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.05em">Status</th>
      </tr></thead>
      <tbody>${sessionRows}</tbody>
    </table>
  </div>

  <div style="background:#1e293b;border-radius:12px;margin-bottom:16px;overflow:hidden">
    <div style="padding:16px;border-bottom:1px solid #334155"><h2 style="margin:0;font-size:16px;font-weight:600;color:#f1f5f9">Services (${services.length} running)</h2></div>
    <table style="width:100%;border-collapse:collapse">
      <tbody>${services.map(s => `<tr><td style="padding:8px 16px;border-bottom:1px solid #1e293b;color:#86efac;font-size:13px">${this._esc(s.name)}</td><td style="padding:8px 16px;border-bottom:1px solid #1e293b;color:#94a3b8;font-size:13px">${s.latency != null ? s.latency + 'ms' : ''}</td></tr>`).join('')}</tbody>
    </table>
  </div>

  <div style="background:#1e293b;border-radius:12px;margin-bottom:16px;overflow:hidden">
    <div style="padding:16px;border-bottom:1px solid #334155"><h2 style="margin:0;font-size:16px;font-weight:600;color:#f1f5f9">All Projects</h2></div>
    <table style="width:100%;border-collapse:collapse">
      <thead><tr style="background:#0f172a">
        <th style="padding:8px 16px;text-align:left;font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.05em">Project</th>
        <th style="padding:8px 16px;text-align:left;font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.05em">Status</th>
        <th style="padding:8px 16px;text-align:left;font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.05em">Branch</th>
        <th style="padding:8px 16px;text-align:left;font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.05em">Dirty</th>
        <th style="padding:8px 16px;text-align:left;font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.05em">GSD</th>
      </tr></thead>
      <tbody>${projectRows}</tbody>
    </table>
  </div>

  <div style="text-align:center;padding:16px 0;color:#475569;font-size:12px">
    <p style="margin:0">Sent from ONE Claude — ${new Date().toISOString()}</p>
  </div>

</div>
</body>
</html>`;
  }

  // ── Plain text fallback ───────────────────────────────────────

  _buildText(data) {
    const { summary, changes, sessions, projects, services } = data;
    const lines = [`ONE Claude — Dashboard Digest — ${this._formatDate()}`];
    lines.push('='.repeat(50));

    lines.push('\nSummary');
    lines.push('-------');
    lines.push(`Total: ${summary.total}  Active: ${summary.active}  Blocked: ${summary.blocked}  Complete: ${summary.complete}`);

    lines.push('\nStatus Changes');
    lines.push('--------------');
    if (changes.length === 0) {
      lines.push('No changes');
    } else {
      for (const c of changes) lines.push(`- ${c.name}: ${c.from} -> ${c.to}`);
    }

    const blockedProjects = projects.filter(p => p.needsAttention && p.blockers.length > 0);
    lines.push('\nBlocked');
    lines.push('-------');
    if (blockedProjects.length === 0) {
      lines.push('None');
    } else {
      for (const p of blockedProjects) lines.push(`- ${p.name}: ${p.blockers[0] || 'No details'}`);
    }

    lines.push('\nSessions');
    lines.push('--------');
    if (sessions.length === 0) {
      lines.push('No active sessions');
    } else {
      for (const s of sessions) lines.push(`- ${s.projectName || s.name} (${s.needsInput ? 'needs input' : 'running'})`);
    }

    lines.push('\nServices');
    lines.push('--------');
    lines.push(`${services.length} running`);

    lines.push('\nAll Projects');
    lines.push('------------');
    for (const p of projects) {
      const gsd = p.gsdPhasesTotal > 0 ? ` (${p.gsdPhasesComplete}/${p.gsdPhasesTotal})` : '';
      const branch = p.gitBranch ? ` [${p.gitBranch}]` : '';
      const dirty = p.dirtyFiles > 0 ? ` ${p.dirtyFiles}d` : '';
      lines.push(`- [${p.status || '?'}] ${p.name}${branch}${dirty}${gsd}`);
    }

    lines.push(`\n--\nSent from ONE Claude — ${new Date().toISOString()}`);
    return lines.join('\n');
  }
}

module.exports = EmailDigest;
