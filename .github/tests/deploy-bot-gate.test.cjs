const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const gate = path.join(root, '.github/scripts/should-deploy-bot.sh');
const freshness = path.join(root, '.github/scripts/check-bot-freshness.sh');
const config = path.join(root, '.github/scripts/check-panel-config.sh');
const restart = path.join(root, '.github/scripts/restart-panel.sh');
let temp;
let repo;
let commits;

function git(...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function write(relative, content) {
  const file = path.join(repo, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function commit(message) {
  git('add', '-A');
  git('-c', 'user.name=CI test', '-c', 'user.email=ci@example.invalid', 'commit', '-qm', message);
  return git('rev-parse', 'HEAD');
}

function runScript(script, variables) {
  const output = path.join(temp, `output-${Math.random().toString(36).slice(2)}`);
  const result = spawnSync('bash', [script], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_OUTPUT: output, ...variables },
  });
  const decision = fs.existsSync(output) ? fs.readFileSync(output, 'utf8').trim() : '';
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, decision };
}

function decide(beforeSha, afterSha, extra = {}) {
  return runScript(gate, {
    GITHUB_EVENT_NAME: 'push',
    GITHUB_REF: 'refs/heads/main',
    PUSH_BEFORE: beforeSha,
    GITHUB_SHA: afterSha,
    ...extra,
  });
}

function checkConfig(event, variables = {}) {
  return runScript(config, { GITHUB_EVENT_NAME: event, H: '', U: '', P: '', K: '', ...variables });
}

function checkRestart(variables = {}) {
  const log = path.join(temp, `curl-${Math.random().toString(36).slice(2)}`);
  const result = runScript(restart, {
    PANEL_URL: 'https://panel.example.invalid',
    PANEL_SERVER_ID: 'server-123',
    PANEL_API_KEY: 'private-api-key',
    CURL_CODE: '204',
    CURL_LOG: log,
    PATH: `${path.join(temp, 'bin')}${path.delimiter}${process.env.PATH}`,
    ...variables,
  });
  const endpoints = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
  return { ...result, endpoints };
}

before(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-deploy-gate-'));
  repo = path.join(temp, 'repo');
  fs.mkdirSync(repo);
  const bin = path.join(temp, 'bin');
  fs.mkdirSync(bin);
  const fakeCurl = path.join(bin, 'curl');
  fs.writeFileSync(fakeCurl, `#!/usr/bin/env bash
for arg in "$@"; do
  case "$arg" in https://*) printf '%s\\n' "$arg" >> "$CURL_LOG" ;; esac
done
printf '%s' "$CURL_CODE"
`);
  fs.chmodSync(fakeCurl, 0o755);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);

  write('Whatsapp bot/index.js', 'first version\n');
  write('Whatsapp bot/README.md', 'first docs\n');
  write('dashboard/index.js', 'first dashboard\n');
  const base = commit('initial');
  write('dashboard/index.js', 'dashboard update\n');
  const dashboard = commit('dashboard only');
  write('Whatsapp bot/README.md', 'updated docs\n');
  write('Whatsapp bot/nested/help.md', 'nested docs\n');
  const docs = commit('bot documentation');
  write('Whatsapp bot/index.js', 'bot update\n');
  const code = commit('bot code');
  fs.unlinkSync(path.join(repo, 'Whatsapp bot/index.js'));
  const deleted = commit('delete bot file');
  write('dashboard/index.js', 'another dashboard update\n');
  write('Whatsapp bot/config.js', 'new bot config\n');
  const mixed = commit('mixed update');
  write('dashboard/index.js', 'latest dashboard update\n');
  write('Whatsapp bot/README.md', 'latest docs\n');
  const latest = commit('dashboard and docs only');
  git('remote', 'add', 'origin', repo);
  commits = { base, dashboard, docs, code, deleted, mixed, latest };
});

after(() => {
  if (temp) fs.rmSync(temp, { recursive: true, force: true });
});

