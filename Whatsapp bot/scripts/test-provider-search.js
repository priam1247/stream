#!/usr/bin/env node
'use strict';

// All provider/search-engine HTTP and yt-dlp calls are stubbed. This suite tests
// parsing, routing and safety boundaries, not third-party availability.
const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const YT = require('../utils/youtubedl');
const search = require('../utils/providerSearch');

const examples = {
  bilibili: 'https://www.bilibili.com/video/BV1xx411c7mD',
  vimeo: 'https://vimeo.com/76979871',
  dailymotion: 'https://www.dailymotion.com/video/x7xyz',
  reddit: 'https://www.reddit.com/r/test/comments/abc123/example/',
  twitch: 'https://www.twitch.tv/videos/123456789',
  rumble: 'https://rumble.com/v1xyz-example.html',
  odysee: 'https://odysee.com/@example:1/title:2',
  weibo: 'https://www.weibo.com/1234567890/ABCxyz123',
  douyin: 'https://www.douyin.com/video/1234567890123456789',
  acfun: 'https://www.acfun.cn/v/ac12345678',
  youku: 'https://v.youku.com/v_show/id_XNTk2Mzc2OT.html',
  vk: 'https://vk.com/video-123456_789012',
  xiaohongshu: 'https://www.xiaohongshu.com/explore/123456789012345678901234',
  niconico: 'https://www.nicovideo.jp/watch/sm9',
};
const originals = { get: axios.get, post: axios.post, resolve: YT.resolveCommand, run: YT.run, base: YT.baseArgs, caps: YT.capabilities };
const success = (data) => ({ status: 200, data: typeof data === 'string' ? data : JSON.stringify(data) });
const denied = async () => { throw new Error('fixture: offline'); };

test.beforeEach(() => {
  axios.get = denied;
  axios.post = denied;
  YT.resolveCommand = () => null;
});
test.afterEach(() => {
  axios.get = originals.get;
  axios.post = originals.post;
  YT.resolveCommand = originals.resolve;
  YT.run = originals.run;
  YT.baseArgs = originals.base;
  YT.capabilities = originals.caps;
});

function duck(results) {
  return `<div class="results">${results.map(({ url, title }) =>
    `<a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(url)}">${title}</a>`).join('')}</div>`;
}
function brave(results) {
  return `<div id="results">${results.map(({ url, title }) =>
    `<div class="snippet"><a class="result-header" href="${url.replace(/&/g, '&amp;')}"><span class="snippet-title">${title}</span></a></div>`).join('')}</div>`;
}

test('exactly the 14 new provider shortcuts have searchable profiles', () => {
  assert.deepEqual(Object.keys(search.PROVIDERS).sort(), Object.keys(examples).sort());
});

for (const [site, url] of Object.entries(examples)) {
  test(`${site}: site-filtered index fallback returns only its own video URL`, async () => {
    const calls = [];
    axios.get = async (endpoint, opts) => {
      calls.push({ endpoint, opts });
      if (endpoint !== 'https://html.duckduckgo.com/html/') throw new Error('native unavailable');
      return success(duck([
        { url: 'https://attacker.example/redirect?to=' + encodeURIComponent(url), title: 'Offsite' },
        { url: examples[site === 'vimeo' ? 'youku' : 'vimeo'], title: 'Wrong provider' },
        { url, title: `A &amp; B ${site}` },
        { url, title: 'Duplicate' },
      ]));
    };
    const found = await search.searchProvider(site, 'the blood of youth s01e1', { limit: 5 });
    assert.equal(found.status, 'ok');
    assert.equal(found.source, 'duckduckgo');
    assert.equal(found.results.length, 1);
    assert.equal(found.results[0].url, url);
    assert.equal(found.results[0].title, `A & B ${site}`);
    const index = calls.find((call) => call.endpoint.includes('duckduckgo'));
    assert.ok(index.opts.params.q.includes('the blood of youth s01e1'));
    for (const scope of search.PROVIDERS[site].indexSites || search.PROVIDERS[site].domains) assert.ok(index.opts.params.q.includes(`site:${scope}`));
    assert.equal(index.opts.headers.Cookie, undefined);
    assert.equal(index.opts.headers.Authorization, undefined);
    assert.equal(index.opts.maxRedirects, 0);
    assert.equal(index.opts.timeout, 10000);
    assert.equal(index.opts.maxContentLength, 1024 * 1024);
  });
}

