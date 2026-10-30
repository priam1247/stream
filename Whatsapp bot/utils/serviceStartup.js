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

module.exports = { startSessionServices };
