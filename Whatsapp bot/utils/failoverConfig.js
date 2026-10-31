'use strict';

// Failover is deliberately opt-in: an older, independently running bot cannot
// participate safely until it has been updated and configured as a lease peer.
function getFailoverRole(env, admin) {
  const role = String(env.WHATSAPP_FAILOVER_ROLE || '').trim().toLowerCase();
  if (!role) return null;
  if (role !== 'xs' && role !== 'botkeep') throw new Error('WHATSAPP_FAILOVER_ROLE must be xs or botkeep.');
  const actualServer = String(env.SERVER_UUID || env.P_SERVER_UUID || '').trim().toLowerCase();
  const xsServer = '381c9516-ac72-4b42-a4e3-e16bb7f9f4a0';
  if (actualServer && ((role === 'xs' && actualServer !== xsServer) || (role === 'botkeep' && actualServer === xsServer))) {
    throw new Error('Failover role does not match this hosting server UUID.');
  }
  const token = String(admin?.syncToken || '').trim();
  if (!token || !String(admin?.dashboardUrl || '').trim()) {
    throw new Error('Failover requires DASHBOARD_URL and this host’s private dashboard sync token.');
  }
  if (token.length < 32 || token.length > 512) {
    throw new Error('A host-specific failover sync token must be between 32 and 512 characters.');
  }
  try {
    if (new URL(admin.dashboardUrl).protocol !== 'https:') throw new Error('HTTPS required');
  } catch { throw new Error('Failover requires an HTTPS dashboard URL.'); }
  // Current encrypted snapshots have one namespace. Sharing it between two
  // independent WhatsApp devices would overwrite/conflict with primary state.
  if (role === 'botkeep' && String(env.SESSION_BACKUP_KEY || '').trim()) {
    throw new Error('Encrypted recovery is primary-only in failover mode; clear SESSION_BACKUP_KEY on the independently paired backup.');
  }
  return role;
}

module.exports = { getFailoverRole };