test('URL acceptance rejects spoofed hosts, credentials, ports, non-video paths and cross-provider results', () => {
  assert.equal(search.normalizeSiteUrl('youku', examples.vimeo), null);
  for (const url of [
    'https://v.youku.com.evil.example/v_show/id_XNTk2Mzc2OT.html',
    'https://evil.example/?next=https://v.youku.com/v_show/id_XNTk2Mzc2OT.html',
    'https://v.youku.com@evil.example/v_show/id_XNTk2Mzc2OT.html',
    'https://user:pass@v.youku.com/v_show/id_XNTk2Mzc2OT.html',
    'https://v.youku.com:8443/v_show/id_XNTk2Mzc2OT.html',
    'file:///v.youku.com/v_show/id_XNTk2Mzc2OT.html',
    'http://127.0.0.1/v_show/id_XNTk2Mzc2OT.html',
    'https://v.youku.com/search?q=anything',
    'https://v.youku.com/v_show/id_bad/path',
    'https://v.youku.com/redirect?next=http://localhost/',
  ]) assert.equal(search.normalizeSiteUrl('youku', url), null, url);
  assert.equal(search.normalizeSiteUrl('youku', examples.youku.replace('https:', 'http:')), examples.youku);
  assert.equal(search.normalizeSiteUrl('vimeo', 'https://vimeo.com/search?q=hello'), null);
  assert.equal(search.normalizeSiteUrl('twitch', 'https://www.twitch.tv/creator'), null);
  assert.equal(search.normalizeSiteUrl('odysee', 'https://odysee.com/$/search?q=video'), null);
  assert.equal(search.normalizeSiteUrl('bilibili', 'https://www.bilibili.tv/en/video/1234567890123'), 'https://www.bilibili.tv/en/video/1234567890123');
  assert.equal(search.normalizeSiteUrl('niconico', 'https://www.nicovideo.jp/search/sm9'), null);
});

test('HTTP search suppresses inherited Axios authorization and account cookies', async () => {
  const old = { adapter: axios.defaults.adapter, auth: axios.defaults.auth,
    authorization: axios.defaults.headers.common.Authorization, cookie: axios.defaults.headers.common.Cookie };
  axios.get = originals.get;
  axios.defaults.auth = { username: 'fixture', password: 'fixture' };
  axios.defaults.headers.common.Authorization = 'fixture';
  axios.defaults.headers.common.Cookie = 'fixture';
  axios.defaults.adapter = async (config) => {
    assert.equal(config.auth, null);
    assert.equal(config.headers.has('Authorization'), false);
    assert.equal(config.headers.has('Cookie'), false);
    return { status: 200, data: duck([{ url: examples.vimeo, title: 'Public result' }]), headers: {}, config };
  };
  try {
    assert.equal((await search.searchProvider('vimeo', 'title')).source, 'duckduckgo');
  } finally {
    axios.defaults.adapter = old.adapter;
    if (old.auth === undefined) delete axios.defaults.auth; else axios.defaults.auth = old.auth;
    if (old.authorization === undefined) delete axios.defaults.headers.common.Authorization; else axios.defaults.headers.common.Authorization = old.authorization;
    if (old.cookie === undefined) delete axios.defaults.headers.common.Cookie; else axios.defaults.headers.common.Cookie = old.cookie;
  }
});

test('DuckDuckGo unwraps exactly one encoding layer and ignores bad destinations', () => {
  const target = 'https://www.xiaohongshu.com/explore/123456789012345678901234?token=a%25b';
  const rows = search.parseDuck(duck([{ url: target, title: '<em>Result</em>' }]));
  assert.equal(rows[0].url, target);
  assert.equal(rows[0].title, 'Result');
  assert.equal(search.normalizeSiteUrl('xiaohongshu', rows[0].url), target);
  assert.throws(() => search.parseDuck('<html><body>challenge</body></html>'), /unavailable/);
});

