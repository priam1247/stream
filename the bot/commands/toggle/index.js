const database = require('../../lib/database');
const config   = require('../../config');

module.exports = {
  name: 'on',
  aliases: ['off'],
  ownerOnly: true,
  category: 'admin',
  description: 'Enable or disable the service globally',
  usage: '.on | .off | .on <command> | .off <command>',

  async execute(sock, msg, args, extra) {
    const invoked = String(extra?.commandName || '').trim().toLowerCase();
    const turningOn = invoked
      ? invoked === 'on'
      : (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '')
          .trim()
          .toLowerCase()
          .startsWith(`${config.prefix}on`);

    // `.on <command>` / `.off <command>` switches ONE command; bare `.on` / `.off` stays global.
    if (args && args[0]) {
      const registry = require('../../gateway/registry');
      const target = String(args[0]).replace(/^\./, '').toLowerCase();
      if (!registry.targetsOf(target).length) return extra.reply(`❌ Unknown command "${target}".`);
      if (turningOn) {
        const names = registry.enable(target);
        await sock.sendMessage(extra.from, { react: { text: '✅', key: msg.key } });
        return extra.reply(`🟢 ${names.map((n) => '.' + n).join(' ')} ON`);
      }
      const result = registry.disable(target, 'owner');
      if (!result.names.length) return extra.reply(`❌ ${result.skipped.map((n) => '.' + n).join(' ')} controls the bot and cannot be switched off.`);
      await sock.sendMessage(extra.from, { react: { text: '🔴', key: msg.key } });
      return extra.reply(`🔴 ${result.names.map((n) => '.' + n).join(' ')} OFF${result.skipped.length ? `\n(${result.skipped.map((n) => '.' + n).join(' ')} cannot be switched off)` : ''}`);
    }

    if (turningOn) {
      database.setBotState(true);
      await sock.sendMessage(extra.from, { react: { text: '✅', key: msg.key } });
      return extra.reply('🟢 Service ON');
    } else {
      database.setBotState(false);
      await sock.sendMessage(extra.from, { react: { text: '🔴', key: msg.key } });
      return extra.reply('🔴 Service OFF');
    }
  },
};
