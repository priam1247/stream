"""Boundary-based Playwright Chromium screenshots and clean PDF assembly.

One browser tab, one navigation, every page forced to render, one screenshot per
Scribd page element boundary, then a lossless JPEG-to-PDF compile. No page-image
URL discovery, text layers, placeholders, scan windows, or PDF page heuristics.
"""

from __future__ import annotations

import io
import math
import os
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path

import img2pdf
from PIL import Image, ImageStat
from pypdf import PdfReader

try:
    from . import config, scribd
except ImportError:  # standalone folder run
    import config  # type: ignore[no-redef]
    import scribd  # type: ignore[no-redef]


class CaptureError(RuntimeError):
    """A clear reason a document could not be captured."""


@dataclass(frozen=True)
class CaptureResult:
    path: Path
    pages: int
    bytes: int
    seconds: float


INIT_JS = r"""
(() => {
  class ImmediateIntersectionObserver {
    constructor(callback, options) {
      this.callback = callback;
      this.options = options || {};
      this.root = this.options.root || null;
      this.rootMargin = this.options.rootMargin || '0px';
      this.thresholds = this.options.thresholds ? [].concat(this.options.thresholds) : [0];
    }
    observe(target) {
      const rect = target.getBoundingClientRect();
      const entry = {
        target,
        isIntersecting: true,
        intersectionRatio: 1,
        boundingClientRect: rect,
        intersectionRect: rect,
        rootBounds: null,
        time: Date.now(),
      };
      try { this.callback([entry], this); } catch (error) {}
    }
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  }
  window.IntersectionObserver = ImmediateIntersectionObserver;
  try {
    Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
    Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
  } catch (error) {}
  window.requestIdleCallback = window.requestIdleCallback || function (callback) {
    return setTimeout(function () {
      callback({ didTimeout: false, timeRemaining: () => 50 });
    }, 0);
  };
  const eagerImages = () => {
    for (const img of document.querySelectorAll('img')) {
      try {
        img.loading = 'eager';
        img.decoding = 'sync';
        img.fetchPriority = 'high';
        let source = img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-original') || img.getAttribute('data-url');
        if (source && !img.getAttribute('src')) {
          if (source.startsWith('//')) source = 'https:' + source;
          img.setAttribute('src', source);
        }
      } catch (error) {}
    }
  };
  try {
    new MutationObserver(eagerImages).observe(document, { childList: true, subtree: true });
  } catch (error) {}
  document.addEventListener('DOMContentLoaded', eagerImages, { once: true });
})();
"""

FORCE_RENDER_JS = r"""
async (arg) => {
  const expected = Number(arg && arg.expected) || 0;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const dm = window.docManager || (window.Scribd && window.Scribd.docManager);
  const all = dm && dm.pages ? Object.values(dm.pages).filter(Boolean) : [];
  const pages = expected ? all.slice(0, expected) : all;
  const loads = pages.map((page) => {
    try {
      return page && typeof page.load === 'function' ? page.load() : null;
    } catch (error) {
      return null;
    }
  });
  await Promise.race([Promise.allSettled(loads), sleep(2500)]);
  for (const page of pages) {
    try { if (page.display) page.display(); } catch (error) {}
    try { if (page.turnOnImages) page.turnOnImages(); } catch (error) {}
  }
  const eager = () => {
    for (const img of document.querySelectorAll('img')) {
      try {
        img.loading = 'eager';
        img.decoding = 'sync';
        img.fetchPriority = 'high';
        let source = img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-original') || img.getAttribute('data-url');
        if (source && !img.getAttribute('src')) {
          if (source.startsWith('//')) source = 'https:' + source;
          img.setAttribute('src', source);
        }
      } catch (error) {}
    }
  };
  eager();
  const scroller = document.querySelector('.document_scroller') || document.scrollingElement || document.documentElement;
  const height = Math.max(
    scroller.scrollHeight || 0,
    document.body ? document.body.scrollHeight : 0,
    document.documentElement.scrollHeight || 0,
    window.innerHeight
  );
  for (let step = 1; step <= 10; step++) {
    try { scroller.scrollTop = Math.ceil(height * step / 10); } catch (error) {}
    try { window.scrollTo(0, scroller.scrollTop); } catch (error) {}
    await sleep(25);
  }
  try { scroller.scrollTop = 0; } catch (error) {}
  try { window.scrollTo(0, 0); } catch (error) {}
  eager();
  try {
    await Promise.race([document.fonts.ready, sleep(1500)]);
  } catch (error) {}
  await sleep(80);
  return { manager: pages.length, nodes: document.querySelectorAll('[data-page-number], .outer_page, [id^="page-"]').length };
}
"""

