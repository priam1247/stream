# troy-search function index

Every top-level declaration and the module that owns it. Private helpers
are included, so an error in any named function points at one file.

| file | top-level declarations |
|---|---|
| `src/browser.js` | `askedUA`, `userAgentOf`, `browserPromise`, `getBrowser`, `closeBrowser`, `launchProof`, `browserFacts`, `browserStatus`, `forgetBrowser` |
| `src/cli.js` | `runCli` |
| `src/config.js` | `VERSION`, `FALLBACK_PORT`, `listenPort`, `ASSIGNED_PORT`, `PORT`, `DEFAULT_PANEL`, `PANEL`, `UA`, `liveUA`, `refererFor`, `within`, `navOptions`, `MAX_SEND`, `DOC_LINK`, `DOC_ID` |
| `src/http.js` | `json`, `html`, `readJson`, `serve` |
| `src/links.js` | `documentLinks`, `parseAnchors`, `unwrap`, `strip`, `htmlDecode`, `parseScribdJson`, `panelOrigin`, `headline`, `sendToPanel`, `picked` |
| `src/network.js` | `refusal`, `fetchText` |
| `src/page.js` | `CONFIG`, `PAGE`, `$`, `esc`, `collect`, `count`, `row`, `find`, `send`, `facts` |
| `src/png.js` | `BLANK_BYTES_PER_ROW`, `pngSize`, `blankShot` |
| `src/search.js` | `ENGINES`, `engineOrder`, `searchWithFetch`, `searchWithBrowser`, `search` |
| `src/selftest.js` | `SRC_DIR`, `PRODUCTION_FILES`, `allSource`, `serveSource`, `selftest` |
| `src/shots.js` | `SHOT_WIDTH`, `SHOT_HEIGHT`, `SHOT_SCALE`, `SHOT_WAIT_MS`, `SHOT_TABS`, `shotUrl`, `pickPageBox`, `measurePage`, `shotAsk`, `shotRunning`, `shotWaiting`, `shotSlot`, `shootPage`, `JS_PAGE_RECTS` |
