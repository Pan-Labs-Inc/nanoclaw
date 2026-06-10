import fs from 'fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DIR } = vi.hoisted(() => ({
  TEST_DIR: '/tmp/nanoclaw-admin-mcp-test',
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    DATA_DIR: `${TEST_DIR}/data`,
    GROUPS_DIR: `${TEST_DIR}/groups`,
  };
});

import { closeDb, initTestDb, runMigrations } from './db/index.js';
import { createAdminMcpHandler } from './admin-mcp.js';

const TOKEN = 'admin-mcp-token-1234567890abcdef1234';

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  runMigrations(initTestDb());
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('Admin MCP endpoint', () => {
  it('is disabled when no token is configured', async () => {
    const handler = createAdminMcpHandler({ token: '' });
    const res = await handler(
      new Request('http://localhost/webhook/admin-mcp', {
        method: 'POST',
        body: '{}',
      }),
    );

    expect(res.status).toBe(404);
  });

  it('rejects requests without the bearer token', async () => {
    const handler = createAdminMcpHandler({ token: TOKEN });
    const res = await handler(
      new Request('http://localhost/webhook/admin-mcp', {
        method: 'POST',
        body: '{}',
      }),
    );

    expect(res.status).toBe(403);
  });

  it('lists exactly the 7 generic tools via tools/list', async () => {
    const handler = createAdminMcpHandler({ token: TOKEN });
    const res = await handler(
      new Request('http://localhost/webhook/admin-mcp', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      }),
    );

    expect(res.status).toBe(200);
    const frame = (await res.json()) as { result: { tools: Array<{ name: string }> } };
    const names = frame.result.tools.map((t) => t.name).sort();
    expect(names).toEqual(
      ['dm_register', 'dm_status', 'group_file_get', 'group_file_put', 'group_mount_set', 'group_put', 'shared_base_write'],
    );
  });
});
