// Per-command copy of the log sanitiser (rule 2).
// ESM default export, matching what engine/core/log.js imports.
function redactSecrets(input) {
  let s = String(input ?? '');
  s = s.replace(/\b((?:Bearer|Basic)\s+)[A-Za-z0-9._~+|/=-]{8,}/gi, '$1[REDACTED]');
  s = s.replace(/\b\d+\|[A-Za-z0-9]{20,}\b/g, '[REDACTED_TOKEN]');
  s = s.replace(/([?&](?:api_?key|token|key)=)[^&\s]+/gi, '$1[REDACTED]');
  s = s.replace(/\b((?:https?|socks5?):\/\/[^:/@\s]+):([^@\s]+)@/gi, '$1:***@');
  return s;
}
function safeText(v) {
  if (v instanceof Error) return redactSecrets(v.message || String(v));
  if (typeof v === 'string') return redactSecrets(v);
  try { return redactSecrets(JSON.stringify(v)); } catch { return redactSecrets(String(v)); }
}
const api = { redactSecrets, safeText, redactArg: safeText, formatArgs: (a) => a.map(safeText).join(' ') };
export default api;
export { redactSecrets, safeText };
