// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('../lib/auth-engine', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/auth-engine')>(),
  getAuthenticatedSession: vi.fn(async () => ({ user: { email: 'member@example.com', name: 'Member', isAdmin: false, memberAllowed: true } })),
}));

const modules = import.meta.glob<Record<string, unknown>>('../app/api/admin/**/route.ts', { eager: true });
const routes = Object.entries(modules).flatMap(([path, mod]) =>
  ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].filter((method) => typeof mod[method] === 'function')
    .map((method) => ({ path, method, handler: mod[method] as (req: NextRequest, context: { params: Promise<Record<string, string>> }) => Promise<Response> })),
);

it('discovers the complete admin API surface', () => {
  expect(routes.length).toBeGreaterThanOrEqual(14);
});
it.each(routes)('rejects a member on $method $path', async ({ method, handler }) => {
  const request = new NextRequest('http://localhost/api/admin/test', { method });
  const response = await handler(request, { params: Promise.resolve({ number: '265991234567', email: 'member@example.com', id: 'test' }) });
  expect(response.status).toBe(403);
});
