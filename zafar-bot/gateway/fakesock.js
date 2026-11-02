'use strict';

/**
 * gateway/fakesock.js — a Baileys-shaped socket and message builder for tests.
 *
 * This is the harness the spec asks for: commands and guards can be exercised
 * without a live WhatsApp session. It records every send so tests can assert on
 * exact wording, and it can be told to fail on purpose.
 */

const fs = require('fs');
const path = require('path');

function createFakeSocket({ failKinds = [], chat = '265991234567@s.whatsapp.net' } = {}) {
  const sent = [];
  const sock = {
    user: { id: '265991234567@s.whatsapp.net' },
    __sent: sent,
    async sendMessage(to, content, options) {
      for (const kind of failKinds) {
        if (content[kind]) {
          const err = new Error(`simulated ${kind} send failure`);
          err.code = 'FAKE_SEND_FAILURE';
          throw err;
        }
      }
      const record = { to, content, options, at: Date.now() };
      sent.push(record);
      return { key: { id: `fake-${sent.length}`, remoteJid: to } };
    },
    async end() { /* no-op */ },
    ev: { on() { /* no-op */ }, off() { /* no-op */ } },
  };
  void chat;
  return sock;
}

function buildMessage({
  body = '',
  fromMe = true,
  chat = '265991234567@s.whatsapp.net',
  sender = '265991234567',
  quoted = null,
  message = null,
} = {}) {
  const content = message || {
    extendedTextMessage: {
      text: body,
      ...(quoted ? { contextInfo: { stanzaId: 'quoted-1', quotedMessage: quoted } } : {}),
    },
  };
  return {
    key: {
      remoteJid: chat,
      fromMe,
      participant: chat.endsWith('@g.us') ? `${sender}@s.whatsapp.net` : undefined,
      id: `msg-${Math.random().toString(36).slice(2, 10)}`,
    },
    message: content,
    pushName: 'Tester',
  };
}

/** Build a quoted message of a given type, e.g. buildQuoted('imageMessage'). */
function buildQuoted(type, fields = {}) {
  return { [type]: { ...fields } };
}

/** Make a temp file for send/cleanup tests. */
function makeTempFile(dir, name, bytes = 'x') {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  return file;
}

module.exports = { createFakeSocket, buildMessage, buildQuoted, makeTempFile };
