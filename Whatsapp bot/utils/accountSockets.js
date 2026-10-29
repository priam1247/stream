'use strict';

// A stable session key prevents a download or selection from being sent through
// a different WhatsApp account when several accounts are connected at once.
const { EventEmitter } = require('events');
const events = new EventEmitter();
const sockets = new Map();
const PRIMARY_SESSION = 'primary';

function sessionKey(sock) {
  return String(sock?.__sessionId || PRIMARY_SESSION);
}

function setOnline(id, sock) {
  const key = String(id || PRIMARY_SESSION);
  sockets.set(key, sock);
  events.emit('online', key);
}

function setOffline(id, sock) {
  const key = String(id || PRIMARY_SESSION);
  if (sockets.get(key) === sock) sockets.delete(key);
}

function getOnline(id = PRIMARY_SESSION) {
  const sock = sockets.get(String(id || PRIMARY_SESSION)) || null;
  if (!sock) return null;
  try { return typeof sock.__canRespond !== 'function' || sock.__canRespond() ? sock : null; }
  catch { return null; }
}

module.exports = {
  PRIMARY_SESSION,
  sessionKey,
  setOnline,
  setOffline,
  getOnline,
  onOnline: (fn) => { events.on('online', fn); return () => events.off('online', fn); },
};
