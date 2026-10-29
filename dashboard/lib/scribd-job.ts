import type { ScribdFile, ScribdJobItem } from './scribd-types';

/** A PDF filename is a name, never a path. Do not rewrite it into another file. */
export function safeScribdName(raw: string): string {
  const name = (raw || '').trim();
  if (!name || name.length > 240 || name.includes('/') || name.includes('\\') ||
      /[\x00-\x1f\x7f]/.test(name) || !/\.pdf$/i.test(name)) return '';
  return name;
}

/** The service exposes finished files as job items, not as a separate listing. */
export function filesFromJob(items: ScribdJobItem[]): ScribdFile[] {
  return items.flatMap((item) => {
    if (item.status !== 'done') return [];
    const name = item.pdf || safeScribdName(item.drime?.name || '');
    if (!name) return [];
    const source = item.offloaded || (!item.pdf && item.drime) ? 'drime' : 'server';
    return [{
      id: item.id,
      name,
      title: item.title,
      bytes: item.size,
      when: item.started,
      source,
      shareUrl: item.drime?.url || undefined,
    } satisfies ScribdFile];
  }).sort((a, b) => b.when - a.when);
}