PAGE_COUNT_JS = r"""
() => {
  const dm = window.docManager || (window.Scribd && window.Scribd.docManager);
  const attrs = dm && (dm.docAttributes || dm.attributes);
  const values = [
    attrs && attrs.page_count,
    attrs && attrs.pageCount,
    dm && dm.page_count,
    window.page_count,
    window.pageCount,
    window.Scribd && window.Scribd.page_count,
  ];
  for (const value of values) {
    const count = parseInt(value, 10);
    if (count > 0) return count;
  }
  const marked = document.querySelector('[data-page-count], [data-total-pages]');
  if (marked) {
    const count = parseInt(marked.getAttribute('data-page-count') || marked.getAttribute('data-total-pages'), 10);
    if (count > 0) return count;
  }
  const match = document.documentElement.innerHTML.match(/"(?:page_count|pageCount|totalPages|pages_count)"\s*:\s*(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}
"""

BOUNDARIES_JS = r"""
(arg) => {
  const expected = Number(arg && arg.expected) || 0;
  const selectors = [
    '[data-page-number]',
    '[data-page]',
    '[data-page-num]',
    '[id^="page-"]',
    '[id^="outer_page_"]',
    '.outer_page',
    '[class*="outer_page"]',
    '.page_container',
    '[class*="page_container"]',
    '.doc_page',
    '[class*="doc_page"]',
    '.page',
  ];
  const nodes = new Set();
  for (const selector of selectors) {
    try {
      for (const element of document.querySelectorAll(selector)) nodes.add(element);
    } catch (error) {}
  }
  const raw = [];
  for (const element of nodes) {
    const rect = element.getBoundingClientRect();
    if (rect.width < 100 || rect.height < 100) continue;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    if (parseFloat(style.opacity || '1') === 0) continue;
    if (style.position === 'fixed' || style.position === 'sticky') continue;
    let number = parseInt(
      element.getAttribute('data-page-number') ||
      element.getAttribute('data-page') ||
      element.getAttribute('data-page-num') ||
      '',
      10
    );
    if (!number || number < 1) {
      const idMatch = (element.id || '').match(/(?:outer_page_|page[-_]?)(\d+)/i);
      if (idMatch) number = parseInt(idMatch[1], 10);
    }
    raw.push({
      el: element,
      number: number > 0 ? number : 0,
      left: rect.left + window.scrollX,
      right: rect.right + window.scrollX,
      top: rect.top + window.scrollY,
      bottom: rect.bottom + window.scrollY,
      width: rect.width,
      height: rect.height,
    });
  }
  const filtered = raw.filter((a) => !raw.some((b) =>
    b !== a && b.number && a.number !== b.number && a.el.contains(b.el)
  ));
  const groups = new Map();
  for (const item of filtered) {
    const key = item.number > 0 ? 'n' + item.number : 'y' + Math.round(item.top / 8);
    const previous = groups.get(key);
    if (!previous || item.width * item.height > previous.width * previous.height) {
      groups.set(key, item);
    }
  }
  let boxes = Array.from(groups.values()).sort((a, b) => a.top - b.top || a.left - b.left);
  if (expected > 0 && boxes.length > expected) boxes = boxes.slice(0, expected);
  boxes.forEach((box, index) => {
    box.number = box.number > 0 ? box.number : index + 1;
    try { box.el.setAttribute('data-shot-page', String(box.number)); } catch (error) {}
  });
  window.__shotPages = boxes;
  const docWidth = Math.max(
    document.documentElement.scrollWidth || 0,
    document.body ? document.body.scrollWidth : 0,
    window.innerWidth || 0,
    ...boxes.map((box) => box.right + 2)
  );
  const docHeight = Math.max(
    document.documentElement.scrollHeight || 0,
    document.body ? document.body.scrollHeight : 0,
    window.innerHeight || 0,
    ...boxes.map((box) => box.bottom + 2)
  );
  return {
    count: boxes.length,
    docWidth,
    docHeight,
    boxes: boxes.map((box) => ({
      number: box.number,
      left: box.left,
      right: box.right,
      top: box.top,
      bottom: box.bottom,
      width: box.width,
      height: box.height,
    })),
  };
}
"""

