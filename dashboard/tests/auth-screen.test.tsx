import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AuthScreen } from '../components/auth-screen';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('keeps the sign-in card with accessible fields and changes the fox greeting for registration', () => {
  render(<AuthScreen onAuthenticated={vi.fn()} />);
  expect(screen.getByText('Hi, welcome to zAfAr! Sign in or create an account to link your number with the zAfAr WhatsApp bot.')).toBeTruthy();
  expect(screen.queryByText('Control Room')).toBeNull();
  expect(screen.queryByText('Console Access')).toBeNull();
  expect(screen.getByLabelText('Email').getAttribute('autocomplete')).toBe('email');
  expect(screen.getByLabelText('Password').getAttribute('autocomplete')).toBe('current-password');
  expect(screen.getByLabelText('Email').className).toContain('text-base');
  fireEvent.click(screen.getByRole('button', { name: 'Register' }));
  expect(screen.getByText(/Create your account to link your number/)).toBeTruthy();
  expect(screen.getByLabelText('Password').getAttribute('autocomplete')).toBe('new-password');
});

it('uses the single login response’s backend role rather than making a role request', async () => {
  const onAuthenticated = vi.fn();
  const fetchMock = vi.fn(async (_input: RequestInfo | URL) => ({ ok: true, json: async () => ({ token: 'token', user: { email: 'owner@example.com', isAdmin: true } }) }));
  vi.stubGlobal('fetch', fetchMock);
  render(<AuthScreen onAuthenticated={onAuthenticated} />);
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'owner@example.com' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password' } });
  fireEvent.submit(screen.getByLabelText('Password').closest('form')!);
  await waitFor(() => expect(onAuthenticated).toHaveBeenCalledWith(expect.objectContaining({ user: expect.objectContaining({ isAdmin: true }) })));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0][0]).toBe('/api/auth/login');
});

it('sends a no-verification registration back to sign-in instead of a nonexistent code step', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ requiresVerification: false, message: 'Account created! You can now sign in.' }) })));
  render(<AuthScreen onAuthenticated={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Register' }));
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Maya' } });
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'maya@example.com' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password' } });
  fireEvent.submit(screen.getByLabelText('Password').closest('form')!);
  expect(await screen.findByText('Account created! You can now sign in.')).toBeTruthy();
  expect(within(screen.getByLabelText('Password').closest('form')!).getByRole('button', { name: 'Sign in' })).toBeTruthy();
  expect(screen.queryByLabelText('6-digit code')).toBeNull();
});
