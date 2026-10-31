// AllDebrid client. Magnet status is v4.1; files are a tree from the v4 API.
import config from '../../config.js';
import { pause, requestSignal } from './_http.js';

const ROOT = 'https://api.alldebrid.com';
const H = () => ({ Authorization: `Bearer ${config.allDebridKey}` });
const isVid = (n) => /\.(mp4|mkv|avi|mov|m4v|webm)$/i.test(n || '');
export const pickBiggest = (files) =>
  files.filter(f => isVid(f.path)).sort((a, b) => (b.bytes || 0) - (a.bytes || 0))[0] || null;

async function post(endpoint, params, { version = 'v4', signal } = {}) {
  const res = await fetch(`${ROOT}/${version}/${endpoint}`, {
    method: 'POST', headers: H(), body: new URLSearchParams(params),
    signal: requestSignal(signal),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || json?.status !== 'success') {
    throw Object.assign(new Error(json?.error?.message || `AllDebrid HTTP ${res.status}`), {
      code: json?.error?.code || 'API', status: res.status,
    });
  }
  return json.data || {};
}

/** Account check (AllDebrid v4 `/user`). */
export async function account() {
  const res = await fetch(`${ROOT}/v4/user`, {
    headers: H(), signal: AbortSignal.timeout(15000)
  });
  const j = await res.json().catch(() => null);
  if (!res.ok || j?.status === 'error') {
    throw Object.assign(new Error(j?.error?.message || `HTTP ${res.status}`), {
      code: res.status === 401 ? 'BAD_TOKEN' : 'API', status: res.status,
    });
  }
  const u = j?.data?.user || {};
  return {
    provider: 'alldebrid',
    username: u.username || '',
    premium: Boolean(u.isPremium),
    expiration: u.premiumUntil ? new Date(u.premiumUntil * 1000).toISOString().slice(0, 10) : '',
    points: u.points || 0,
    type: u.isPremium ? 'premium' : 'free',
  };
}

// Flatten the documented n/e/s/l folder tree, preserving the name-to-link
// association so an episode can never be matched to a different file's link.
export function flattenFiles(nodes) {
  const files = [];
  const stack = (Array.isArray(nodes) ? nodes : []).map(node => ({ node, prefix: '' })).reverse();
  while (stack.length) {
    const { node, prefix } = stack.pop();
    if (!node || typeof node.n !== 'string') continue;
    const filePath = prefix ? `${prefix}/${node.n}` : node.n;
    if (Array.isArray(node.e)) {
      for (let i = node.e.length - 1; i >= 0; i--) stack.push({ node: node.e[i], prefix: filePath });
    } else {
      files.push({ path: filePath, bytes: Number(node.s) || 0, link: node.l || null });
    }
  }
  return files;
}

export async function resolve(cand, opts = {}) {
  const { signal } = opts;
  const upload = await post('magnet/upload', [['magnets[]', cand.magnet]], { signal });
  const added = upload.magnets?.[0];
  const id = added?.id;
  if (!id) throw new Error(added?.error?.message || 'ad upload failed');

  let ready = added.ready === true;
  for (let i = 0; !ready && i < 40; i++) {
    const status = await post('magnet/status', { id: String(id) }, { version: 'v4.1', signal });
    const entries = Array.isArray(status.magnets) ? status.magnets : [status.magnets];
    const magnet = entries.find(m => String(m?.id) === String(id)) || (entries.length === 1 ? entries[0] : null);
    if (magnet?.statusCode == null || !Number.isInteger(Number(magnet.statusCode))) throw new Error('ad invalid magnet status');
    const code = Number(magnet.statusCode);
    if (code === 4) { ready = true; break; }
    if (code > 4) throw new Error(`ad magnet: ${magnet.status || `error ${code}`}`);
    if (i < 39) await pause(3000, signal);
  }
  if (!ready) throw new Error('ad timeout');

  const listing = await post('magnet/files', [['id[]', String(id)]], { signal });
  const entries = Array.isArray(listing.magnets) ? listing.magnets : [listing.magnets];
  const magnet = entries.find(m => String(m?.id) === String(id)) || (entries.length === 1 ? entries[0] : null);
  if (magnet?.error) throw new Error(magnet.error.message || 'ad files failed');
  const files = flattenFiles(magnet?.files);
  const chosen = opts.pickEpisode ? opts.pickEpisode(files) : pickBiggest(files);
  if (!chosen) throw new Error('ad no video file');
  if (!chosen.link) throw new Error('ad no link');

  const unlocked = await post('link/unlock', { link: chosen.link }, { signal });
  let direct = unlocked.link;
  if (!direct && unlocked.delayed) {
    // AllDebrid requests delayed links be polled no more often than 5s.
    for (let i = 0; i < 24 && !direct; i++) {
      await pause(5000, signal);
      const delayed = await post('link/delayed', { id: String(unlocked.delayed) }, { signal });
      if (Number(delayed.status) === 3) throw new Error('ad delayed link failed');
      if (Number(delayed.status) === 2) direct = delayed.link;
    }
  }
  if (!direct) throw new Error('ad unlock failed');
  return { url: direct, sizeMB: (Number(unlocked.filesize) || chosen.bytes || 0) / 1048576, filename: chosen.path };
}

export default { resolve, pickBiggest, account };
