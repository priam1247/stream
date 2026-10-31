'use strict';

// Do not start the dashboard bridge before session startup succeeds: retries
// must never leave duplicate sockets, listeners, or sync controllers behind.
async function startSessionServices(sessions, startBridge, cleanup) {
  try {
    await sessions.start();
    return await startBridge();
  } catch (error) {
    try { await sessions.stop(); } catch { /* preserve the original failure */ }
    try { await cleanup?.(); } catch { /* preserve the original failure */ }
    throw error;
  }
}

// Stop intake first; don't let an API close error prevent credentials and the
// encrypted recovery copy from being flushed. The caller bounds shutdown time.
async function stopSessionServices({ sessions, sync, api, backup } = {}) {
  const errors = [];
  const failed = (component, err) => errors.push(new Error(`${component} shutdown failed`, { cause: err }));
  try { sync?.stop(); } catch (err) { failed('Dashboard sync', err); }
  let apiStopped = Promise.resolve();
  try { apiStopped = Promise.resolve(api?.stop()).catch((err) => { failed('Dashboard API', err); }); }
  catch (err) { failed('Dashboard API', err); }
  try { await sessions?.stop(); } catch (err) { failed('WhatsApp sessions', err); }
  try { await backup?.stop({ flush: true }); } catch (err) { failed('Session backup', err); }
  await apiStopped;
  if (errors.length) throw new AggregateError(errors, 'Some WhatsApp services could not stop cleanly.');
}

// Own the startup retry and shutdown race in one place. A shutdown that arrives
// while recovery is still starting waits for its result and closes it exactly once.
function createServiceLifecycle({ start, stop, onError, retryDelayMs = 30_000 } = {}) {
  if (typeof start !== 'function') throw new TypeError('A service start function is required.');
  let resource = null; let inFlight = null; let retryTimer = null;
  let closing = false; let shutdownPromise = null;

  function startOnce() {
    if (closing || inFlight || resource) return inFlight || Promise.resolve(resource);
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    inFlight = Promise.resolve().then(start).then((value) => {
      resource = value || {};
      return resource;
    }).catch((err) => {
      if (!closing) {
        try { onError?.(err); } catch { /* reporting must not prevent retry */ }
        retryTimer = setTimeout(() => { retryTimer = null; void startOnce(); }, Math.max(1, Number(retryDelayMs) || 30_000));
      }
      return null;
    }).finally(() => { inFlight = null; });
    return inFlight;
  }

  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    closing = true;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    shutdownPromise = (async () => {
      if (inFlight) await inFlight;
      if (resource) {
        const current = resource;
        resource = null;
        if (stop) await stop(current);
        else await current.stop?.();
      }
    })();
    return shutdownPromise;
  }

  return { start: startOnce, shutdown };
}

module.exports = { startSessionServices, stopSessionServices, createServiceLifecycle };