RENDER_READY_JS = r"""
(arg) => {
  const expected = Number(arg && arg.expected) || 0;
  const pages = window.__shotPages || [];
  if (!pages.length) return false;
  if (expected && pages.length < expected) return false;
  for (const page of pages.slice(0, expected || pages.length)) {
    const element = page.el;
    if (!element || !element.isConnected) return false;
    const images = Array.from(element.querySelectorAll('img'));
    const hasImage = images.some((img) => img.complete && img.naturalWidth > 0);
    const hasCanvas = !!element.querySelector('canvas');
    const hasSvg = !!element.querySelector('svg');
    const hasLayer = !!element.querySelector('.text_layer, .absimg, .image_layer');
    const text = (element.innerText || '').trim();
    const background = getComputedStyle(element).backgroundImage;
    const hasBackground = background && background !== 'none';
    if (!(hasImage || hasCanvas || hasSvg || hasLayer || hasBackground || text.length > 10)) {
      return false;
    }
  }
  return true;
}
"""

CLEAN_JS = r"""
() => {
  const pages = (window.__shotPages || []).map((page) => page.el).filter(Boolean);
  const insidePage = (element) => pages.some((page) => page === element || page.contains(element));
  const containsPage = (element) => pages.some((page) => element.contains(page));
  const bad = /osano|cookie|consent|banner|toolbar|embed_header|embed_footer|download|share|modal|popup|overlay|interstitial|advert|promo/i;
  let hidden = 0;
  for (const element of document.querySelectorAll('body *')) {
    if (insidePage(element) || containsPage(element)) continue;
    const style = getComputedStyle(element);
    const label = (element.id || '') + ' ' + (typeof element.className === 'string' ? element.className : '');
    if (style.position === 'fixed' || style.position === 'sticky' || bad.test(label)) {
      element.style.setProperty('display', 'none', 'important');
      element.style.setProperty('visibility', 'hidden', 'important');
      hidden++;
    }
  }
  const scroller = document.querySelector('.document_scroller') || document.scrollingElement || document.documentElement;
  try { scroller.scrollTop = 0; } catch (error) {}
  try { window.scrollTo(0, 0); } catch (error) {}
  return hidden;
}
"""

FORCE_PAGE_JS = r"""
(arg) => {
  const number = Number(arg && arg.number) || 0;
  const pages = window.__shotPages || [];
  const page = pages[number - 1];
  if (!page) return false;
  try { page.el.scrollIntoView({ block: 'center', behavior: 'auto' }); } catch (error) {}
  const dm = window.docManager || (window.Scribd && window.Scribd.docManager);
  const all = dm && dm.pages ? Object.values(dm.pages).filter(Boolean) : [];
  const managerPage = (dm && dm.pages && dm.pages[number]) || all[number - 1];
  try { if (managerPage && typeof managerPage.load === 'function') managerPage.load(); } catch (error) {}
  try { if (managerPage && managerPage.display) managerPage.display(); } catch (error) {}
  try { if (managerPage && managerPage.turnOnImages) managerPage.turnOnImages(); } catch (error) {}
  for (const img of page.el.querySelectorAll('img')) {
    try {
      img.loading = 'eager';
      img.decoding = 'sync';
      let source = img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-original');
      if (source && !img.getAttribute('src')) {
        if (source.startsWith('//')) source = 'https:' + source;
        img.setAttribute('src', source);
      }
    } catch (error) {}
  }
  return true;
}
"""

