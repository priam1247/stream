/**
 * ecosystem.config.js — pm2 process definition.
 *
 *   pm2 start ecosystem.config.js
 *   pm2 logs zafar-bot
 *   pm2 restart zafar-bot          # picks up new gateway/ or command code
 *   pm2 save
 *
 * `autorestart` plus `max_restarts` is what makes `.botmanage restart` safe:
 * that command exits non-zero on purpose and pm2 brings it straight back.
 */
module.exports = {
  apps: [
    {
      name: 'zafar-bot',
      script: 'gateway/index.js',
      cwd: __dirname,
      node_args: '--expose-gc',
      instances: 1,
      exec_mode: 'fork',

      // The bot is stateful (one Baileys socket per linked number), so it must
      // never be cluster-mode scaled.
      autorestart: true,
      max_restarts: 20,
      min_uptime: '30s',
      restart_delay: 4000,
      exp_backoff_restart_delay: 1000,

      max_memory_restart: '900M',

      env: {
        NODE_ENV: 'production',
      },

      // pm2's own logs are supplementary; the bot writes logs/gateway.log itself.
      out_file: './logs/pm2-out.log',
      error_file: './logs/pm2-error.log',
      merge_logs: true,
      time: true,
    },
  ],
};
