'use client';

/**
 * React port of the lazy-loading pieces of spences10/sveltekit-embed (MIT):
 * `in_view` (IntersectionObserver), `load_script` (one script per widget
 * source) and `embed_loading` (a bounded spinner for script-based embeds).
 * Iframes stay `loading="lazy"` and are not mounted until near the viewport.
 */

import { useEffect, useRef, useState } from 'react';
import {
  EMBED_IFRAME_DEFAULTS,
  EMBED_LOAD_GIVE_UP_MS,
  getAspectRatio,
} from '@/lib/embed-utils';

export interface LazyEmbedProps {
  src: string;
  title?: string;
  aspectRatio?: string;
  height?: string;
  allow?: string;
  loading?: 'lazy' | 'eager';
  /** Third-party widget script (e.g. platform.twitter.com/widgets.js). */
  scriptSrc?: string;
  fallbackLabel?: string;
  className?: string;
}

export function LazyEmbed({
  src,
  title = 'Embed',
  aspectRatio = '16:9',
  height = EMBED_IFRAME_DEFAULTS.height,
  allow = EMBED_IFRAME_DEFAULTS.allow,
  loading = EMBED_IFRAME_DEFAULTS.loading,
  scriptSrc,
  fallbackLabel = 'Open the original link',
  className,
}: LazyEmbedProps) {
  const container = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(loading === 'eager');
  const [loaded, setLoaded] = useState(false);
  const [gaveUp, setGaveUp] = useState(false);

  // in_view: mount the iframe only once it is close to the viewport.
  useEffect(() => {
    if (visible) return;
    const node = container.current;
    if (!node) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px', threshold: 0 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [visible]);

  // embed_loading: stop showing the spinner after a bounded wait.
  useEffect(() => {
    if (!visible || loaded) return;
    const timer = setTimeout(() => setGaveUp(true), EMBED_LOAD_GIVE_UP_MS);
    return () => clearTimeout(timer);
  }, [visible, loaded]);

  // load_script: append the widget script once, for as long as the page lives.
  useEffect(() => {
    if (!visible || !scriptSrc || typeof document === 'undefined') return;
    const selector = 'script[data-embed-script="' + CSS.escape(scriptSrc) + '"]';
    if (document.querySelector(selector)) return;
    const script = document.createElement('script');
    script.src = scriptSrc;
    script.async = true;
    script.dataset.embedScript = scriptSrc;
    document.head.appendChild(script);
  }, [visible, scriptSrc]);

  const ratioValue = getAspectRatio(aspectRatio)
    .replace(/^aspect-ratio:\s*/, '')
    .replace(/;\s*$/, '');
  const showSpinner = visible && !loaded && !gaveUp;

  return (
    <div
      ref={container}
      className={className}
      data-embed-loading={showSpinner ? '' : undefined}
      style={{ position: 'relative', width: EMBED_IFRAME_DEFAULTS.width, aspectRatio: ratioValue }}
    >
      {visible ? (
        <iframe
          src={src}
          title={title}
          loading={loading}
          allow={allow}
          width={EMBED_IFRAME_DEFAULTS.width}
          height={height}
          onLoad={() => setLoaded(true)}
          style={{ border: 0, borderRadius: '0.6rem' }}
        />
      ) : null}
      {showSpinner ? (
        <span className="sr-only" role="status">Loading embed…</span>
      ) : null}
      <a href={src} target="_blank" rel="noreferrer" className="text-xs text-accent-700 underline">
        {fallbackLabel}
      </a>
    </div>
  );
}