CLEAN_CSS = r"""
html, body {
  background: #fff !important;
  height: auto !important;
  max-height: none !important;
  overflow: visible !important;
}
.document_scroller, [class*="document_scroller"] {
  height: auto !important;
  max-height: none !important;
  overflow: visible !important;
  position: static !important;
}
* {
  animation: none !important;
  transition: none !important;
  scroll-behavior: auto !important;
}
[data-shot-page], .outer_page, .page_container, .doc_page, .page {
  box-shadow: none !important;
}
.osano-cm-window, .osano-cm-dialog, [class*="osano-cm"],
.global_header, .embed_header, .embed_footer,
[class*="toolbar"], [class*="banner"], [id*="download"],
[class*="download-button"], a[href*="download"],
[class*="mobile_overlay"], [class*="interstitial"] {
  display: none !important;
}
"""


def clips_from_boxes(boxes: list[dict], doc_width: float, doc_height: float) -> list[dict]:
    """Turn DOM page boxes into non-overlapping boundary clips."""
    if not boxes:
        raise CaptureError("Scribd showed no page boundaries.")
    clean: list[dict[str, float]] = []
    for box in boxes:
        item = {
            "number": float(box.get("number") or len(clean) + 1),
            "left": float(box["left"]),
            "right": float(box["right"]),
            "top": float(box["top"]),
            "bottom": float(box["bottom"]),
        }
        if item["right"] <= item["left"] or item["bottom"] <= item["top"]:
            continue
        clean.append(item)
    if not clean:
        raise CaptureError("Every Scribd page boundary was empty.")
    clean.sort(key=lambda item: (item["top"], item["left"]))
    doc_width = max(1.0, float(doc_width))
    doc_height = max(1.0, float(doc_height))
    x0 = max(0.0, math.floor(min(item["left"] for item in clean) - 2))
    x1 = min(doc_width, math.ceil(max(item["right"] for item in clean) + 2))
    if x1 <= x0:
        x0, x1 = 0.0, doc_width
    cuts = [max(0.0, math.floor(clean[0]["top"] - 2))]
    for index in range(1, len(clean)):
        previous = clean[index - 1]
        current = clean[index]
        midpoint = (previous["bottom"] + current["top"]) / 2.0
        cut = max(cuts[-1] + 1, min(math.floor(current["top"]), math.floor(midpoint)))
        cuts.append(float(cut))
    last = min(doc_height, math.ceil(clean[-1]["bottom"] + 2))
    if last <= cuts[-1]:
        last = min(doc_height, cuts[-1] + 1)
    cuts.append(float(last))
    clips: list[dict] = []
    for index, box in enumerate(clean):
        y0 = cuts[index]
        y1 = cuts[index + 1]
        if y1 <= y0:
            raise CaptureError(f"Page {index + 1} had no space between boundaries.")
        clips.append(
            {
                "number": int(box["number"]) or index + 1,
                "x": x0,
                "y": y0,
                "width": x1 - x0,
                "height": y1 - y0,
            }
        )
    return clips


def is_blank(path: Path) -> bool:
    """A cheap pixel check; blank pages are never added to the PDF."""
    with Image.open(path) as image:
        gray = image.convert("L")
        gray.thumbnail((256, 256))
        stat = ImageStat.Stat(gray)
        total = max(1, gray.width * gray.height)
        histogram = gray.histogram()
        nonwhite = sum(histogram[:245]) / total
        dark = sum(histogram[:32]) / total
        if stat.stddev[0] < 1.2 and (stat.mean[0] > 248 or stat.mean[0] < 8):
            return True
        if nonwhite < 0.00035 and dark < 0.0001:
            return True
    return False


def build_pdf(images: list[Path], output: Path, expected: int) -> None:
    """Compile JPEG screenshots losslessly and verify the exact page count."""
    if len(images) != expected:
        raise CaptureError(f"Expected {expected} screenshots, got {len(images)}.")
    temporary = output.with_name(output.stem + ".part.pdf")
    layout = img2pdf.get_fixed_dpi_layout_fun((96, 96))
    pdf_bytes = img2pdf.convert([str(path) for path in images], layout_fun=layout)
    temporary.write_bytes(pdf_bytes)
    try:
        reader = PdfReader(str(temporary))
        if reader.is_encrypted:
            raise CaptureError("The generated PDF was encrypted.")
        if len(reader.pages) != expected:
            raise CaptureError(
                f"The generated PDF had {len(reader.pages)} pages, expected {expected}."
            )
        for page in reader.pages:
            if float(page.mediabox.width) <= 0 or float(page.mediabox.height) <= 0:
                raise CaptureError("The generated PDF had an empty page box.")
    except Exception:
        temporary.unlink(missing_ok=True)
        raise
    os.replace(temporary, output)


