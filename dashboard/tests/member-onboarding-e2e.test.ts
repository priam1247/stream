// @vitest-environment node
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, expect, it, vi } from 'vitest';

const email = vi.hoisted(() => ({ codes: new Map<string, string>() }));
vi.mock('../lib/email-service', () => ({
  isMailDeliveryConfigured: () => true,
  sendVerificationEmail: async (to: string, _name: string, code: string) => { email.codes.set(to, code); return { delivered: true }; },
  sendPasswordResetEmail: async () => ({ delivered: true }),
}));
import { POST as register } from '../app/api/auth/register/route';
import { POST as verify } from '../app/api/auth/verify/route';
import { POST as login } from '../app/api/auth/login/route';
import { POST as numbers } from '../app/api/member/numbers/route';
import { POST as pair, GET as pairResult } from '../app/api/member/pair/route';
import { GET as status } from '../app/api/member/status/route';
import { POST as approval } from '../app/api/admin/approvals/route';
import { POST as unlink, GET as unlinkResult } from '../app/api/member/unlink/route';
import { POST as sync } from '../app/api/bot/sync/route';
import { signSessionJwt } from '../lib/jwt';
import { getBotHeartbeat, saveBotConnectionConfig, saveBotHeartbeat, upsertAccount } from '../lib/storage';

const require = createRequire(import.meta.url);
const { createBotFixture } = require('../../Whatsapp bot/scripts/test-sandbox.js') as { createBotFixture: (root: string) => string };
let root = '';
let db: DatabaseSync | undefined;
let cleanupBot: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanupBot?.(); cleanupBot = undefined;
  db?.close(); db = undefined;
  if (root) fs.rmSync(root, { recursive: true, force: true }); root = '';
  email.codes.clear(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  globalThis.__zafarD1SchemaV6Ready = undefined; globalThis.__zafarD1SchemaV6Promise = undefined;
  globalThis.__zafarD1UnreachableInDev = undefined; globalThis.__zafarBotReplayNonces?.clear();
});

function request(url: string, body?: unknown, token?: string) {
  return new NextRequest(`https://dashboard.example${url}`, {
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '192.0.2.17', ...(token ? { 'x-session-token': token } : {}) },
  });
}
async function waitFor(condition: () => boolean, timeout = 3000) {
  const until = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > until) throw new Error('Timed out waiting for the simulated WhatsApp event');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

