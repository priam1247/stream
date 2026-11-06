// engine/media/torrentWorker.js — runs ONE torrent download in a child process.
//
// The parent (downloader.js) forks this file, sends a single `start` message and
// gets back `progress`, then `done` or `error`. Because WebTorrent, its DHT and
// its peer connections live only in this process, a stuck, leaking or crashing
// torrent can be killed without touching the WhatsApp socket or other commands.
import { torrentToFile } from './torrent.js';

const send = (message, then) => {
  try { process.send?.(message, then); } catch { then?.(); }
};

process.on('disconnect', () => process.exit(1)); // parent is gone: never linger

process.on('message', async (job) => {
  if (job?.type !== 'start') return;
  try {
    const { file } = await torrentToFile(job.magnet, job.dest, {
      ...job.opts,
      onProgress: (got, total) => send({ type: 'progress', got, total }),
    });
    send({ type: 'done', file }, () => process.exit(0));
  } catch (error) {
    send({ type: 'error', message: String(error?.message || error).slice(0, 300), code: error?.code || '' }, () => process.exit(1));
  }
});