test('Brave fallback parses result markup and does not trust its site filter', async () => {
  axios.get = async (endpoint, opts) => {
    if (endpoint.includes('duckduckgo')) return success('<html>consent challenge</html>');
    if (endpoint.includes('search.brave.com')) {
      assert.equal(opts.headers.Cookie, undefined);
      return success(brave([
        { url: examples.youku, title: 'Real result' },
        { url: examples.vimeo, title: 'Wrong website' },
      ]));
    }
    throw new Error('offline');
  };
  const found = await search.searchProvider('youku', 'series');
  assert.equal(found.source, 'brave');
  assert.deepEqual(found.results.map((r) => r.url), [examples.youku]);
  assert.throws(() => search.parseBrave('<html><body>challenge</body></html>'), /unavailable/);
  assert.equal(search.parseBrave(`<main id="results"><a href="${examples.youku}">Alternative markup</a></main>`)[0].url, examples.youku);
});

test('Firecrawl keyless fallback can scope to the video path and validates every returned URL', async () => {
  axios.get = async () => { throw new Error('other sources offline'); };
  axios.post = async (endpoint, body, opts) => {
    assert.equal(endpoint, 'https://api.firecrawl.dev/v2/search');
    assert.equal(body.includeDomains, undefined);
    assert.deepEqual(body.sources, ['web']);
    assert.equal(body.query, 'cat site:douyin.com/video');
    assert.equal(body.limit, 9);
    assert.equal(body.timeout, 9000);
    assert.equal(opts.maxRedirects, 0);
    assert.equal(opts.timeout, 10000);
    assert.equal(opts.headers.Cookie, undefined);
    assert.equal(opts.headers.Authorization, undefined);
    assert.equal(opts.auth, null);
    return success({ success: true, data: { web: [
      { url: examples.vimeo, title: 'Wrong site' },
      { url: 'https://www.douyin.com/search/cat', title: 'Not a video' },
      { url: examples.douyin, title: 'A Douyin video' },
      { url: examples.douyin, title: 'Duplicate' },
    ] } });
  };
  const found = await search.searchProvider('douyin', 'cat', { limit: 3 });
  assert.equal(found.source, 'firecrawl');
  assert.deepEqual(found.results.map((r) => r.url), [examples.douyin]);
});

test('Firecrawl uses hostname filters for providers without a narrower video path', async () => {
  axios.get = denied;
  axios.post = async (_endpoint, body) => {
    assert.equal(body.query, 'cat');
    assert.deepEqual(body.includeDomains, ['vimeo.com']);
    return success({ success: true, data: { web: [{ url: examples.vimeo, title: 'Vimeo video' }] } });
  };
  const found = await search.searchProvider('vimeo', 'cat');
  assert.equal(found.source, 'firecrawl');
  assert.equal(found.results[0].url, examples.vimeo);
});

test('Firecrawl errors, changed schemas and rate limits remain bounded failures', async () => {
  for (const response of [
    success({ success: false }),
    success({ success: true, data: {} }),
    { status: 429, data: 'rate limited' },
    success('x'.repeat(1024 * 1024 + 1)),
  ]) {
    axios.get = denied;
    axios.post = async () => response;
    assert.equal((await search.searchProvider('vimeo', 'title')).status, 'unavailable');
  }
});

test('empty, unavailable, invalid, HTTP challenges and oversized bodies have distinct bounded outcomes', async () => {
  axios.get = async (endpoint) => endpoint.includes('duckduckgo') ? success('<div class="no-results"></div>') : denied();
  assert.equal((await search.searchProvider('vimeo', 'nonexistent')).status, 'empty');
  axios.get = async () => ({ status: 202, data: '<div class="no-results"></div>' });
  assert.equal((await search.searchProvider('vimeo', 'blocked')).status, 'unavailable');
  axios.get = async () => success('x'.repeat(1024 * 1024 + 1));
  assert.equal((await search.searchProvider('vimeo', 'oversized')).status, 'unavailable');
  assert.equal((await search.searchProvider('vimeo', 'x'.repeat(201))).status, 'invalid');
  assert.equal((await search.searchProvider('vimeo', '  ')).status, 'invalid');
  await assert.rejects(search.searchProvider('madeup', 'x'), /Unknown provider/);
});

