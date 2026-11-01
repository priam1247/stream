export interface AuthUser {
  id: number | string;
  name: string;
  email: string;
  username: string;
  isVerified: boolean;
  isAdmin: boolean;
  memberAllowed: boolean;
  /** Explicit access to the shared Scribd library; owners always have access. */
  scribdAllowed?: boolean;
  createdAt?: string;
}

export interface UserQuota {
  papers_downloaded_today: number;
  papers_limit: number;
  papers_left: number;
  books_downloaded_today: number;
  books_limit: number;
  books_left: number;
}

export interface MemberRecord {
  email: string;
  name: string;
  isVerified: boolean;
  isAdmin: boolean;
  allowed: boolean;
  scribdAllowed: boolean;
  numbersCount: number;
  createdAt: string;
}

export type ActivityCategory = 'account' | 'members' | 'numbers' | 'bot' | 'scribd';
export type ActivityOutcome = 'success' | 'failed' | 'requested';

export interface ActivityEvent {
  id: string;
  category: ActivityCategory;
  action: string;
  actor: string;
  outcome: ActivityOutcome;
  detail: string;
  createdAt: string;
}

export type WhitelistSyncState = 'synced' | 'pending' | 'unknown';
export interface PanelLiveStatus {
  configured: boolean | null;
  reachable: boolean | null;
  state: 'running' | 'offline' | 'starting' | 'stopping' | 'suspended' | 'unknown';
  error: string | null;
  checkedAt: number;
}

export type NumberApproval = 'pending' | 'approved' | 'rejected';
export interface ApprovedUser {
  number: string;
  label?: string;
  enabled: boolean;
  /** Existing numbers are grandfathered; newly linked numbers need approval. */
  approval?: NumberApproval;
  /** Pending numbers may link, but cannot execute commands until approved. */
  pairAllowed?: boolean;
  /** Opaque ownership generation, used to scope encrypted backups. */
  claimId?: string;
  addedAt?: string;
  addedBy?: string;
}

export interface BotConnectionConfig {
  botApiUrl: string;
  botAdminToken: string;
  botSyncToken: string;
  botEnabledForMembers: boolean;
  updatedAt?: string;
}

export interface PanelConnectionConfig {
  panelUrl: string;
  panelServerId: string;
  panelApiKey: string;
  updatedAt?: string;
}

export interface ScribdConnectionConfig {
  panelUrl: string;
  panelKey: string;
  updatedAt?: string;
}

export interface PanelServerSummary {
  id: string;
  uuid: string;
  name: string;
}

export type WhatsAppAccountState = 'connected' | 'connecting' | 'awaiting_link' | 'expired' | 'logged_out' | 'paused';
export interface WhatsAppAccountStatus {
  number: string;
  state: WhatsAppAccountState;
  /** Opaque per-link generation; never identifies the legacy primary session. */
  sessionId?: string;
  /** Internal ownership correlation from the service, stripped from member responses. */
  claimToken?: string;
  claimCurrent?: boolean;
  linkedAt?: number;
}

/** Private service-side evidence. Ownership tokens never leave member APIs. */
export interface ConfirmedMemberLink {
  number: string;
  sessionId: string;
  claimToken: string;
  observedAt: number;
  linkedAt?: number;
}

export interface MemberUsageDay {
  date: string;
  commands: Record<string, number>;
}

export interface ServiceMemberUsage {
  startedAt: number;
  updatedAt: number;
  sessions: {
    number: string;
    sessionId: string;
    claimToken: string;
    days: MemberUsageDay[];
    lastAt?: number;
    lastCommand?: string;
  }[];
}

export interface PersonalUsage {
  number: string;
  trackedSince: number;
  updatedAt: number;
  days: MemberUsageDay[];
  lastAt?: number;
  lastCommand?: string;
}

