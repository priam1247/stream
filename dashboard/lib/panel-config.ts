// Only the HiddenCloud panel (Pterodactyl-compatible client API) is used for
// hosting controls. The panel base URL is fixed so a credential can never be
// forwarded to a browser-supplied address.
export const PANEL_BASE_URL = 'https://freepanel.hidencloud.com';

// troyzafarings — Free Server #236941. The short identifier shown in the panel
// URL (https://freepanel.hidencloud.com/server/a6451c6c/settings) is used by
// the client API; the full UUID from Debug Information also appears there, so
// both shapes are accepted by isPanelServerId.
export const DEFAULT_PANEL_SERVER_ID = 'a6451c6c';

export function isPanelServerId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
