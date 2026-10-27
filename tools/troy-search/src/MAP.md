# troy-search source map

`index.js` is only the entry point. Each file under `src/` owns one
part of the service, so a failure points at one clear place.
See [`FUNCTIONS.md`](./FUNCTIONS.md) for every function and its file.

| file | responsibility | exports |
|---|---|---|
| `src/config.js` | ports, panel address, UA, headers, timeouts, shared constants | 15 |
| `src/png.js` | PNG header parsing and blank-shot detection | 3 |
| `src/network.js` | plain HTTP fetch and refusal wording | 2 |
| `src/browser.js` | Chromium launch, cached browser, user agent, launch proof | 6 |
| `src/links.js` | Scribd link parsing, search-result parsing, panel link sending, picking | 10 |
| `src/search.js` | search engines, fetch/browser search and mode routing | 5 |
| `src/shots.js` | page measurement, /shot request rules, screenshot capture | 12 |
| `src/page.js` | the browser UI HTML served at / | 1 |
| `src/http.js` | HTTP helpers and all server routes | 1 |
| `src/selftest.js` | offline regression checks across every module | 1 |
| `src/cli.js` | terminal search/send command | 1 |