export interface BotHeartbeatRecord {
  lastSeenAt: number;
  connected: boolean | null;
  botNumber: string | null;
  accounts?: WhatsAppAccountStatus[];
  /** Last confirmed links survive a service outage; they do not grant access. */
  confirmedLinks?: ConfirmedMemberLink[];
  memberUsage?: ServiceMemberUsage;
  botName?: string;
  version?: string;
  uptimeSeconds?: number;
  commandsTotal?: number;
  downloadsSuccess?: number;
  failedTotal?: number;
  ramUsedMB?: number;
  diskUsedMB?: number;
  diskBudgetMB?: number;
  queueLight?: number;
  queueHeavy?: number;
  /** Version of the last whitelist snapshot the bot reports applying. */
  whitelistVersion?: string;
  commandPolicyVersion?: string;
  sessionBackup?: { state: 'disabled' | 'starting' | 'ready' | 'error' | 'conflict'; lastBackupAt: number | null; sessions?: number; backedUp?: number };
}

export interface BotCommandRecord {
  id: string;
  type: 'pair' | 'restart' | 'unlink';
  payload: Record<string, unknown>;
  status: 'pending' | 'claimed' | 'completed' | 'failed';
  result?: Record<string, unknown> | null;
  error?: string | null;
  requestedBy?: string;
  createdAt: number;
  expiresAt: number;
}

export interface AdminOverviewPayload {
  ok: boolean;
  adminEmail: string;
  botServerLinked: boolean;
  botApiUrl: string;
  hasBotToken: boolean;
  hasBotSyncToken?: boolean;
  botEnabledForMembers: boolean;
  storageEngine: 'bot-live' | 'cloudflare-d1' | 'persistent-db';
  connectionMode?: 'heartbeat' | 'direct' | 'unconfigured';
  upstreamHost?: string | null;
  isInsecureHttp?: boolean;
  botReachable?: boolean;
  botError?: string | null;
  connected: boolean | null;
  botNumber: string | null;
  accounts?: WhatsAppAccountStatus[] | null;
  lastSeenAt?: number | null;
  lastSeenSecondsAgo?: number | null;
  whitelistSync?: WhitelistSyncState;
  botVersion?: string | null;
  uptimeSeconds?: number | null;
  commandsTotal?: number | null;
  downloadsSuccess?: number | null;
  failedTotal?: number | null;
  ramUsedMB?: number | null;
  diskUsedMB?: number | null;
  diskBudgetMB?: number | null;
  queueLight?: number | null;
  queueHeavy?: number | null;
  panelConfigured?: boolean;
  panelUrl?: string;
  panelServerId?: string;
  hasPanelApiKey?: boolean;
  scribdTokenConfigured?: boolean;
  scribdSecureTransport?: boolean;
  users: ApprovedUser[];
  members: MemberRecord[];
  latencyMs?: number;
  sessionBackup?: { state: 'disabled' | 'starting' | 'ready' | 'error' | 'conflict'; lastBackupAt: number | null; sessions?: number; backedUp?: number } | null;
}

export interface MemberOverviewPayload {
  ok: boolean;
  adminEmail: string;
  memberAllowed: boolean;
  botEnabledForMembers: boolean;
  botServerLinked: boolean;
  botReachable?: boolean;
  botError?: string | null;
  lastSeenSecondsAgo?: number | null;
  whitelistSync?: WhitelistSyncState;
  scribdAllowed?: boolean;
  botConnected: boolean | null;
  botNumber: string | null;
  accounts?: WhatsAppAccountStatus[] | null;
  confirmedLinks?: { number: string; linkedAt?: number }[];
  personalUsage?: PersonalUsage[] | null;
  uptimeSeconds?: number | null;
  commandsTotal?: number | null;
  downloadsSuccess?: number | null;
  failedTotal?: number | null;
  ramUsedMB?: number | null;
  diskUsedMB?: number | null;
  diskBudgetMB?: number | null;
  queueLight?: number | null;
  queueHeavy?: number | null;
  numbers: ApprovedUser[];
  disabledMemberCommands?: string[];
}

export interface PairCodePayload {
  ok: boolean;
  code: string;
  expiresInSeconds: number;
  number: string;
  issuedAt: number;
}

export interface CommandEntry {
  name: string;
  aliases: string[];
  category: 'media' | 'vault' | 'admin';
  usage: string;
  example: string;
  summary: string;
  ownerOnly?: boolean;
}

export interface MetadataSourceEntry {
  id: string;
  label: string;
  scope: string;
  keyless: boolean;
  note: string;
}