test('Bilibili native API returns titles with only an anonymous generated cookie', async () => {
  let called = 0;
  axios.get = async (endpoint, opts) => {
    called++;
    assert.equal(endpoint, 'https://api.bilibili.com/x/web-interface/search/type');
    assert.equal(opts.params.keyword, '猫');
    assert.match(opts.headers.Cookie, /^buvid3=[0-9a-f-]+infoc$/);
    assert.equal(opts.headers.Authorization, undefined);
    return success({ code: 0, data: { result: [
      { arcurl: examples.bilibili, title: '<em>猫</em> video', author: 'A' },
      { arcurl: examples.vimeo, title: 'wrong host' },
    ] } });
  };
  const found = await search.searchProvider('bilibili', '猫');
  assert.equal(called, 1);
  assert.equal(found.source, 'provider');
  assert.equal(found.results[0].title, '猫 video');
  assert.equal(found.results[0].author, 'A');
  assert.equal(found.results.length, 1);
});

test('Bilibili can retry a 412 with a validated anonymous session, never account cookies', async () => {
  let attempts = 0;
  axios.get = async (endpoint, opts) => {
    if (endpoint.endsWith('/spi')) {
      assert.equal(opts.headers.Cookie, undefined);
      return success({ code: 0, data: { b_3: 'anonymous-12345678', b_4: 'another+/token==' } });
    }
    assert.ok(endpoint.endsWith('/search/type'));
    attempts++;
    if (attempts === 1) throw Object.assign(new Error('blocked'), { response: { status: 412 } });
    assert.equal(opts.headers.Cookie, 'buvid3=anonymous-12345678; buvid4=another+/token==');
    return success({ code: 0, data: { result: [{ arcurl: examples.bilibili, title: 'Bilibili video' }] } });
  };
  const found = await search.searchProvider('bilibili', 'title');
  assert.equal(attempts, 2);
  assert.equal(found.source, 'provider');
  assert.equal(found.results[0].url, examples.bilibili);
});

test('Bilibili never puts invalid anonymous session values in a request header', async () => {
  let searches = 0;
  axios.get = async (endpoint) => {
    if (endpoint.endsWith('/spi')) return success({ code: 0, data: { b_3: 'anonymous-12345678', b_4: 'evil;Injected=1' } });
    if (endpoint.includes('/search/type')) {
      searches++;
      return success({ code: -412 });
    }
    if (endpoint.includes('duckduckgo')) return success(duck([{ url: examples.bilibili, title: 'Fallback' }]));
    throw new Error('offline');
  };
  const found = await search.searchProvider('bilibili', 'title');
  assert.equal(searches, 1);
  assert.equal(found.source, 'duckduckgo');
});

test('Youku searches its endpoint, retries the series name, and prioritizes only a returned requested episode', async () => {
  const calls = [];
  axios.get = async (endpoint, opts) => {
    assert.equal(endpoint, 'https://search.youku.com/api/search');
    calls.push(opts.params.keyword);
    if (calls.length === 1) return success({ message: 'success', originNodes: [] });
    return success({ message: 'success', originNodes: [{ nodes: [
      { data: { videoId: 'XABC2', title: 'Drama 02', orderId: 2 } },
      { data: { videoId: 'XABC1', title: 'Drama 01', orderId: 1 } },
      { data: { videoId: 'not/a/video', title: 'bad', orderId: 3 } },
      { data: { hasYouku: 0, videoId: 'XNOPE', title: 'Not Youku' } },
    ] }] });
  };
  const found = await search.searchProvider('youku', 'the blood of youth s01e1');
  assert.deepEqual(calls, ['the blood of youth s01e1', 'the blood of youth']);
  assert.equal(found.source, 'provider');
  assert.deepEqual(found.results.map((r) => r.title), ['Drama 01', 'Drama 02']);
  assert.deepEqual(found.results.map((r) => r.url), ['https://v.youku.com/v_show/id_XABC1.html', 'https://v.youku.com/v_show/id_XABC2.html']);
  assert.equal(search.requestedEpisode('show s02e03').number, 3);
});

