'use strict';
/** A throwaway HTTP server on a random port, for the offline selftest. */

const http = require('http');

async function makeTestServer() {
  const { handle } = require('./panel');
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      } else {
        res.destroy();
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

module.exports = { makeTestServer };