it('registers, verifies, links before approval, syncs private usage, survives offline login and unlinks', async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'onboarding-e2e-'));
  db = new DatabaseSync(':memory:');
  const botRoot = createBotFixture(root);
  const botRequire = createRequire(path.join(botRoot, 'scripts', 'test-sandbox.js'));
  const { createSessionManager } = botRequire('../utils/sessionManager.js');
  const { startDashboardSync } = botRequire('../utils/dashboardSync.js');
  const { readWL } = botRequire('../utils/accessControl.js');
  const usage = botRequire('../utils/memberTelemetry.js');
  usage._resetForTests(path.join(root, 'member-usage.json'));

  vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'test'); vi.stubEnv('D1_DATABASE_ID', 'test'); vi.stubEnv('CLOUDFLARE_API_TOKEN', 'test');
  vi.stubEnv('JWT_SECRET_KEY', 'test-session-key-with-more-than-32-chars');
  vi.stubEnv('ADMIN_EMAIL', 'owner@example.com'); vi.stubEnv('EMAIL_VERIFICATION_REQUIRED', 'true');
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const { sql, params } = JSON.parse(String(init.body)) as { sql: string; params: (string | number | null)[] };
    try { return Response.json({ success: true, result: [{ results: db!.prepare(sql).all(...params) }] }); }
    catch (error) { return Response.json({ success: false, errors: [{ message: (error as Error).message }] }, { status: 400 }); }
  }));
  const syncToken = 'synthetic-sync-token-not-a-credential';
  await saveBotConnectionConfig({ botSyncToken: syncToken });
  await upsertAccount({ email: 'owner@example.com', username: 'owner', name: 'Owner', passwordHash: 'not-used', isVerified: true,
    verificationCode: null, codeExpiresAt: null, verificationAttempts: 0, resetCode: null, resetExpiresAt: null, resetAttempts: 0, createdAt: new Date().toISOString() });
  const adminToken = signSessionJwt({ sub: 'owner@example.com', email: 'owner@example.com' });

  async function registerMember(address: string) {
    const credentials = { name: 'Member', email: address, password: 'synthetic-password' };
    expect((await register(request('/api/auth/register', credentials))).status).toBe(201);
    expect((await login(request('/api/auth/login', credentials))).status).not.toBe(200);
    const checked = await verify(request('/api/auth/verify', { email: address, code: email.codes.get(address) }));
    expect(checked.status).toBe(200);
    const signedIn = await login(request('/api/auth/login', credentials));
    expect(signedIn.status).toBe(200);
    return String((await signedIn.json()).token);
  }
  const aliceToken = await registerMember('alice@example.com');
  const bobToken = await registerMember('bob@example.com');
  expect((await status(request('/api/member/status', undefined, aliceToken))).status).toBe(200);

  const wlFile = path.join(root, 'whitelist.json');
  let permissionsReady = false;
  let policyVersion = '';
  const sockets: Array<Record<string, any>> = [];
  const users = () => readWL({ force: true, filePath: wlFile }).users as Array<Record<string, any>>;
  const manager = createSessionManager({
    sessionDir: path.join(root, 'sessions'), enforceClaims: true,
    getVersion: async () => [2, 0, 0],
    loadAuthState: async (dir: string) => {
      fs.mkdirSync(dir, { recursive: true });
      const creds = { registered: false, me: undefined as undefined | { id: string } };
      return { state: { creds }, saveCreds: async () => fs.writeFileSync(path.join(dir, 'creds.json'), JSON.stringify(creds)) };
    },
    makeSocket: ({ auth }: { auth: { creds: { registered: boolean; me?: { id: string } } } }) => {
      const sock: Record<string, any> = { ev: new EventEmitter(), auth, requestPairingCode: async () => 'TEST-CODE',
        end: async () => {}, sendMessage: async () => ({}), logout: async () => { sock.loggedOut = true; } };
      sockets.push(sock); return sock;
    },
    isAllowed: (number: string) => permissionsReady && users().some((item) => item.number === number && item.enabled),
    canPair: (number: string) => permissionsReady && users().some((item) => item.number === number && (item.enabled || item.pairAllowed)),
    getClaim: (number: string) => users().find((item) => item.number === number)?.backupClaim || '',
    onMessage: async () => {}, loggedOutCode: 401,
    log: { warn() {}, error() {}, log() {} },
  });
  await manager.start();
  const client = startDashboardSync({ dashboardUrl: 'https://dashboard.example', token: syncToken, manualOnly: true, wlFile,
    commandPolicy: { version: () => policyVersion, apply: (_disabled: unknown, version: string) => { policyVersion = version; } },
    getStatus: () => manager.status(), requestPairing: (number: string) => manager.requestPair(number),
    unlinkAccount: (number: string, generation: string) => manager.unlinkAccount(number, generation),
    onWhitelistChanged: () => manager.refreshPermissions(),
    onPermissionsReady: () => { permissionsReady = true; manager.refreshPermissions(); },
    fetchImpl: (url: string, init: RequestInit) => sync(new NextRequest(url, { ...init, signal: init.signal || undefined })),
  });
  cleanupBot = async () => { client.stop(); await manager.stop(); usage._resetForTests(null); };
  expect((await client.syncNow()).ok).toBe(true);

  const phone = '265991234567';
  const added = await numbers(request('/api/member/numbers', { number: phone, label: 'Alice' }, aliceToken));
  expect(added.status).toBe(201);
  expect((await added.json()).numbers[0]).toMatchObject({ number: phone, approval: 'pending', enabled: false, pairAllowed: true });
  expect((await approval(request('/api/admin/approvals', { number: phone, action: 'approve' }, aliceToken))).status).toBe(403);
  expect((await approval(request('/api/admin/approvals', { number: phone, action: 'approve' }, adminToken))).status).toBe(409);

  const pendingPair = pair(request('/api/member/pair', { number: phone }, aliceToken));
  await waitFor(() => Number(db!.prepare("SELECT COUNT(*) AS count FROM portal_bot_commands WHERE type = 'pair'").get()?.count) > 0);
  expect((await client.syncNow()).ok).toBe(true);
  await waitFor(() => sockets.some((sock) => sock.__sessionId === `linked:${phone}`));
  const socket = sockets.find((sock) => sock.__sessionId === `linked:${phone}`)!;
  socket.ev.emit('connection.update', { qr: 'synthetic-qr' });
  await waitFor(() => manager.status().accounts.some((item: { number: string; state: string }) => item.number === phone && item.state === 'awaiting_link'));
  await new Promise((resolve) => setImmediate(resolve));
  expect((await client.syncNow()).ok).toBe(true);
  const pairResponse = await pendingPair;
  const pairBody = await pairResponse.json();
  const issued = pairBody.pending ? await (await pairResult(request(`/api/member/pair?requestId=${pairBody.requestId}`, undefined, aliceToken))).json() : pairBody;
  expect(issued).toMatchObject({ code: 'TEST-CODE', expiresInSeconds: 60 });
  expect(socket.__canRespond()).toBe(false);
  expect((await approval(request('/api/admin/approvals', { number: phone, action: 'approve' }, adminToken))).status).toBe(409);

  socket.auth.creds.registered = true; socket.auth.creds.me = { id: `${phone}:1@s.whatsapp.net` };
  socket.ev.emit('creds.update', socket.auth.creds); socket.ev.emit('connection.update', { connection: 'open' });
  expect((await client.syncNow()).ok).toBe(true);
  const linked = await (await status(request('/api/member/status', undefined, aliceToken))).json();
  expect(linked.confirmedLinks).toMatchObject([{ number: phone }]);
  expect(linked.numbers[0]).toMatchObject({ approval: 'pending', enabled: false });
  expect(linked.accounts[0].state).toBe('paused');
  expect(socket.__canRespond()).toBe(false);
  expect(JSON.stringify(linked)).not.toContain(users()[0].backupClaim);
  expect((await approval(request('/api/admin/approvals', { number: phone, action: 'approve' }, adminToken))).status).toBe(200);
  expect(socket.__canRespond()).toBe(false); // dashboard decision must sync to the bot first
  expect((await client.syncNow()).ok).toBe(true);
  expect(socket.__canRespond()).toBe(true);

  usage.recordCommand('song', socket.__memberUsageScope());
  usage.recordCommand('song', socket.__memberUsageScope());
  usage.recordCommand('paper', socket.__memberUsageScope());
  expect((await client.syncNow()).ok).toBe(true);
  const personal = await (await status(request('/api/member/status', undefined, aliceToken))).json();
  expect(personal.personalUsage[0].days[0].commands).toMatchObject({ song: 2, paper: 1 });
  expect(personal.commandsTotal).toBeNull();
  const other = await (await status(request('/api/member/status', undefined, bobToken))).json();
  expect(JSON.stringify(other)).not.toContain(phone);
  expect(other.personalUsage).toEqual([]);

  // A new sign-in on another device still sees historical link evidence and
  // last measured usage while the bot heartbeat is stale.
  const oldHeartbeat = (await getBotHeartbeat())!;
  // Even if a competing heartbeat overwrites its account list, durable
  // claim-scoped link evidence survives independently of liveness.
  await saveBotHeartbeat({ ...oldHeartbeat, lastSeenAt: Date.now() - 60_000, accounts: [], confirmedLinks: [] });
  const signedInAgain = await login(request('/api/auth/login', { email: 'alice@example.com', password: 'synthetic-password' }));
  const returningToken = String((await signedInAgain.json()).token);
  const offline = await (await status(request('/api/member/status', undefined, returningToken))).json();
  expect(offline.botReachable).toBe(false);
  expect(offline.confirmedLinks).toMatchObject([{ number: phone }]);
  expect(offline.personalUsage[0].days[0].commands).toMatchObject({ song: 2, paper: 1 });

  expect((await client.syncNow()).ok).toBe(true);
  const startedUnlink = await unlink(request('/api/member/unlink', { number: phone }, aliceToken));
  expect(startedUnlink.status).toBe(202);
  const unlinkId = (await startedUnlink.json()).requestId;
  expect((await client.syncNow()).ok).toBe(true);
  await waitFor(() => socket.loggedOut === true);
  await new Promise((resolve) => setImmediate(resolve));
  expect((await client.syncNow()).ok).toBe(true);
  expect((await unlinkResult(request(`/api/member/unlink?requestId=${unlinkId}`, undefined, aliceToken))).status).toBe(200);
  expect((await (await status(request('/api/member/status', undefined, aliceToken))).json()).numbers).toEqual([]);
  expect((await numbers(request('/api/member/numbers', { number: phone, label: 'Bob' }, bobToken))).status).toBe(201);
  const reassigned = await (await status(request('/api/member/status', undefined, bobToken))).json();
  expect(reassigned.confirmedLinks).toEqual([]);
  expect(reassigned.personalUsage[0].days).toEqual([]);
  expect(JSON.stringify(reassigned)).not.toContain('"song":2');
}, 20_000);
