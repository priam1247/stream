'use strict';

/** Pure rendering for the status board. No I/O. */

const { ago } = require('../../lib/format');

const ICON = { ok: '✅', broken: '❌', disabled: '⛔', unknown: '⚪' };

function iconFor(state) {
  return ICON[state] || ICON.unknown;
}

function shortReason(reason) {
  const text = String(reason || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > 70 ? text.slice(0, 69) + '…' : text;
}

/**
 * @param {Array<{name:string}>} catalogue
 * @param {object} statuses  name -> { state, reason, lastOkAt, lastErrorAt }
 * @param {{prefix:string}} opts
 */
function renderBoard(catalogue, statuses, { prefix = '.' } = {}) {
  const names = [...new Set([
    ...catalogue.map((c) => c.name),
    ...Object.keys(statuses || {}),
  ])].sort();

  const rows = names.map((name) => {
    const s = statuses?.[name] || { state: 'unknown', reason: '', lastOkAt: null };
    const label = `${iconFor(s.state)} ${prefix}${name}`;
    if (s.state === 'ok') return label;
    if (s.state === 'disabled') return `${label} (${shortReason(s.reason) || 'disabled'})`;
    if (s.state === 'broken') {
      const last = s.lastOkAt ? ` (last ok: ${ago(s.lastOkAt)})` : ' (never ok)';
      return `${label} → ${shortReason(s.reason) || 'failed'}${last}`;
    }
    return `${label} (not run yet)`;
  });

  const counts = { ok: 0, broken: 0, disabled: 0, unknown: 0 };
  for (const name of names) {
    const state = statuses?.[name]?.state || 'unknown';
    counts[state] = (counts[state] || 0) + 1;
  }

  const header = `*Health board* · ✅ ${counts.ok} · ❌ ${counts.broken} · ⛔ ${counts.disabled}${counts.unknown ? ` · ⚪ ${counts.unknown}` : ''}`;
  return [header, '', ...rows].join('\n');
}

function unknownCommandDetail(row, status, { prefix = '.' } = {}) {
  const s = status || { state: 'unknown' };
  const lines = [
    `*${prefix}${row.name}*`,
    `state: ${iconFor(s.state)} ${s.state || 'unknown'}`,
    `role: ${row.role}`,
    `category: ${row.category}`,
    `usage: ${row.usage}`,
    `description: ${row.description}`,
  ];
  if (s.reason) lines.push(`reason: ${s.reason}`);
  if (s.lastOkAt) lines.push(`last ok: ${ago(s.lastOkAt)}`);
  if (s.lastErrorAt) lines.push(`last error: ${ago(s.lastErrorAt)}`);
  if (Array.isArray(row.aliases) && row.aliases.length) {
    lines.push(`aliases: ${row.aliases.map((a) => prefix + a).join(', ')}`);
  }
  return lines.join('\n');
}

module.exports = { renderBoard, unknownCommandDetail, iconFor, shortReason };
