'use strict';

// Keep the existing command/aliases, but do not require paid API tokens.
module.exports = {
  name: 'debrid',
  aliases: ['rd', 'debridstatus'],
  category: 'general',
  description: 'Movie source information',
  usage: '.debrid',
  async execute(_sock, _msg, _args, extra) {
    return extra.reply('Movie downloads use keyless sources and direct torrents; debrid services are no longer used.');
  },
};
