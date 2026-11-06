'use strict';

const ytAuth = require('../../lib/youtube/auth');
const config = require('../../config');
const log = require('../../lib/logger')('ytlogin');

module.exports = {
  name: 'ytlogin',
  aliases: ['ytauth', 'ytoauth'],
  category: 'admin',
  description: 'Link Google TV OAuth for YouTube downloads',
  usage: '.ytlogin | .ytlogin status | .ytlogin off',
  ownerOnly: true,

  async execute(sock, msg, args, extra) {
    const sub = String(args[0] || '').toLowerCase();
    const P = config.prefix || '.';

    if (sub === 'status') {
      return extra.reply(`🔐 YouTube OAuth: ${ytAuth.hasYtCreds() ? 'linked' : 'none'}`);
    }

    if (['off', 'logout', 'clear', 'delete', 'remove'].includes(sub)) {
      try { ytAuth.clearYtCreds(); }
      catch (err) {
        if (err?.code !== 'YT_AUTH_CLEAR_FAILED') throw err;
        // Do not send paths, credential contents, or the raw filesystem error to chat.
        const code = typeof err.cause?.code === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/.test(err.cause.code) ? err.cause.code : 'unknown';
        log.warn('YouTube OAuth cleanup incomplete; local credential copies may remain. Filesystem code:', code);
        return extra.reply(`YouTube OAuth cleanup is incomplete; some local credentials may remain. Check server file permissions and retry ${P}ytlogin off, or contact the server administrator.`);
      }
      return extra.reply('🔐 YouTube OAuth cleared.');
    }

    if (sub && sub !== 'start' && sub !== 'login') {
      return extra.reply(`Usage: ${P}ytlogin | ${P}ytlogin status | ${P}ytlogin off`);
    }

    if (ytAuth.isLoginPending()) {
      return extra.reply('⏳ A YouTube login code is already waiting for approval.');
    }

    let promptHandle = null;
    return (async () => {
      try {
        await ytAuth.startYtLogin({
          onCode: async ({ verificationUrl, userCode }) => {
            const text = [
              '🔐 *YouTube Login*',
              `Open: ${verificationUrl}`,
              `Code: *${userCode}*`,
            ].join('\n');
            promptHandle = await extra.status(text);
          },
        });
        if (promptHandle) {
          await promptHandle.update('✅ YouTube account linked.');
        } else {
          await extra.reply('✅ YouTube account linked.');
        }
      } catch (err) {
        if (err?.code === 'LOGIN_CANCELLED') {
          if (promptHandle) await promptHandle.update('YouTube login cancelled.');
          return;
        }
        console.error('[ytlogin] login failed:', err?.message);
        const line = '❌ YouTube login failed. Please try again.';
        if (promptHandle) await promptHandle.update(line);
        else await extra.reply(line);
      }
    })();
  },
};
