import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemberHome } from '../components/member-home';
import type { AuthUser, MemberOverviewPayload } from '../lib/types';

const user: AuthUser = { id: 2, name: 'Maya Member', email: 'maya@example.test', username: 'maya', isAdmin: false, isVerified: true, memberAllowed: true };
const overview: MemberOverviewPayload = {
  ok: true, adminEmail: '', memberAllowed: true, botEnabledForMembers: true,
  botServerLinked: true, botReachable: true, botConnected: false, botNumber: null,
  numbers: [{ number: '15550001111', enabled: true }, { number: '15550002222', enabled: false }],
};

afterEach(() => cleanup());

describe('personal workspace home', () => {
  it('counts saved numbers without implying that paused numbers are connected', () => {
    render(<MemberHome user={user} overview={overview} statusUnavailable={false} canAccessScribd={false} onNavigate={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Welcome, Maya' })).toBeTruthy();
    expect(screen.getByText('2 saved')).toBeTruthy();
    expect(screen.queryByText('2 approved')).toBeNull();
    const tools = screen.getByRole('region', { name: 'Your tools' });
    expect(within(tools).getByText('2 saved · manage linking')).toBeTruthy();
    expect(within(tools).getByText('Access requires approval')).toBeTruthy();
  });

  it('does not present stale status, counts or access as current after a failed refresh', () => {
    render(<MemberHome user={user} overview={{ ...overview, botEnabledForMembers: false }} statusUnavailable canAccessScribd={false} onNavigate={() => {}} />);
    expect(screen.getAllByText('Unknown')).toHaveLength(3);
    expect(screen.queryByText('2 saved')).toBeNull();
    expect(screen.getByText('Status unavailable')).toBeTruthy();
    expect(screen.getByText('Access status unavailable')).toBeTruthy();
    expect(screen.queryByText(/New number approvals and pairing are paused/)).toBeNull();
  });

  it('shows a linking pause and opens the correct locked tool', () => {
    const navigate = vi.fn();
    render(<MemberHome user={user} overview={{ ...overview, botEnabledForMembers: false, botServerLinked: false, botReachable: false }} statusUnavailable={false} canAccessScribd={false} onNavigate={navigate} />);
    expect(screen.getByText('New number approvals and pairing are paused.')).toBeTruthy();
    expect(screen.getByText('Not linked')).toBeTruthy();
    fireEvent.click(within(screen.getByRole('region', { name: 'Your tools' })).getByRole('button', { name: /Scribd/ }));
    expect(navigate).toHaveBeenCalledWith('scribd');
  });
});
