import type { OwnerTab, WhatsAppPage } from '@/lib/control-room';

export type AdminTab = OwnerTab;
export type MemberFilter = 'all' | 'approved' | 'denied';

export const MEMBER_FILTER_LABELS: Record<MemberFilter, string> = { all: 'All', approved: 'Approved', denied: 'Denied' };
export const WHATSAPP_PAGES: { id: WhatsAppPage; label: string }[] = [
  { id: 'numbers', label: 'Numbers' },
  { id: 'commands', label: 'Commands' },
  { id: 'service', label: 'Status' },
  { id: 'power', label: 'Power' },
  { id: 'sync', label: 'Sync' },
  { id: 'hosting', label: 'Hosting' },
];
