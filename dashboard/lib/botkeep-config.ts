// Only the official Botkeep Developer API is used for hosting controls.
export const BOTKEEP_API_BASE = 'https://api.botkeep.cloud/api/v1/developer';

// The service's reverse proxy on its public address. Used as the direct-bridge
// default when nothing is configured; BOTKEEP_BOT_API_URL or a saved dashboard
// setting still overrides it, and saving an empty URL leaves heartbeat-only mode.
export const DEFAULT_BOT_API_URL = 'https://troy.hidenplay.net';
export function isBotkeepWorkloadId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
