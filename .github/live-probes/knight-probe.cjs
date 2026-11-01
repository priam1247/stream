'use strict';
// Temporary probe: execute functions from the cloned upstream files, not a copy.
// All logs are deliberately limited to provider, stage and safe status codes.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const { execFileSync } = require('node:child_process');
const { probeMedia } = require(path.resolve('Whatsapp bot/utils/mediaTransfer'));
const ffmpeg = require(path.resolve('Whatsapp bot/utils/ffmpeg'));
const root = path.resolve(process.env.KNIGHT_DIR);
const axios = require(path.resolve('Whatsapp bot/node_modules/axios'));
const boundedAxios = {
  ...axios,
  get: (url, options = {}) => axios.get(url, { ...options, timeout: Math.min(options.timeout || 25000, 25000) }),
};
const quiet = { log() {}, error() {}, warn() {} };
function load(file, injections, appendix = '') {
  const filename = path.join(root, file);
  const contents = fs.readFileSync(filename, 'utf8') + '\n' + appendix;
  const result = { exports: {} };
  const localRequire = (name) => {
    if (Object.hasOwn(injections, name)) return injections[name];
    return require(name);
  };
  const wrapper = vm.runInThisContext(`(function(require,module,exports,__filename,__dirname,console){${contents}\n})`, { filename });
  wrapper(localRequire, result, result.exports, filename, path.dirname(filename), quiet);
  return result.exports;
}
const api = load('utils/api.js', { axios: boundedAxios });
// Execute the supplied public upstream configuration only for this temporary test.
// Its values are never logged, stored, or imported into the bot.
const upstreamConfig = load('config.js', {});
const common = { axios: boundedAxios, 'yt-search': () => {}, '../../utils/api': api, '../../config': upstreamConfig, '../../utils/converter': { toAudio() {} }, 'ffmpeg-static': 'ffmpeg' };
const song = load('commands/media/song.js', common, 'module.exports._live = {hectorSongDownload,prexzySongDownload,knightSongDownload,princeSongDownload};')._live;
const video = load('commands/media/video.js', common, 'module.exports._live = {hectorVideoDownload,knightVideoDownload,princeVideoDownload};')._live;
const audioUrl = 'https://www.youtube.com/watch?v=H5eLnIhRpWg';
const videoUrl = 'https://www.youtube.com/watch?v=H5eLnIhRpWg';
const providers = [
  ['Hector audio', 'audio', () => song.hectorSongDownload(audioUrl, 1)],
  ['Hector video', 'video', () => video.hectorVideoDownload(videoUrl, '360')],
  ['Knight audio upstream config', 'audio', () => song.knightSongDownload(audioUrl, 1)],
  ['Knight video upstream config', 'video', () => video.knightVideoDownload({url: videoUrl, format: '360p'})],
  ['Prince audio upstream config', 'audio', () => song.princeSongDownload(audioUrl, 1)],
  ['Prince video upstream config', 'video', () => video.princeVideoDownload(videoUrl, '360')],
  ['Hector BBB audio', 'audio', () => song.hectorSongDownload('https://www.youtube.com/watch?v=8jtRL_Yl0Wc', 1)],
  ['Hector BBB video', 'video', () => video.hectorVideoDownload('https://www.youtube.com/watch?v=8jtRL_Yl0Wc', '360')],
  ['Prexzy audio', 'audio', () => song.prexzySongDownload(audioUrl)],
  ['Elite audio', 'audio', () => api.getEliteProTechDownloadByUrl(audioUrl)],
  ['Elite video', 'video', () => api.getEliteProTechVideoByUrl(videoUrl)],
  ['Yupra audio', 'audio', () => api.getYupraDownloadByUrl(audioUrl)],
  ['Yupra video', 'video', () => api.getYupraVideoByUrl(videoUrl)],
  ['Okatsu audio', 'audio', () => api.getOkatsuDownloadByUrl(audioUrl)],
  ['Okatsu video', 'video', () => api.getOkatsuVideoByUrl(videoUrl)],
  ['Izumi audio', 'audio', () => api.getIzumiDownloadByUrl(audioUrl)],
];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knight-live-'));
const safeErr = (err) => {
  const status = Number(err?.response?.status || err?.status);
  const code = String(err?.code || '');
  if (status >= 100 && status < 600) return `HTTP_${status}`;
  if (/^(ECONNRESET|ECONNREFUSED|ECONNABORTED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|TOO_BIG|BAD_MEDIA|NO_AUDIO|NO_VIDEO|DECODE_FAILED)$/.test(code)) return code;
  if (/IP-locked/i.test(err?.message || '')) return 'IP_LOCKED';
  return 'NO_MEDIA_OR_PROVIDER_ERROR';
};
async function fullFile(url, name, kind) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || u.username || u.password) throw Object.assign(new Error('unsafe source'), {code:'BAD_MEDIA'});
  const file = path.join(tmp, name.replace(/[^a-z0-9]/gi, '_'));
  const resp = await axios.get(u.href, {responseType:'stream', timeout:90000, maxRedirects:5,
    headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',Accept:'*/*','Accept-Encoding':'identity'},
    validateStatus:()=>true, signal:AbortSignal.timeout(120000)});
  if (resp.status !== 200) { resp.data.destroy(); throw Object.assign(new Error('http'),{status:resp.status}); }
  let bytes = 0;
  const maxBytes = 100 * 1024 * 1024;
  const meter = new Transform({transform(c,_,cb){bytes+=c.length;cb(bytes>maxBytes?Object.assign(new Error('too big'),{code:'TOO_BIG'}):null,c)}});
  try {
    await pipeline(resp.data,meter,fs.createWriteStream(file));
    if (bytes < 10240) throw Object.assign(new Error('small'),{code:'BAD_MEDIA'});
    const info = await probeMedia(file);
    if (!info.probed) {
      const fd=fs.openSync(file,'r');const b=Buffer.alloc(8);fs.readSync(fd,b,0,8,0);fs.closeSync(fd);
      const ct=String(resp.headers['content-type']||'').split(';')[0].replace(/[^a-z0-9\/+.-]/gi,'').slice(0,60);
      throw Object.assign(new Error('probe'),{code:'BAD_MEDIA',info:`bytes=${bytes} mime=${ct||'none'} magic=${b.toString('hex')}`});
    }
    if (!info.hasAudio) throw Object.assign(new Error('audio'),{code:'NO_AUDIO'});
    if (kind==='video' && !info.hasVideo) throw Object.assign(new Error('video'),{code:'NO_VIDEO'});
    try {
      const args = ['-v','error','-xerror','-i',file,'-map','0:a:0'];
      if (kind==='video') args.push('-map','0:v:0');
      args.push('-f','null','-');
      execFileSync(ffmpeg(),args,{timeout:90000,stdio:'ignore'});
    } catch { throw Object.assign(new Error('decode'),{code:'DECODE_FAILED'}); }
    return bytes;
  } finally { fs.rmSync(file,{force:true}); }
}
async function attempt([name, kind, resolve]) {
  let hit;
  try { hit = await resolve(); }
  catch (err) { return `${name}: resolver ${safeErr(err)}`; }
  const url = hit?.download || hit?.dl_url || hit?.audio || hit?.downloadUrl || hit?.dl;
  if (typeof url !== 'string') return `${name}: resolver NO_MEDIA`;
  try { const bytes=await fullFile(url,name,kind); return `${name}: COMPLETE_DECODE_OK ${bytes} bytes`; }
  catch (err) { return `${name}: file ${safeErr(err)} ${err.info||''}`; }
}
(async()=>{
  const results = await Promise.all(providers.map(attempt));
  console.log(`::notice title=Live KnightBot probe::${results.join(' | ')}`);
  console.log('Keyed calls used only the supplied upstream repository configuration; nothing copied into this bot.');
})().catch(()=>{console.log('probe failed'); process.exitCode=1;}).finally(()=>fs.rmSync(tmp,{recursive:true,force:true}));
