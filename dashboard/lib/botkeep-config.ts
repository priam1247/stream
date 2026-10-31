// Only the official Botkeep Developer API is used for hosting controls.
export const BOTKEEP_API_BASE = 'https://api.botkeep.cloud/api/v1/developer';
export function isBotkeepWorkloadId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