def unique_output_path(title: str, ident: str) -> Path:
    output_dir = config.out_dir()
    name = config.safe_filename(title, ident)
    candidate = output_dir / name
    if not candidate.exists():
        return candidate
    stem = candidate.stem
    for number in range(2, 100):
        alternative = output_dir / f"{stem}-{number}.pdf"
        if not alternative.exists():
            return alternative
    return output_dir / f"{stem}-{int(time.time())}.pdf"


def _route(route) -> None:
    url = route.request.url.lower()
    if any(part in url for part in config.BLOCKED_HOST_PARTS) or "/analytics/" in url:
        route.abort()
    else:
        route.continue_()


def capture_document(
    document: scribd.Document,
    *,
    progress=None,
    log=None,
    cancel: threading.Event | None = None,
) -> CaptureResult:
    """Screenshot every Scribd page and compile one clean PDF."""
    from playwright.sync_api import Error as PlaywrightError
    from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
    from playwright.sync_api import sync_playwright

    config.ensure_dirs()
    started = time.monotonic()
    clean = scribd.clean_url(document.url)
    ident = document.id or scribd.doc_id_of(clean)
    if not clean or not ident:
        raise CaptureError("A Scribd document URL is required.")
    title = document.title or scribd.title_from_url(clean)
    embed = config.rebase(scribd.embed_url(clean))
    if not embed:
        raise CaptureError("Could not build the Scribd embed URL.")
    hint = max(0, min(document.pages, config.MAX_PAGES))
    output = unique_output_path(title, ident)
    if progress:
        progress(0, hint, 0)
    if log:
        log(f"opening {ident} · {hint or '?'} pages")

    with tempfile.TemporaryDirectory(dir=str(config.tmp_dir())) as work:
        work_dir = Path(work)
        screenshots: list[Path] = []
        try:
            # Resolve the browser BEFORE Playwright starts: it launches a Node
            # driver on entering `sync_playwright()`, and that driver inherits
            # the environment and spawns Chromium. LD_LIBRARY_PATH set later
            # would never reach the browser.
            executable = config.chrome_executable()
            launch_args = {
                "headless": True,
                "args": config.chrome_args(),
            }
            if executable:
                launch_args["executable_path"] = executable
            with sync_playwright() as playwright:
                try:
                    browser = playwright.chromium.launch(**launch_args)
                except PlaywrightError as exc:
                    detail = str(exc).strip().splitlines()[0] if str(exc).strip() else "unknown error"
                    raise CaptureError(
                        "Playwright Chromium could not start "
                        f"({detail}). The panel expects the bundled browser at "
                        f"{executable or '<tmp>/chromium'}; run `bash downloader/setup.sh` "
                        "to prepare it."
                    ) from exc
                try:
                    context = browser.new_context(
                        viewport=config.VIEWPORT,
                        device_scale_factor=config.DEVICE_SCALE,
                        user_agent=config.USER_AGENT,
                        color_scheme="light",
                        reduced_motion="reduce",
                        bypass_csp=True,
                        service_workers="block",
                    )
                    cookies = config.playwright_cookies()
                    if cookies:
                        context.add_cookies(cookies)
                    context.add_init_script(INIT_JS)
                    context.route("**/*", _route)
                    context.set_default_timeout(config.SHOT_TIMEOUT_MS)
                    context.set_default_navigation_timeout(config.NAV_TIMEOUT_MS)
                    page = context.new_page()
                    page.emulate_media(media="screen")
                    response = page.goto(embed, wait_until="domcontentloaded", timeout=config.NAV_TIMEOUT_MS)
                    if response and response.status >= 400:
                        raise CaptureError(f"Scribd refused the embed viewer (HTTP {response.status}).")
                    page.add_style_tag(content=CLEAN_CSS)

                    detected = 0
                    try:
                        detected = int(page.evaluate(PAGE_COUNT_JS) or 0)
                    except PlaywrightError:
                        detected = 0
                    if not hint:
                        hint = scribd.page_count_from_html(page.content())
                    if not hint:
                        hint = detected
                    if hint:
                        hint = min(hint, config.MAX_PAGES)
                    try:
                        page.evaluate(FORCE_RENDER_JS, {"expected": hint})
                    except PlaywrightError as exc:
                        raise CaptureError(f"Could not force Scribd pages to render: {exc}") from exc

                    measured = page.evaluate(BOUNDARIES_JS, {"expected": hint})
                    boxes = measured["boxes"]
                    if hint and len(boxes) < hint:
                        page.evaluate(FORCE_RENDER_JS, {"expected": hint})
                        page.wait_for_timeout(300)
                        measured = page.evaluate(BOUNDARIES_JS, {"expected": hint})
                        boxes = measured["boxes"]
                    if hint and len(boxes) < hint:
                        raise CaptureError(
                            f"Scribd rendered {len(boxes)} page boundaries for a {hint}-page document."
                        )
                    if not hint:
                        hint = len(boxes)
                    if not hint:
                        raise CaptureError("Scribd showed no pages for this document.")
                    boxes = boxes[:hint]
                    page.evaluate(CLEAN_JS)
                    measured = page.evaluate(BOUNDARIES_JS, {"expected": hint})
                    if len(measured["boxes"]) < hint:
                        raise CaptureError(
                            f"Scribd showed {len(measured['boxes'])} boundaries after cleanup, expected {hint}."
                        )
                    boxes = measured["boxes"][:hint]
                    clips = clips_from_boxes(boxes, measured["docWidth"], measured["docHeight"])
                    if progress:
                        progress(0, hint, 0)
                    try:
                        page.wait_for_function(
                            RENDER_READY_JS,
                            arg={"expected": hint},
                            timeout=config.RENDER_TIMEOUT_MS,
                            polling=100,
                        )
                    except PlaywrightTimeoutError:
                        page.evaluate(FORCE_RENDER_JS, {"expected": hint})
                        page.wait_for_timeout(300)

                    for index, clip in enumerate(clips, 1):
                        if cancel and cancel.is_set():
                            raise CaptureError("Job stopped.")
                        shot = work_dir / f"page-{index:04d}.jpg"
                        for attempt in range(config.BLANK_RETRIES + 1):
                            try:
                                page.screenshot(
                                    path=str(shot),
                                    type="jpeg",
                                    quality=config.JPEG_QUALITY,
                                    full_page=True,
                                    clip={
                                        "x": clip["x"],
                                        "y": clip["y"],
                                        "width": clip["width"],
                                        "height": clip["height"],
                                    },
                                    scale="css",
                                    animations="disabled",
                                    caret="hide",
                                    timeout=config.SHOT_TIMEOUT_MS,
                                )
                            except PlaywrightError as exc:
                                raise CaptureError(f"Page {index} screenshot failed: {exc}") from exc
                            if not is_blank(shot):
                                break
                            if attempt >= config.BLANK_RETRIES:
                                raise CaptureError(f"Page {index} stayed blank after forcing Scribd to render.")
                            try:
                                page.evaluate(FORCE_PAGE_JS, {"number": index})
                            except PlaywrightError:
                                pass
                            page.wait_for_timeout(250)
                        screenshots.append(shot)
                        if progress:
                            progress(index, hint, index)
                        if log and (index == 1 or index == hint or index % 5 == 0):
                            log(f"captured page {index}/{hint}")
                    if cancel and cancel.is_set():
                        raise CaptureError("Job stopped.")
                    build_pdf(screenshots, output, hint)
                    config.prune_outputs()
                finally:
                    browser.close()
        except CaptureError:
            output.unlink(missing_ok=True)
            raise
        except Exception as exc:
            output.unlink(missing_ok=True)
            raise CaptureError(str(exc) or exc.__class__.__name__) from exc
    size = output.stat().st_size
    if log:
        log(f"built {output.name} · {hint} pages · {size / 1024:.0f} KiB")
    return CaptureResult(output, hint, size, time.monotonic() - started)
