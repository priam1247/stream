'use strict';

/**
 * commands/menu/index.js — the command menu.
 *
 * Behaviour preserved from the old commands/general/menu.js:
 *   - respects the configured prefix
 *   - groups by category
 *   - hides owner-only rows from regular users
 *   - `.menu <section>` shows one section only
 *
 * The difference: the old menu was a hand-maintained list inside menu.js, so it
 * drifted (it advertised `.dl` and `.ytv`, neither of which exists). This menu
 * is generated from the registry, which is passed in through ctx, so it can only
 * list commands that actually loaded.
 */

const meta = require('./command.json');
const { renderMenu } = require('./render');

async function run(ctx) {
  const section = String(ctx.text || '').trim().toLowerCase();

  // 1. validate
  if (section.length > meta.limits.maxSectionChars) {
    return ctx.reply(`Usage: ${meta.usage}`);
  }

  const catalogue = Array.isArray(ctx.catalogue) ? ctx.catalogue : [];
  if (!catalogue.length) {
    return ctx.reply('❌ The command catalogue is empty. The registry did not load any command.');
  }

  // 3. do the work
  const { text, unknownSection } = renderMenu(catalogue, {
    prefix: ctx.prefix,
    role: ctx.role,
    section,
  });

  // 4. send
  if (unknownSection) {
    return ctx.reply(`❌ No section named *${section}*. Try ${ctx.prefix}menu.`);
  }
  return ctx.reply(text);
}

module.exports = { run };