test('Youku can resolve an exact English episode query to an original Chinese title without leaving Youku', async () => {
  const calls = [];
  axios.get = async (endpoint, opts) => {
    calls.push([endpoint, opts.params]);
    if (endpoint === 'https://search.youku.com/api/search') {
      if (opts.params.keyword !== '少年歌行') return success({ message: 'success', originNodes: [], pageComponentList: [] });
      // Shape modeled on the site's pageComponentList, including padded IDs and
      // displayName/showVideoStage instead of an orderId field.
      return success({ message: 'success', originNodes: [], pageComponentList: [{ componentMap: {
        1035: { data: [
          { videoId: 'XABC2==', title: '少年歌行 02', showVideoStage: '2' },
          { videoId: 'XABC1==', title: '少年歌行 01', showVideoStage: '1' },
        ] },
      } }] });
    }
    if (endpoint === 'https://api.tvmaze.com/search/shows') {
      assert.deepEqual(opts.params, { q: 'the blood of youth' });
      assert.equal(opts.headers.Cookie, undefined);
      assert.equal(opts.timeout, 6000);
      return success([
        { show: { id: 12345, name: 'The Blood of Youth', webChannel: { name: 'Youku' } } },
        { show: { id: 54321, name: 'The Blood of Youth: sequel', webChannel: { name: 'Youku' } } },
      ]);
    }
    if (endpoint === 'https://api.tvmaze.com/shows/12345/akas') {
      return success([{ name: '少年歌行', country: { code: 'CN' } }, { name: 'Different title', country: null }]);
    }
    throw new Error('unexpected network call');
  };
  const found = await search.searchProvider('youku', 'the blood of youth s01e1');
  assert.equal(found.source, 'provider');
  assert.deepEqual(found.results.map((r) => r.title), ['少年歌行 01', '少年歌行 02']);
  assert.equal(found.results[0].url, 'https://v.youku.com/v_show/id_XABC1==.html');
  assert.deepEqual(calls.filter(([endpoint]) => endpoint.includes('youku.com')).map(([, params]) => params.keyword), [
    'the blood of youth s01e1', 'the blood of youth', '少年歌行',
  ]);
});

test('uncertain TV metadata is not used to invent or silently change provider results', async () => {
  const calls = [];
  axios.get = async (endpoint, opts) => {
    calls.push(endpoint);
    if (endpoint.includes('youku.com')) return success({ message: 'success', originNodes: [] });
    if (endpoint.endsWith('/search/shows')) return success([
      { show: { id: 123, name: 'The Blood of Youth sequel', webChannel: { name: 'Youku' } } },
    ]);
    if (endpoint.includes('duckduckgo')) {
      assert.ok(opts.params.q.includes('the blood of youth s01e1'));
      return success(duck([{ url: examples.youku, title: 'A public Youku result' }]));
    }
    throw new Error('offline');
  };
  const found = await search.searchProvider('youku', 'the blood of youth s01e1');
  assert.equal(found.source, 'duckduckgo');
  assert.equal(calls.some((url) => url.includes('/akas')), false);
});

test('ambiguous duplicate exact shows and malformed metadata never trigger an alias request', async () => {
  for (const shows of [
    [
      { show: { id: 1, name: 'The Blood of Youth', webChannel: { name: 'Youku' } } },
      { show: { id: 2, name: 'The Blood of Youth', webChannel: { name: 'Youku' } } },
    ],
    [{ show: { id: '../../elsewhere', name: 'The Blood of Youth', webChannel: { name: 'Youku' } } }],
    [{ show: { id: 123, name: 'The Blood of Youth', webChannel: { name: 'Another site' } } }],
  ]) {
    let askedAliases = false;
    axios.get = async (endpoint) => {
      if (endpoint.includes('youku.com')) return success({ message: 'success', originNodes: [] });
      if (endpoint.endsWith('/search/shows')) return success(shows);
      if (endpoint.includes('/akas')) { askedAliases = true; throw new Error('unexpected'); }
      if (endpoint.includes('duckduckgo')) return success(duck([{ url: examples.youku, title: 'Original query' }]));
      throw new Error('offline');
    };
    assert.equal((await search.searchProvider('youku', 'the blood of youth s01e1')).source, 'duckduckgo');
    assert.equal(askedAliases, false);
  }
});

