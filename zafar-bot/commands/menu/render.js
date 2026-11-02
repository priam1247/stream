'use strict';

/**
 * commands/menu/render.js — pure rendering, no ctx, no I/O.
 *
 * A catalogue row is:
 *   { name, aliases, category, description, usage, role }
 *
 * Access filtering here is display only. The real gate is guards.js; hiding a
 * row must never be the thing that protects a command.
 */

const RANK = { banned: 0, user: 1, admin: 2, owner: 3 };

const SECTION_TITLES = {
  general: 'GENERAL',
  media: 'MEDIA',
  papers: 'PAPERS',
  admin: 'ADMIN',
};

const SECTION_MATCHERS = {
  general: (c) => c.category === 'general',
  media: (c) => c.category === 'media',
  papers: (c) => c.category === 'papers',
  admin: (c) => c.role !== 'user',
};

function visible(row, role) {
  return (RANK[row.role] ?? 1) <= (RANK[role] ?? 1);
}

function groupRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.category || 'general';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

/** The board marker for a row. Only failures and disables are marked. */
const STATE_MARK = {
  broken: '❌',
  disabled: '⛔',
};

function rowLine(row, prefix) {
  const usage = String(row.usage || `${prefix}${row.name}`).replace(/^\./, prefix);
  const mark = STATE_MARK[row.state];
  const prefixText = mark ? `${mark} ` : '';
  const reason = mark && row.stateReason ? ` _(${row.stateReason})_` : '';
  return `${prefixText}${usage} — ${row.description || ''}${reason}`.trim();
}

/**
 * @returns {{text:string, unknownSection:boolean}}
 */
function renderMenu(catalogue, { prefix = '.', role = 'user', section = '' } = {}) {
  const key = String(section || '').toLowerCase();
  if (key && !SECTION_MATCHERS[key]) {
    return { text: '', unknownSection: true };
  }

  const rows = catalogue
    .filter((row) => visible(row, role))
    .filter((row) => (key ? SECTION_MATCHERS[key](row) : true))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (!rows.length) {
    return { text: `_No commands available in this section._`, unknownSection: false };
  }

  const groups = groupRows(rows);
  const lines = [`*${prefix}menu*`, ''];

  for (const [category, list] of groups) {
    const title = SECTION_TITLES[category] || category.toUpperCase();
    lines.push(`*${title}*`);
    for (const row of list) {
      lines.push(rowLine(row, prefix));
      if (Array.isArray(row.aliases) && row.aliases.length) {
        lines.push(`   _also: ${row.aliases.map((a) => prefix + a).join(', ')}_`);
      }
    }
    lines.push('');
  }

  return { text: lines.join('\n').trim(), unknownSection: false };
}

module.exports = { renderMenu, visible, rowLine, SECTION_TITLES };
