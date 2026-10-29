// @vitest-environment node
import { expect, it } from 'vitest';
import { DEFAULT_SCRIBD_WEB_URL } from '../lib/scribd-config';
import { DEFAULT_SCRIBD_PANEL_URL } from '../lib/storage';

it('keeps the legacy panel default aligned with the current Scribd server', () => {
  expect(DEFAULT_SCRIBD_WEB_URL).toBe('http://195.123.189.181:25803');
  expect(DEFAULT_SCRIBD_PANEL_URL).toBe(DEFAULT_SCRIBD_WEB_URL);
});
