/** Independent HTTP client for public providers; never inherit account state. */
const axios = require('axios');

function createPublicHttp(adapter) {
  const client = axios.create({ auth: null, params: null, proxy: false, ...(adapter ? { adapter } : {}) });
  // axios.create() copies global defaults. Replace, rather than merge, the
  // headers so a credential installed by another module cannot leak here.
  client.defaults.headers = {};
  return client;
}

const client = createPublicHttp();
const publicGet = (...args) => client.get(...args);
const credentialHeaders = Object.freeze({ Authorization: undefined, Cookie: undefined, 'Proxy-Authorization': undefined });

module.exports = { createPublicHttp, publicGet, credentialHeaders };