test('TVMaze timeout or bad response is bounded and leaves original-query fallback available', async () => {
  for (const failure of ['timeout', 'bad-json']) {
    const visited = [];
    axios.get = async (endpoint, opts) => {
      visited.push(endpoint);
      if (endpoint.includes('youku.com')) return success({ message: 'success', originNodes: [] });
      if (endpoint.endsWith('/search/shows')) {
        assert.equal(opts.timeout, 6000);
        assert.equal(opts.maxRedirects, 0);
        if (failure === 'timeout') throw Object.assign(new Error('timeout'), { code: 'ECONNABORTED' });
        return success('{broken');
      }
      if (endpoint.includes('duckduckgo')) return success(duck([{ url: examples.youku, title: 'Fallback' }]));
      throw new Error('offline');
    };
    assert.equal((await search.searchProvider('youku', 'the blood of youth s01e1')).source, 'duckduckgo');
    assert.equal(visited.some((url) => url.includes('/akas')), false);
  }
});

test('a localized Youku title can fall back to the site-filtered index if Youku returns no episode', async () => {
  axios.get = async (endpoint, opts) => {
    if (endpoint.includes('youku.com')) return success({ message: 'success', originNodes: [] });
    if (endpoint.endsWith('/search/shows')) return success([{ show: { id: 12345, name: 'The Blood of Youth', webChannel: { name: 'Youku' } } }]);
    if (endpoint.endsWith('/akas')) return success([{ name: '少年歌行', country: { code: 'CN' } }]);
    if (endpoint.includes('duckduckgo')) {
      assert.ok(opts.params.q.includes('少年歌行 第1集'));
      return success(duck([{ url: examples.youku, title: 'Episode 1' }]));
    }
    throw new Error('offline');
  };
  assert.equal((await search.searchProvider('youku', 'the blood of youth s01e1')).source, 'duckduckgo');
});

test('Youku validates both possible result layouts and fails on a changed schema', () => {
  const rows = search.parseYouku({ message: 'success', originNodes: [], pageComponentList: [{ data: { videoId: 'XAbc', title: 'Episode' } }] });
  assert.equal(rows.length, 1);
  assert.throws(() => search.parseYouku({ message: 'success', data: [] }), /unavailable/);
  assert.throws(() => search.parseYouku({ message: 'captcha', originNodes: [] }), /unavailable/);
});

test('AcFun, Reddit, Rumble and Odysee native responses use individually validated videos', async () => {
  axios.get = async (endpoint) => {
    if (endpoint.includes('api-new.app.acfun.cn')) return success({ result: 0, videoList: [
      { contentId: '12345678', title: 'AcFun title', userName: 'Creator' }, { contentId: '../evil', title: 'bad' },
    ] });
    if (endpoint.includes('reddit.com')) return success({ data: { children: [
      { data: { is_video: false, permalink: '/r/test/comments/aaa/image/', title: 'Image' } },
      { data: { is_video: true, permalink: '/r/test/comments/abc123/example/', title: 'Reddit video' } },
    ] } });
    if (endpoint.includes('rumble.com')) return success('<div class="video-list"><a class="video-item--a" href="/v1xyz-example.html"><img alt="Rumble video"></a></div>');
    throw new Error('offline');
  };
  let rpc;
  axios.post = async (endpoint, body, opts) => {
    assert.equal(endpoint, 'https://api.na-backend.odysee.com/api/v1/proxy');
    assert.equal(opts.headers.Authorization, undefined);
    assert.equal(opts.maxRedirects, 0);
    rpc = body;
    return success({ result: { items: [{ canonical_url: 'lbry://@example#1/title#2', value: { title: 'Odysee title', video: { duration: 42 } } }] } });
  };
  for (const site of ['acfun', 'reddit', 'rumble', 'odysee']) {
    const result = await search.searchProvider(site, 'a title');
    assert.equal(result.source, 'provider', site);
    assert.equal(result.results.length, 1, site);
    assert.equal(result.results[0].url, examples[site], site);
  }
  assert.equal(rpc.method, 'claim_search');
  assert.equal(rpc.params.text, 'a title');
});

