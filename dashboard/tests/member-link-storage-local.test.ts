// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';

it('keeps local link evidence separate from liveness and deletes it on unlink', async () => {
  const original = process.cwd();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-link-store-'));
  vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', '');
  vi.stubEnv('D1_DATABASE_ID', '');
  vi.stubEnv('CLOUDFLARE_API_TOKEN', '');
  try {
    process.chdir(root);
    vi.resetModules();
    const storage = await import('../lib/storage');
    expect(await storage.saveMemberWhatsAppUser('265991234567', 'Member', 'member@example.com')).toBe(true);
    const member = (await storage.listStoredWhatsAppUsers('member@example.com'))[0];
    const link = { number: member.number, sessionId: 'a'.repeat(24),
      claimToken: storage.sessionBackupClaim(member).token, observedAt: Date.now() };
    await storage.saveConfirmedMemberLinks([link], [member]);
    expect(await storage.listConfirmedMemberLinks([member])).toEqual([link]);
    expect(await storage.getBotHeartbeat()).toBeNull();
    const receivedAt = Date.now();
    await storage.saveBotHeartbeatIfNewer({ lastSeenAt: receivedAt, connected: false, botNumber: null });
    await storage.saveBotHeartbeatIfNewer({ lastSeenAt: receivedAt - 1, connected: true, botNumber: null });
    expect(await storage.getBotHeartbeat()).toMatchObject({ lastSeenAt: receivedAt, connected: false });
    expect(await storage.deleteWhatsAppUserIfOwned(member.number, member.addedBy!, member.claimId)).toBe(true);
    await storage.saveConfirmedMemberLinks([link], [member]);
    expect(await storage.listConfirmedMemberLinks([member])).toEqual([]);
    expect(await storage.saveMemberWhatsAppUser(member.number, 'Member', 'member@example.com')).toBe(true);
    const pending = (await storage.listStoredWhatsAppUsers('member@example.com'))[0];
    const claim = storage.sessionBackupClaim(pending).identity;
    const cooldown = await storage.claimPairCooldown(pending.number, Date.now(), claim);
    expect(cooldown.ok).toBe(true);
    expect(await storage.cancelPendingWhatsAppUser(pending.number, claim.owner, claim.key)).toBe(false);
    await storage.releasePairCooldown(pending.number, cooldown.retryAt);
    expect(await storage.cancelPendingWhatsAppUser(pending.number, claim.owner, claim.key)).toBe(true);
    expect((await storage.claimPairCooldown(pending.number, Date.now(), claim)).ok).toBe(false);
    for (let i = 0; i < 12; i++) await storage.enqueueBotCommand({ type: 'pair', payload: { number: member.number } });
    const claimed = await storage.claimPendingBotCommands();
    expect(claimed).toHaveLength(12);
    await storage.releaseClaimedBotCommands(claimed.map((item) => item.id));
    expect(await storage.claimPendingBotCommands()).toHaveLength(12);
  } finally {
    process.chdir(original);
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
