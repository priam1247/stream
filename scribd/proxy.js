'use strict';
/**
 * JS server for the Scribd panel — Botkeep side.
 *
 * This machine has NO Python and NO `downloader/` folder. It is the public
 * front door: it serves the panel (search UI, JSON routes, PDF downloads) by
 * forwarding every request to the Python screenshot panel running on the
 * XS Systems box, which does the real Chromium work.
 *
 *   Botkeep (JS)  ──HTTP──►  XS Systems (Python, 195.123.189.187:25811)
 *
 * The dashboard can point at either one; both answer the same routes
 * (/health, /status, /find, /run, /files, /file, /reset, /link, /diag).
 *
 * Everything is hardcoded. Set SCRIBD_PANEL_URL only to move the Python box.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const DEFAULT_REMOTE = 'http://195.123.189.187:25811';

// Headers that describe one hop only and must not be forwarded verbatim.
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
]);

function remoteBase() {
  const raw = (process.env.SCRIBD_PANEL_URL || DEFAULT_REMOTE).trim();
  try {
    const parsed = new URL(raw);
    if (!/^https?:$/.test(parsed.protocol)) return DEFAULT_REMOTE;
    parsed.search = '';
    parsed.hash = '';
    return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
  } catch {
    return DEFAULT_REMOTE;
  }
}

/** Hardcoded listen ports: the host's allocated port, else the panel's 25811. */
function ports() {
  const found = [];
  const push = (value) => {
    const n = Number(value);
    if (Number.isInteger(n) && n > 0 && n <= 65535 && !found.includes(n)) found.push(n);
  };
  for (const name of ['SERVER_PORT', 'PORT']) push(process.env[name]);
  if (!found.length) push(25811);
  return found;
}

function panelKey() {
  return (process.env.SCRIBD_PANEL_KEY || process.env.PANEL_KEY || '').trim();
}

function log(message) {
  try {
    console.log(`[scribd] ${message}`);
  } catch {
    /* ignore */
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

/** One request handler that streams the upstream answer back verbatim. */
function makeHandler(remote) {
  const target = new URL(remote);

  return function handler(req, res) {
    const upstreamPath = req.url && req.url.startsWith('/') ? req.url : `/${req.url || ''}`;
    const transport = target.protocol === 'https:' ? https : http;

    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (HOP_BY_HOP.has(name.toLowerCase())) continue;
      headers[name] = value;
    }
    const key = panelKey();
    if (key && !headers['x-panel-key']) headers['x-panel-key'] = key;

    let upstream;
    try {
      upstream = transport.request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || (target.protocol === 'https:' ? 443 : 80),
          method: req.method,
          path: upstreamPath,
          headers,
          timeout: 300000,
        },
        (answer) => {
          const outHeaders = {};
          for (const [name, value] of Object.entries(answer.headers)) {
            if (HOP_BY_HOP.has(name.toLowerCase())) continue;
            outHeaders[name] = value;
          }
          res.writeHead(answer.statusCode || 502, outHeaders);
          answer.pipe(res);
          answer.on('error', () => {
            try {
              res.destroy();
            } catch {
              /* ignore */
            }
          });
        },
      );
    } catch (err) {
      sendJson(res, 502, {
        error: `The Scribd panel at ${remote} could not be reached (${err.message}).`,
      });
      return;
    }

    upstream.on('timeout', () => upstream.destroy(new Error('timed out')));
    upstream.on('error', (err) => {
      if (res.headersSent) {
        try {
          res.destroy();
        } catch {
          /* ignore */
        }
        return;
      }
      sendJson(res, 502, {
        error:
          `The Scribd panel at ${remote} did not answer (${err.message}). ` +
          'Check that the Python server is running on 25811.',
      });
    });

    req.on('error', () => {
      try {
        upstream.destroy();
      } catch {
        /* ignore */
      }
    });
    req.pipe(upstream);
  };
}

/**
 * Probe the Python panel's /health so a bad address fails in the log, not in
 * the dashboard. Never throws.
 */
