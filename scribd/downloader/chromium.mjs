/**
 * Prepare Chromium for the screenshot panel and print shell `export` lines.
 *
 * Discord/Pterodactyl panels cannot `apt-get` Chromium's system libraries and
 * Playwright's browser CDN is often blocked. The `@sparticuz/chromium` npm
 * package ships a Chromium binary AND the missing .so libraries, both inflated
 * into /tmp at runtime. There is no download at boot when it is installed.
 *
 * `start.sh` sources whatever this prints. It prints nothing when no browser
 * can be prepared, so the panel still boots (search/health/files keep working;
 * captures report a clear Chromium error).
 *
 * Run:  node downloader/chromium.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PKG = '@sparticuz/chromium@153.0.0';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);

// @sparticuz/chromium only inflates its bundled libraries (and sets
// LD_LIBRARY_PATH / FONTCONFIG_PATH) when it believes it is on AL2023 Lambda.
// Set the marker before import; the old working shooter did exactly this.
if (!process.env.AWS_EXECUTION_ENV) {
  process.env.AWS_EXECUTION_ENV = 'AWS_Lambda_nodejs22.x';
}

function quote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/** All the places the package could already live, cheapest first. */
function candidates() {
  const builds = [
    path.join(HERE, 'node_modules', '@sparticuz', 'chromium', 'build', 'index.js'),
    path.join(ROOT, 'node_modules', '@sparticuz', 'chromium', 'build', 'index.js'),
    // The pre-#96 shooter installed it here; deploys never delete old files.
    path.join(ROOT, 'tools', 'troy-search', 'node_modules', '@sparticuz', 'chromium', 'build', 'index.js'),
  ];
  return ['@sparticuz/chromium', ...builds.map((file) => pathToFileURL(file).href)];
}

async function load() {
  for (const spec of candidates()) {
    try {
      const mod = await import(spec);
      const chromium = mod.default || mod;
      if (chromium && typeof chromium.executablePath === 'function') return chromium;
    } catch { /* try next */ }
  }
  return null;
}

let chromium = await load();

// Self-heal: a pre-baked node_modules may predate this dependency. Install it
// once into downloader/ (isolated, --no-save) instead of asking for a command.
if (!chromium) {
  try {
    execFileSync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['install', '--prefix', HERE, '--no-save', '--no-audit', '--no-fund', '--loglevel=error', PKG],
      { cwd: ROOT, stdio: 'ignore', timeout: 240000 },
    );
    chromium = await load();
  } catch (err) {
    console.error(`[scribd] could not install ${PKG}: ${err.message}`);
  }
}

if (!chromium) {
  console.error('[scribd] @sparticuz/chromium unavailable; trying Playwright-managed Chromium.');
  process.exit(0);
}

try {
  const executable = await chromium.executablePath();
  const lines = [];
  const libDir = path.join(tmpdir(), 'al2023', 'lib');
  const fontDir = path.join(tmpdir(), 'fonts');
  if (executable && existsSync(executable)) {
    lines.push(`export PLAYWRIGHT_CHROMIUM_EXECUTABLE=${quote(executable)}`);
  }
  if (existsSync(libDir)) {
    const previous = process.env.LD_LIBRARY_PATH || '';
    const value = previous.includes(libDir) ? previous : `${libDir}${previous ? `:${previous}` : ''}`;
    lines.push(`export LD_LIBRARY_PATH=${quote(value)}`);
  }
  if (existsSync(fontDir)) {
    lines.push(`export FONTCONFIG_PATH=${quote(fontDir)}`);
  }
  process.stdout.write(lines.join('\n') + (lines.length ? '\n' : ''));
} catch (err) {
  console.error(`[scribd] Chromium extraction failed: ${err.message}`);
}
