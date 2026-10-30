'use strict';

// A background result belongs to the account that received its request. Keep
// it on disk while that account is offline instead of using a different socket.
const fs = require('fs');
const path = require('path');
const jobs = require('./persistentJobs');
const sockets = require('./accountSockets');
const router = require('./providerRouter');
const rcloneStore = require('./rcloneStore');
const mediaTransfer = require('./mediaTransfer');
const { getTempDir, deleteTempFile, holdTemp } = require('./tempManager');
const { safeErrorMessage } = require('./userErrors');

let started = false;
let retryTimer = null;
const delivering = new Set();
const heldJobs = new Map();

function holdJob(job) {
  const id = Number(job.id);
  if (heldJobs.has(id)) return;
  const releases = [job.path, ...(job.subs || [])].filter(Boolean).map((file) => holdTemp(file));
  heldJobs.set(id, () => releases.forEach((release) => release()));
}

function releaseJob(id) {
  heldJobs.get(Number(id))?.();
  heldJobs.delete(Number(id));
}

// Called before the boot cleanup. A completed download can outlive the process
// while its account is offline, so those files must not be swept on restart.
function protectPendingFiles() {
  for (const row of jobs.listPendingNotifications()) {
    if (row.status === 'pending_delivery') holdJob({ ...(row.result || {}), id: row.id });
  }
}

function discardJob(job) {
  for (const file of [job.path, ...(job.subs || [])]) {
    if (!file) continue;
    const target = path.resolve(String(file));
    const owned = [router.mediaDir(), getTempDir()].some((dir) => {
      const root = path.resolve(dir);
      return target === root || target.startsWith(`${root}${path.sep}`);
    });
    if (owned) {
      try { fs.rmSync(target, { force: true }); } catch { /* already gone */ }
    } else deleteTempFile(file);
  }
}

function activeSocket(job) {
  return sockets.getOnline(job.req?.sessionId || sockets.PRIMARY_SESSION);
}

async function sendInline(sock, chatId, job, size) {
  const sniff = mediaTransfer.sniffFile(job.path);
  const name = mediaTransfer.safeName(job.title || path.basename(job.path), 'media');
  const caption = `📥 *${job.title || name}*${job.quality ? `\n🎞️ ${job.quality}` : ''}\n📦 ${mediaTransfer.fmtMB(size)}`;
  const stillAvailable = () => {
    if (activeSocket(job) !== sock) throw new Error('The originating account is offline or paused');
  };

  if (sniff.kind === 'video') {
    const ready = await mediaTransfer.ensureWhatsAppMp4(job.path, path.join(getTempDir(), `${path.basename(job.path)}.wa.mp4`));
    try {
      const finalSize = fs.statSync(ready).size;
      const payload = finalSize > 50 * 1024 * 1024
        ? { document: { url: ready }, mimetype: 'video/mp4', fileName: `${name}.mp4`, caption }
        : { video: { url: ready }, mimetype: 'video/mp4', caption };
      stillAvailable();
      await sock.sendMessage(chatId, payload);
    } finally {
      if (ready !== job.path) deleteTempFile(ready);
    }
  } else if (sniff.kind === 'audio') {
    stillAvailable();
    await sock.sendMessage(chatId, { audio: { url: job.path }, mimetype: sniff.mime, fileName: `${name}.${sniff.ext}`, ptt: false });
  } else if (sniff.kind === 'image') {
    stillAvailable();
    await sock.sendMessage(chatId, { image: { url: job.path }, caption });
  } else {
    stillAvailable();
    await sock.sendMessage(chatId, { document: { url: job.path }, mimetype: sniff.mime, fileName: `${name}.${sniff.ext}`, caption });
  }
}

function scheduleRetry() {
  if (retryTimer || !started) return;
  retryTimer = setTimeout(() => { retryTimer = null; resumePending(); }, 30_000);
  retryTimer.unref?.();
}

async function deliver(job, failed = false) {
  const id = Number(job.id);
  if (delivering.has(id)) return;
  const sock = activeSocket(job);
  const chatId = job.req?.chatId;
  if (!chatId) return;
  if (!sock) { scheduleRetry(); return; }
  delivering.add(id);
  let delivered = false;
  try {
    if (failed) {
      await sock.sendMessage(chatId, { text: safeErrorMessage(new Error(job.error || 'Download failed')) });
    } else if (!job.path || !fs.existsSync(job.path)) {
      await sock.sendMessage(chatId, { text: '❌ The download is no longer available. Please request it again.' });
    } else {
      const size = Number(job.size) || fs.statSync(job.path).size;
      if (size > rcloneStore.inlineLimit()) {
        const link = await rcloneStore.put(job.path, size);
        if (activeSocket(job) !== sock) throw new Error('The originating account is offline or paused');
        await sock.sendMessage(chatId, { text: `📦 *${job.title || path.basename(job.path)}* — ${mediaTransfer.fmtMB(size)}\n${link}` });
      } else {
        await sendInline(sock, chatId, job, size);
      }
    }
    jobs.markNotified(id, failed ? 'pending_failure' : 'pending_delivery');
    delivered = true;
  } catch (err) {
    console.error('Download delivery deferred:', err?.message || err);
    scheduleRetry();
  } finally {
    delivering.delete(id);
    if (delivered && !failed) {
      discardJob(job);
      releaseJob(id);
    }
  }
}

function resumePending() {
  if (!started) return;
  try {
    for (const row of jobs.listPendingNotifications()) {
      if (row.status === 'pending_delivery') {
        const job = { ...(row.result || {}), id: row.id, req: row.req };
        holdJob(job);
        void deliver(job);
      } else {
        void deliver({ id: row.id, req: row.req, error: row.error }, true);
      }
    }
  } catch (err) { console.error('Could not resume pending deliveries:', err?.message || err); }
}

const onDone = (job) => { if (job.req?.chatId) holdJob(job); void deliver(job); };
const onFail = (job) => { void deliver(job, true); };
sockets.onOnline(() => resumePending());

function start() {
  if (started) return;
  jobs.on('done', onDone).on('fail', onFail);
  try {
    jobs.start();
    started = true;
    resumePending();
  } catch (err) {
    jobs.off('done', onDone).off('fail', onFail);
    throw err;
  }
}

module.exports = { start, resumePending, protectPendingFiles };
