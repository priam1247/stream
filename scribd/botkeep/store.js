'use strict';
/**
 * Client for the Python storage server (XS Systems, 25811).
 *
 * That box is "just for downloading": it accepts finished PDFs and serves them
 * back. It never runs a browser and never downloads Chromium. Botkeep captures
 * here, then hands each PDF over.
 */

const fs = require('fs');
const path = require('path');

const config = require('./config');

const TIMEOUT_MS = 120_000;

function headers(extra = {}) {
  const out = { Accept: 'application/json', ...extra };
  const key = config.panelKey();
  if (key) out['X-Panel-Key'] = key;
  return out;
}

function explain(err) {
  const text = err && err.message ? err.message : String(err);
  if (/ECONNREFUSED|fetch failed|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(text)) {
    return `Python file server at ${config.storeUrl()} (it is not answering)`;
  }
  if (/timeout|timed out|aborted/i.test(text)) return 'Python file server (it timed out)';
  return text;
}

async function request(pathname, init = {}) {
  const url = `${config.storeUrl()}${pathname}`;
  try {
    const response = await fetch(url, {
      ...init,
      headers: headers(init.headers),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return response;
  } catch (err) {
    throw new Error(`Could not reach the ${explain(err)}.`);
  }
}

async function json(pathname, init) {
  const response = await request(pathname, init);
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const message = parsed && parsed.error ? parsed.error : `storage server returned HTTP ${response.status}`;
    throw new Error(message);
  }
  if (parsed === null) throw new Error('the storage server did not answer with JSON');
  return parsed;
}

async function health() {
  const response = await request('/health');
  let parsed = null;
  try {
    parsed = JSON.parse(await response.text());
  } catch {
    parsed = null;
  }
  return { ok: response.ok && Boolean(parsed && parsed.ok), body: parsed };
}

/** Send a finished PDF to the storage box. */
async function upload(file, name) {
  const body = fs.readFileSync(file);
  return json(`/upload?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/pdf', 'Content-Length': String(body.length) },
    body,
  });
}

async function files() {
  return json('/files');
}

async function reset() {
  return json('/reset', { method: 'POST' });
}

/** Stream one stored PDF back to the client. */
async function download(name) {
  const response = await request(`/file/${encodeURIComponent(name)}`);
  return response;
}

function localName(file) {
  return path.basename(file);
}

module.exports = { health, upload, files, reset, download, localName };
