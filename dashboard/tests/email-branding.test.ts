// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { sendPasswordResetEmail, sendVerificationEmail } from '../lib/email-service';

const original = { ...process.env };
afterEach(() => { process.env = { ...original }; vi.unstubAllGlobals(); });

it('uses a neutral sender name without changing a configured delivery address', async () => {
  process.env.RESEND_API_KEY = 'test';
  process.env.EMAIL_FROM = 'ZaFar Bot <legacy-bot@example.com>';
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ({ ok: true }));
  vi.stubGlobal('fetch', fetchMock);
  await sendVerificationEmail('member@example.com', 'Member', '123456');
  const mail = JSON.parse(String(fetchMock.mock.calls[0][1].body));
  expect(mail.from).toBe('Control Room <legacy-bot@example.com>');
  expect(`${mail.subject} ${mail.text} ${mail.html}`).not.toMatch(/zafar|\bbot\b/i);
});

it('keeps an unrelated configured sender and uses neutral reset text', async () => {
  process.env.RESEND_API_KEY = 'test';
  process.env.EMAIL_FROM = 'Support <support@example.com>';
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ({ ok: true }));
  vi.stubGlobal('fetch', fetchMock);
  await sendPasswordResetEmail('member@example.com', '654321');
  const mail = JSON.parse(String(fetchMock.mock.calls[0][1].body));
  expect(mail.from).toBe('Support <support@example.com>');
  expect(`${mail.subject} ${mail.text} ${mail.html}`).not.toMatch(/zafar|\bbot\b/i);
});