test('Dailymotion and Niconico public APIs return validated video titles and durations', async () => {
  axios.get = async (endpoint, opts) => {
    assert.equal(opts.headers.Cookie, undefined);
    assert.equal(opts.headers.Authorization, undefined);
    assert.equal(opts.maxRedirects, 0);
    if (endpoint === 'https://api.dailymotion.com/videos') {
      assert.equal(opts.params.search, 'cat');
      assert.equal(opts.params.limit, 9);
      return success({ list: [
        { id: 'x7xyz', title: 'Daily title', url: examples.dailymotion, duration: 42, 'owner.screenname': 'Creator' },
        { id: 'x7other', title: 'Wrong host', url: examples.vimeo },
        { id: '../bad', title: 'Bad video' },
      ] });
    }
    assert.ok(endpoint.startsWith('https://snapshot.search.nicovideo.jp/'));
    assert.equal(opts.params.q, 'cat');
    assert.equal(opts.params._limit, 9);
    return success({ meta: { status: 200 }, data: [
      { contentId: 'sm9', title: 'Nico title', lengthSeconds: 63 },
      { contentId: '../bad', title: 'Bad video' },
    ] });
  };
  const daily = await search.searchProvider('dailymotion', 'cat', { limit: 3 });
  const nico = await search.searchProvider('niconico', 'cat', { limit: 3 });
  assert.equal(daily.source, 'provider');
  assert.equal(daily.results.length, 1);
  assert.equal(nico.results.length, 1);
  assert.equal(daily.results[0].url, examples.dailymotion);
  assert.equal(daily.results[0].duration, 42);
  assert.equal(daily.results[0].author, 'Creator');
  assert.equal(nico.source, 'provider');
  assert.equal(nico.results[0].url, examples.niconico);
  assert.equal(nico.results[0].duration, 63);
});

test('Niconico can fall back to bounded yt-dlp search with JSON-encoded fields and no shell', async () => {
  YT.resolveCommand = () => ['yt-dlp'];
  YT.baseArgs = () => ['--no-playlist', '--ignore-config', '--cookies', '/private/cookies'];
  YT.capabilities = () => ({ noCheckFormats: true });
  let call;
  YT.run = async (args, options) => {
    call = { args, options };
    const parts = [examples.niconico, null, 'video-id', 'Title\twith\nlines', 120, 'Author'];
    return { stdout: parts.map((x) => x === null ? 'NA' : JSON.stringify(x)).join('\t'), stderr: '' };
  };
  const found = await search.searchProvider('niconico', 'a title --ignored ; $(not a shell)', { limit: 3 });
  assert.equal(found.source, 'provider');
  assert.equal(found.results[0].title, 'Title with lines');
  assert.equal(call.options.timeout, 30000);
  assert.ok(call.args.includes('--no-flat-playlist'));
  assert.ok(call.args.includes('--ignore-errors'));
  assert.ok(!call.args.includes('--no-playlist'));
  assert.equal(call.args[call.args.length - 2], '--');
  assert.equal(call.args.at(-1), 'nicosearch3:a title --ignored ; $(not a shell)');
});

test('partial yt-dlp output survives a timeout; offsite rows never pass validation', async () => {
  YT.resolveCommand = () => ['yt-dlp'];
  YT.baseArgs = () => ['--no-playlist'];
  YT.capabilities = () => ({});
  YT.run = async () => {
    const record = (url) => [url, null, 'id', 'Result', 20, ''].map((x) => x === null ? 'NA' : JSON.stringify(x)).join('\t');
    throw Object.assign(new Error('timeout'), { stdout: `${record(examples.vimeo)}\n${record(examples.niconico)}` });
  };
  const result = await search.searchProvider('niconico', 'video');
  assert.equal(result.source, 'provider');
  assert.deepEqual(result.results.map((r) => r.url), [examples.niconico]);
});

test('malicious title markup and control characters cannot forge picker lines', () => {
  const rows = search.normalizeRows('youku', [{ url: examples.youku, title: 'Hello<br>*.9 fake*\u202e\nWorld', author: '<b>Person</b>' }], 5);
  assert.equal(rows[0].title, 'Hello.9 fake World');
  assert.equal(rows[0].author, 'Person');
  assert.equal(rows[0].title.includes('\n'), false);
});
