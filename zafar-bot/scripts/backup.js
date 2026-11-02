'use strict';

/**
 * scripts/backup.js — back up users + sessions, rotating.
 *
 *   npm run backup
 *
 * What is backed up:
 *   storage/core/numbers/<number>/users.json     and settings.json
 *   storage/core/owner.json
 *   sessions/linked/<number>/                    (creds — TREAT AS SECRETS)
 *
 * What is not: command data (storage/commands/*), logs, tmp. Those are either
 * rebuildable or already private.
 *
 * Rotation: keeps the newest 10 archives in storage/backups/.
 *
 * OFF-BOX COPY: set ZAFAR_BACKUP_DIR to a path outside this repository and every
 * archive is mirrored there as well. That is the only copy that survives losing
 * the host. The mirror is written with mode 0700 and never inside the repo.
 *
 * SECURITY: the archives contain WhatsApp credentials. They are written with
 * mode 0600 inside storage/, which .gitignore excludes. Never commit them and
 * never point ZAFAR_BACKUP_DIR at a git working tree.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { paths } = require('../lib/paths');

const KEEP = 10;

/**
 * Mirror an archive to ZAFAR_BACKUP_DIR when it is set.
 * Refuses to copy inside the repository: an off-box copy that lives in the repo
 * is not off-box, and is one `git add -A` away from being published.
 */
function mirrorOffBox(archiveDir, root) {
  const dest = process.env.ZAFAR_BACKUP_DIR;
  if (!dest) return { mirrored: false, reason: 'ZAFAR_BACKUP_DIR is not set' };

  const resolved = path.resolve(dest);
  if (resolved.startsWith(root + path.sep) || resolved === root) {
    throw new Error(`ZAFAR_BACKUP_DIR must be outside the repository (got ${resolved})`);
  }

  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  fs.chmodSync(resolved, 0o700);
  const target = path.join(resolved, path.basename(archiveDir));
  copyTree(archiveDir, target);
  fs.writeFileSync(
    path.join(target, 'MIRRORED.txt'),
    `off-box copy of ${path.basename(archiveDir)}\n` +
    `source: ${archiveDir}\n` +
    `at: ${new Date().toISOString()}\n` +
    'Contains WhatsApp credentials. Keep it private.\n',
    { mode: 0o600 },
  );
  return { mirrored: true, path: target };
}

function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function copyTree(from, to) {
  if (!fs.existsSync(from)) return 0;
  fs.mkdirSync(to, { recursive: true, mode: 0o700 });
  let count = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) {
      count += copyTree(src, dest);
    } else if (entry.isFile()) {
      fs.copyFileSync(src, dest);
      fs.chmodSync(dest, 0o600);
      count += 1;
    }
  }
  return count;
}

function rotate(dir) {
  const archives = fs.readdirSync(dir)
    .filter((name) => name.startsWith('backup-'))
    .sort()
    .reverse();
  for (const old of archives.slice(KEEP)) {
    fs.rmSync(path.join(dir, old), { recursive: true, force: true });
  }
}

function main() {
  // users.json needs the .bak copy to stay valid, so storage/core is copied whole
  // except status.json, which carries no unique information.
  const target = path.join(paths.backups, `backup-${stamp()}`);
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });

  const users = copyTree(path.join(paths.storageCore, 'numbers'), path.join(target, 'numbers'));
  const core = copyTree(path.dirname(paths.disabled), path.join(target, 'core'));
  fs.rmSync(path.join(target, 'core', 'numbers'), { recursive: true, force: true });
  const sessions = copyTree(paths.sessionsLinked, path.join(target, 'sessions'));

  // A manifest makes a restore auditable.
  const manifest = {
    createdAt: new Date().toISOString(),
    node: process.version,
    files: { numbers: users, core, sessions },
    warning: 'Contains WhatsApp credentials. Private. Restore with scripts/backup.js instructions.',
  };
  fs.writeFileSync(path.join(target, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });

  // A cheap integrity marker so a truncated copy is obvious later.
  try {
    const listing = execFileSync('find', [target, '-type', 'f'], { encoding: 'utf8' });
    fs.writeFileSync(path.join(target, 'FILES.txt'), listing, { mode: 0o600 });
  } catch (err) {
    // `find` is absent on some minimal images; the manifest still lists counts.
    console.warn(`   (FILES.txt skipped: ${err.message})`);
  }

  rotate(paths.backups);

  const mirror = mirrorOffBox(target, path.resolve(__dirname, '..'));

  console.log(`✅ Backup written: ${path.relative(path.resolve(__dirname, '..'), target)}`);
  console.log(`   users/settings files: ${users}`);
  console.log(`   core files:           ${core}`);
  console.log(`   session files:        ${sessions}`);
  console.log(`   kept:                 newest ${KEEP}`);
  if (mirror.mirrored) console.log(`   off-box mirror:       ${mirror.path}`);
  else console.log(`   off-box mirror:       skipped — ${mirror.reason}`);
  console.log('');
  console.log('These archives contain WhatsApp credentials. Never commit storage/.');
}

main();