test('dashboard-only and bot markdown-only changes never trigger bot upload', () => {
  for (const [base, head] of [[commits.base, commits.dashboard], [commits.dashboard, commits.docs], [commits.base, commits.docs]]) {
    const result = decide(base, head);
    assert.equal(result.status, 0);
    assert.equal(result.decision, 'deploy=false');
  }
});

test('bot code, deletions, mixed changes and multi-commit pushes trigger upload', () => {
  for (const [base, head] of [[commits.docs, commits.code], [commits.code, commits.deleted], [commits.deleted, commits.mixed], [commits.base, commits.mixed]]) {
    const result = decide(base, head);
    assert.equal(result.status, 0);
    assert.equal(result.decision, 'deploy=true');
  }
});

test('unknown or missing push history skips rather than guessing', () => {
  for (const beforeSha of ['', '0'.repeat(40), 'a'.repeat(40), '--not-a-sha']) {
    const result = decide(beforeSha, commits.code);
    assert.equal(result.status, 0);
    assert.equal(result.decision, 'deploy=false');
    assert.match(result.stdout, /warning.*skipped/i);
  }
});

test('manual deployment is allowed only from main; other events are skipped', () => {
  const main = decide('', '', { GITHUB_EVENT_NAME: 'workflow_dispatch' });
  assert.equal(main.status, 0);
  assert.equal(main.decision, 'deploy=true');

  const other = decide('', '', { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/feature' });
  assert.notEqual(other.status, 0);
  assert.notEqual(other.decision, 'deploy=true');
  assert.match(other.stdout, /main branch/i);

  const branchPush = decide(commits.docs, commits.code, { GITHUB_REF: 'refs/heads/feature' });
  assert.equal(branchPush.decision, 'deploy=false');
  const pr = decide(commits.docs, commits.code, { GITHUB_EVENT_NAME: 'pull_request' });
  assert.equal(pr.decision, 'deploy=false');
});

test('an older upload cannot overwrite newer bot changes on main', () => {
  const current = runScript(freshness, { GITHUB_SHA: commits.latest });
  assert.equal(current.status, 0);
  assert.equal(current.decision, 'fresh=true');

  const onlyDashboardAndDocsNewer = runScript(freshness, { GITHUB_SHA: commits.mixed });
  assert.equal(onlyDashboardAndDocsNewer.decision, 'fresh=true');

  const botIsStale = runScript(freshness, { GITHUB_SHA: commits.docs });
  assert.equal(botIsStale.decision, 'fresh=false');
  assert.match(botIsStale.stdout, /newer bot changes/i);

  const unknown = runScript(freshness, { GITHUB_SHA: 'not-a-commit' });
  assert.equal(unknown.decision, 'fresh=false');
});

test('if main cannot be checked, an upload fails closed', () => {
  git('remote', 'set-url', 'origin', path.join(temp, 'missing-remote'));
  try {
    const result = runScript(freshness, { GITHUB_EVENT_NAME: 'push', GITHUB_SHA: commits.latest });
    assert.equal(result.status, 0);
    assert.equal(result.decision, 'fresh=false');
    assert.match(result.stdout, /warning.*skipped/i);
    const manual = runScript(freshness, { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_SHA: commits.latest });
    assert.notEqual(manual.status, 0);
    assert.equal(manual.decision, 'fresh=false');
    assert.match(manual.stdout, /error.*skipped/i);
  } finally {
    git('remote', 'set-url', 'origin', repo);
  }
});

test('missing SFTP settings warn on automatic runs and fail explicit manual runs', () => {
  const automatic = checkConfig('push');
  assert.equal(automatic.status, 0);
  assert.equal(automatic.decision, 'ready=false');
  assert.match(automatic.stdout, /warning.*skipped/i);

  const manual = checkConfig('workflow_dispatch', { H: 'example-host', U: 'example-user' });
  assert.notEqual(manual.status, 0);
  assert.equal(manual.decision, 'ready=false');
  assert.match(manual.stdout, /error.*did not run/i);
});

test('password or key settings are accepted without printing their values', () => {
  const values = { H: 'example-host', U: 'example-user', P: 'private-password', K: '' };
  for (const auth of [{ P: values.P }, { K: 'private-key' }]) {
    const result = checkConfig('workflow_dispatch', { ...values, P: '', ...auth });
    assert.equal(result.status, 0);
    assert.equal(result.decision, 'ready=true');
    for (const value of [values.H, values.U, values.P, 'private-key']) {
      assert.ok(!result.stdout.includes(value));
      assert.ok(!result.stderr.includes(value));
    }
  }
});

test('automatic restart requires an explicit HTTPS panel and server ID', () => {
  for (const missing of [
    { PANEL_API_KEY: '' },
    { PANEL_URL: '' },
    { PANEL_SERVER_ID: '' },
    { PANEL_URL: 'http://panel.example.invalid' },
    { PANEL_URL: 'https://user:pass@panel.example.invalid' },
    { PANEL_URL: 'https://panel.example.invalid/?token=bad' },
    { PANEL_SERVER_ID: '../another-server' },
  ]) {
    const result = checkRestart(missing);
    assert.equal(result.status, 0);
    assert.equal(result.endpoints.length, 0);
    assert.match(result.stdout, /restart skipped/i);
    assert.ok(!result.stdout.includes('private-api-key'));
  }
});

test('restart requests target only the configured server and never print credentials', () => {
  const result = checkRestart({ PANEL_URL: 'https://panel.example.invalid/server/ignored' });
  assert.equal(result.status, 0);
  assert.deepEqual(result.endpoints, ['https://panel.example.invalid/api/client/servers/server-123/power']);
  assert.match(result.stdout, /restart requested/i);
  assert.ok(!result.stdout.includes('private-api-key'));
  assert.ok(!result.stderr.includes('private-api-key'));

  const rejected = checkRestart({ CURL_CODE: '403' });
  assert.equal(rejected.status, 0);
  assert.deepEqual(rejected.endpoints, [
    'https://panel.example.invalid/api/client/servers/server-123/power',
    'https://panel.example.invalid/api/application/servers/server-123/power',
  ]);
  assert.match(rejected.stdout, /restart was not accepted/i);
  assert.ok(!rejected.stdout.includes('private-api-key'));
});

test('the workflow wires the safeguards before the existing upload and keeps the selftest gate', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/deploy-panel.yml'), 'utf8');
  assert.match(workflow, /needs:\s*selftest/);
  assert.match(workflow, /node --test \.github\/tests\/deploy-bot-gate\.test\.cjs/);
  assert.match(workflow, /fetch-depth:\s*0/);
  assert.match(workflow, /run:\s*bash \.github\/scripts\/should-deploy-bot\.sh/);
  assert.match(workflow, /needs:\s*bot_changes/);
  assert.match(workflow, /github\.event_name == 'workflow_dispatch' && inputs\.confirm_legacy_sftp == true/);
  assert.match(workflow, /if:\s*needs\.bot_changes\.outputs\.deploy == 'true'/);
  assert.match(workflow, /group:\s*panel-bot-production/);
  assert.match(workflow, /cancel-in-progress:\s*false/);
  assert.match(workflow, /run:\s*bash \.github\/scripts\/check-bot-freshness\.sh/);
  assert.match(workflow, /if:\s*steps\.freshness\.outputs\.fresh == 'true'/);
  assert.match(workflow, /run:\s*bash \.github\/scripts\/check-panel-config\.sh/);
  assert.match(workflow, /run:\s*bash \.github\/scripts\/restart-panel\.sh/);
  assert.doesNotMatch(workflow, /Auto-discover server identifier/);
  assert.ok(workflow.includes("git archive 'HEAD:Whatsapp bot'"));
  assert.match(workflow, /--exclude-glob database\//);
  assert.doesNotMatch(workflow, /mirror\s+-R\s+--delete/);
  assert.ok(workflow.indexOf('should-deploy-bot.sh') < workflow.indexOf('check-bot-freshness.sh'));
  assert.ok(workflow.indexOf('check-bot-freshness.sh') < workflow.indexOf('check-panel-config.sh'));
  assert.ok(workflow.indexOf('check-panel-config.sh') < workflow.indexOf('name: Upload the bot'));
});
