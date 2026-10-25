# Scribd Library inside the ZaFar Control Room (neww)

Wires the Python panel (`tools/scribd_download.py`, this repo) into the
dashboard in `priam1247/neww`, so searching Scribd, downloading a book, watching
progress and saving the finished PDF all happen inside the dashboard — no second
tab, no copy-pasting file names.

Everything here was typechecked and built **inside the real `neww` dashboard**
(`npm ci && npm run typecheck && npm run build`), and the client was run against
a live panel:

```
status ok: true  PDF BUILT | 6 sheet(s) … 6 of 6 page(s) real · verified
health:    {"ok":true,"version":"2.12","locked":true,"state":"done"}
files:     [{"name":"Doc.pdf","bytes":36061,"when":1792921043}]
find ok:   true  2 document(s) found
run:       {"ok":true,"queued":1}
```

## The shape of it

```
browser ──▶ dashboard /api/scribd/*  ──▶ panel http://195.123.189.187:25811
            (your session cookie,          (X-Panel-Key if locked,
             server-side fetch)             one origin, no CORS)
```

The browser only ever talks to the dashboard. That is deliberate:

- the panel key never reaches a page,
- an `http://` panel inside an `https://` dashboard is not mixed content,
  because the **server** makes the call, not the browser,
- no CORS entry is needed (CORS is only for browser-to-browser origins),
- the PDF is streamed through the dashboard, so the Save button is on your own
  origin and is authorised by the session you already have.

## Files to add to `priam1247/neww`

Copy each file to the same path under `dashboard/`:

| file | what it is |
|---|---|
| `dashboard/lib/scribd-types.ts` | the JSON shapes the panel answers, nothing guessed |
| `dashboard/lib/scribd-panel.ts` | server-side client: URL + key + plain-word errors |
| `dashboard/lib/scribd-guard.ts` | one session gate for all five routes |
| `dashboard/app/api/scribd/status/route.ts` | the job + "is the panel online" |
| `dashboard/app/api/scribd/run/route.ts` | start a download (admin only by default) |
| `dashboard/app/api/scribd/find/route.ts` | Scribd's own search |
| `dashboard/app/api/scribd/files/route.ts` | finished PDFs, newest first |
| `dashboard/app/api/scribd/file/route.ts` | the PDF itself, streamed |
| `dashboard/components/scribd-desk.tsx` | the card: search, tick, paste, progress, save |

## Two small edits (not new files)

1. `dashboard/components/member-portal.tsx` — apply `member-portal.patch`
   (`git apply member-portal.patch` from the `neww` root, or make the four edits
   by hand: add the `Library` icon import, import `ScribdDesk`, add `'scribd'`
   to `MemberTab`, `grid-cols-3` → `grid-cols-4`, insert the fourth nav button,
   and render `{tab === 'scribd' && <ScribdDesk />}`).
2. `dashboard/.env.example` — append the block from `env.additions.txt`.

## Environment

| variable | value |
|---|---|
| `SCRIBD_PANEL_URL` | `http://195.123.189.187:25811` (default if unset) |
| `SCRIBD_PANEL_KEY` | the panel's `PANEL_KEY` — **only if you locked the panel** |

On Vercel: Project → Settings → Environment Variables, then redeploy.

## On the panel side (this repo, v2.12)

```bash
PANEL_KEY=a-long-random-string       # optional, but the panel is on a public IP
SERVER_PORT=25811                    # what you already use
```

With `PANEL_KEY` set, every route except `/health` wants `X-Panel-Key` — which
the dashboard sends. Opening the panel yourself in a browser needs `?key=…`
once; that sets a `SameSite=Strict` cookie so the page keeps working.

`PANEL_ORIGIN` is **not** needed for this setup. It exists only if you ever call
the panel directly from a browser instead of through the dashboard.

## Who may do what

| route | who |
|---|---|
| `status`, `files`, `file`, `find` | any signed-in member |
| `run` | administrator only |

The panel downloads with one Scribd session and runs one job at a time, so a
member starting a 400-page book would block everyone. To open it up, drop
`{ adminOnly: true }` in `app/api/scribd/run/route.ts`.

## When something is wrong

| what you see | what it means |
|---|---|
| `panel offline` badge | the dashboard's server cannot reach `SCRIBD_PANEL_URL` — check the server is running and the port is reachable |
| `The Scribd panel is locked and SCRIBD_PANEL_KEY is missing or wrong.` | the panel has `PANEL_KEY` set and the dashboard's value does not match |
| `The Scribd panel did not recognise that route.` | the panel is older than v2.12 — upload the new `tools/scribd_download.py` |
| `A download is already running on the panel.` | one job at a time, by design |
| Save works but the PDF is 30–150 MB | it is fetched into memory before saving; for books that large, download straight from the panel address |

## What was deliberately not done

- **No iframe of the panel.** Two designs were possible; this one keeps the key
  off the page and the styling native. If you ever want the raw panel in a tab
  instead, `http://195.123.189.187:25811/?embed=1&key=…` hides the bookmarklet
  card and the wide margins — but an `https://` dashboard cannot frame an
  `http://` page, so the native card is the one that works.
- **No cookies or keys in the browser.** The panel key and the Scribd session
  stay on the two servers.
- **No new dependency.** Next's own `fetch` does the work.
