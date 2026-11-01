'use strict';

// Temporary probe: forced public API failure, anonymous Deezer session and
// mocked account check. Only metadata is requested; no user ARL or audio.
const axios = require('axios');
const { createClient, diagnosticCode, diagnosticDetails } = require('../utils/deezer');
const GATEWAY = 'https://www.deezer.com/ajax/gw-light.php';
const options = { timeout: 15000, maxRedirects: 0, validateStatus: () => true,
  headers: { 'User-Agent': 'Mozilla/5.0 Deezer source comparison', Accept: 'application/json' } };
const notice = (text) => console.log(`::notice title=Anonymous Deezer comparison::${text}`);
const safe = (err) => {
  const { stage, status, reason } = diagnosticDetails(err);
  return [diagnosticCode(err?.code), stage, status, reason].filter(Boolean).join(' ');
};

(async () => {
  const ping = await axios.get(`${GATEWAY}?method=deezer.ping&api_version=1.0&api_token=`, options);
  if (ping.status !== 200 || !ping.data?.results?.SESSION) return notice(`bot gateway live probe: guest ping HTTP ${ping.status}`);
  const sid = ping.data.results.SESSION;
  const user = await axios.get(`${GATEWAY}?method=deezer.getUserData&api_version=1.0&api_token=`, {
    ...options, headers: { ...options.headers, Cookie: `sid=${sid}` },
  });
  const csrf = user.data?.results?.checkForm;
  if (user.status !== 200 || !csrf) return notice(`bot gateway live probe: guest bootstrap HTTP ${user.status}`);

  // The fake account response satisfies the bot's account checks in this test
  // only. Actual gateway calls below use the anonymous sid, not a user ARL.
  const fakeHttp = {
    async get(url) {
      if (url.startsWith('https://api.deezer.com/')) throw Object.assign(new Error('synthetic public API failure'), { code: 'ECONNRESET' });
      if (!url.startsWith(`${GATEWAY}?method=deezer.getUserData`)) throw new Error('unexpected probe request');
      return { status: 200, data: { error: [], results: {
        SESSION_ID: sid, checkForm: csrf, USER: { USER_ID: '1', OPTIONS: { license_token: 'SYNTHETIC_UNUSED' } },
      } } };
    },
    async post(url, body, opts) {
      const parsed = new URL(url);
      if (`${parsed.origin}${parsed.pathname}` !== GATEWAY || !['search.music', 'song.getListData'].includes(parsed.searchParams.get('method'))) {
        throw new Error('unexpected probe endpoint');
      }
      return axios.post(url, body, { ...opts, headers: { ...opts.headers, Cookie: `sid=${sid}` } });
    },
  };
  const client = createClient({ http: fakeHttp, arl: 'SYNTHETIC_FAKE_ARL' });
  try {
    const rows = await client.search('Daft Punk One More Time', { limit: 2 });
    notice(`bot gateway fallback search (guest, mocked account): results=${rows.length}`);
  } catch (err) { notice(`bot gateway fallback search (guest, mocked account): ${safe(err)}`); }
  try {
    const row = await client.getTrack('3135553');
    notice(`bot gateway fallback metadata (guest, mocked account): exact_id=${row.id === '3135553'}`);
  } catch (err) { notice(`bot gateway fallback metadata (guest, mocked account): ${safe(err)}`); }
})().catch((err) => {
  notice(`bot gateway live probe: ${safe(err) || 'unavailable'}`);
});
