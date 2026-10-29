import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PairingCodeBanner } from '../components/pairing-code-banner';

afterEach(() => { cleanup(); vi.useRealTimers(); });

it('shows linking instructions and expires from the original issuance time', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-29T12:00:10Z'));
  const issuedAt = Date.now() - 10_000;
  render(<PairingCodeBanner activePair={{ ok: true, number: '15550001111', code: 'ABCD-EFGH', issuedAt, expiresInSeconds: 60 }} onDismiss={() => {}} />);
  expect(screen.getByText('ABCD-EFGH')).toBeTruthy();
  expect(screen.getByText('50s')).toBeTruthy();
  expect(screen.getByText(/Linked devices/)).toBeTruthy();
  expect(screen.getByText(/status updates only after linking succeeds/)).toBeTruthy();
  act(() => { vi.advanceTimersByTime(50_500); });
  expect(screen.getByText('Code expired')).toBeTruthy();
  expect(screen.queryByText('ABCD-EFGH')).toBeNull();
  expect(screen.getByRole('button', { name: 'Copy' }).hasAttribute('disabled')).toBe(true);
});
