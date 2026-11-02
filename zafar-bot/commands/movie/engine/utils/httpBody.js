// Bounded reads for untrusted HLS playlists, keys, and segments. Never trust
// Content-Length alone: a chunked or dishonest response must obey the same cap.
export async function readBounded(res, limit, label = 'response') {
  const length = Number(res.headers.get('content-length'));
  if (Number.isFinite(length) && length > limit) {
    try { await res.body?.cancel(); } catch { /* already closed */ }
    throw Object.assign(new Error(`${label} exceeds the size cap`), { code: 'TOO_BIG' });
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw Object.assign(new Error(`${label} exceeds the size cap`), { code: 'TOO_BIG' });
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}

export const MAX_PLAYLIST_BYTES = 4 * 1024 * 1024;
export async function readPlaylist(res) {
  return (await readBounded(res, MAX_PLAYLIST_BYTES, 'HLS playlist')).toString('utf8');
}
