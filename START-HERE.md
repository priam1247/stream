# START HERE — 4 steps, 5 minutes

Ignore every other file until these four steps work. The panel, Docker, the
tunnels: none of that is needed. This uses **GitHub's computer** to do the
downloading, so your data bundle only carries the finished PDF.

You need: your repo `priam1247/stream` open in a browser, and `cookies.txt` in
`C:\Users\troypriamu\Documents\stream`.

---

## Step 1. Give GitHub your Scribd login (once, ever)

Open **Git Bash** and run these two lines:

```bash
cd ~/Documents/stream
base64 -w0 cookies.txt | clip
```

`clip` copies it to your clipboard — you won't see anything, that's normal.

Now in the browser:

1. Go to **https://github.com/priam1247/stream/settings/secrets/actions/new**
2. **Name:** `SCRIBD_COOKIES_B64`
3. **Secret:** press **Ctrl+V** (pastes the clipboard)
4. Click **Add secret**

You will never do this again unless your Scribd login expires.

---

## Step 2. Ask for the documents

1. Go to **https://github.com/priam1247/stream/actions/workflows/scribd.yml**
2. Click the **Run workflow** button (right side) → a small form appears
3. Fill only two boxes:
   - **query:** what you want to search, e.g. `excel and succeed`
   - **limit:** `5` — or `0` to take everything the search finds
4. Leave every other box alone. Click **Run workflow**

A yellow dot appears on the new run. Wait. A 5-document run takes about 5–10
minutes; you can close the tab and come back.

---

## Step 3. Take your PDFs

1. Same page, click the newest run (top of the list)
2. Scroll to the bottom → **Artifacts** → **scribd-out-1.zip**
3. Download it, unzip it. Inside:

```
out/*.pdf                     the documents
out/search-<query>.txt        the list of results it found
out/manifest.jsonl            one line per document, with status ok/failed
```

Open a PDF. If it has all the pages, you're done — step 4 is optional.

---

## Step 4 (optional). Only some results, or your own links

- **Only result numbers 3 and 7:** put `3,7` in the **picks** box.
- **You already have the document links:** paste them into the **urls** box
  (space or comma separated) and leave **query** empty.
- **Just see what a search finds, no download:** tick **search_only**.

---

## If it does not work

| what you see | what it means | what to do |
| --- | --- | --- |
| red ✗ next to "Run" | a step failed | click the run → click the red step → copy the last 15 lines and send them to me |
| `no matching documents` | the search found nothing | check Step 1 was done; try a simpler word like `malawi`; tick **search_only** to see what it found |
| `401` / `403` / "login" in the log | cookies are stale | export `cookies.txt` from your browser again, repeat Step 1 |
| zip is empty or missing | nothing was produced | send me the log lines from that run |
| the button says "workflows aren't being run on this repository" | Actions are disabled | Settings → Actions → General → allow actions, then retry |

---

## Why this works when the panel didn't

GitHub's runner is a full Ubuntu machine with root, so it installs Chromium
**and** the system libraries Chromium needs. The panel's container lacks those
libraries (`libnspr4.so`), and a container without them can never start a
browser — that is the whole story of the errors you kept seeing.

Nothing on your PC downloads the document, so your bundle is not touched. You
download one zip at the end.