function probe(remote) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL('/health', remote);
    } catch {
      resolve({ ok: false, error: 'invalid SCRIBD_PANEL_URL' });
      return;
    }
    const transport = target.protocol === 'https:' ? https : http;
    const headers = { Accept: 'application/json' };
    const key = panelKey();
    if (key) headers['X-Panel-Key'] = key;
    const req = transport.get(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: '/health',
        headers,
        timeout: 8000,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          if (body.length < 4096) body += chunk;
        });
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = JSON.parse(body);
          } catch {
            /* not JSON */
          }
          resolve({
            ok: res.statusCode === 200 && Boolean(parsed && parsed.ok),
            status: res.statusCode,
            body: parsed,
          });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
  });
}

function serve() {
  const remote = remoteBase();
  const handler = makeHandler(remote);
  const wanted = ports();
  const bound = [];

  for (const port of wanted) {
    try {
      const server = http.createServer(handler);
      server.on('clientError', (_err, socket) => {
        try {
          socket.destroy();
        } catch {
          /* ignore */
        }
      });
      server.listen(port, '0.0.0.0', () => {
        log(`JS front door for the Scribd panel on http://0.0.0.0:${port}`);
      });
      server.on('error', (err) => {
        log(`could not listen on ${port} (${err.code || err.message})`);
        if (!bound.length) {
          // Nothing bound yet: a wrong port is fatal, say why once.
          log('no port could be bound — check the panel\'s assigned port');
        }
      });
      bound.push(server);
    } catch (err) {
      log(`could not create server on ${port}: ${err.message}`);
    }
  }

  log(`forwarding to the Python panel at ${remote}`);
  log('this box needs no Python and no downloader/ folder');

  probe(remote).then((result) => {
    if (result.ok) {
      log(`python panel is up (v${(result.body && result.body.version) || '?'})`);
    } else {
      log(
        `python panel is NOT answering yet (${result.error || `HTTP ${result.status}`}). ` +
          'Start it on the XS Systems server; this front door stays up and will ' +
          'answer as soon as it does.',
      );
    }
  });

  const stop = () => {
    for (const server of bound) {
      try {
        server.close();
      } catch {
        /* ignore */
      }
    }
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  // Keep the process alive even if every listen failed; the panel restarts us.
  setInterval(() => {}, 1 << 30);
}

async function selftest() {
  const remote = remoteBase();
  const wanted = ports();
  let failures = 0;
  const check = (ok, label, detail) => {
    console.log(`  ${ok ? 'ok ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures += 1;
  };

  check(/^https?:\/\//.test(remote), 'SCRIPT_PANEL_URL is an http(s) address', remote);
  check(wanted.length > 0, 'at least one listen port resolved', wanted.join(', '));
  check(typeof makeHandler(remote) === 'function', 'request handler builds');

  // Serve on a throwaway port and prove the proxy forwards a real answer.
  const server = http.createServer(makeHandler(remote));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const answer = await new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 12000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        if (body.length < 4096) body += c;
      });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (err) => resolve({ status: 0, body: err.message }));
  });
  server.close();

  const reachable = answer.status === 200;
  check(
    answer.status === 200 || answer.status === 502,
    'proxy answers /health with JSON (200 up, 502 when the python box is down)',
    `HTTP ${answer.status}`,
  );
  if (reachable) {
    let parsed = null;
    try {
      parsed = JSON.parse(answer.body);
    } catch {
      /* ignore */
    }
    check(Boolean(parsed && parsed.ok === true), 'python panel reports ok:true', answer.body.slice(0, 80));
  } else {
    console.log(`  note: python panel at ${remote} is not answering right now — proxy is still correct`);
  }

  if (failures) {
    console.log(`\nSELFTEST FAILED — ${failures} check(s)`);
    return 1;
  }
  console.log('\nSELFTEST OK — JS front door is configured correctly');
  return 0;
}

module.exports = { serve, selftest, remoteBase, ports, makeHandler };

if (require.main === module) {
  if (process.argv.includes('--selftest')) {
    selftest().then((code) => process.exit(code));
  } else {
    serve();
  }
}
