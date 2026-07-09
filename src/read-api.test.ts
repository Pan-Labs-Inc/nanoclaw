import fs from 'fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DIR } = vi.hoisted(() => ({
  TEST_DIR: '/tmp/nanoclaw-read-api-test',
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
import { createAgentGroup } from './db/agent-groups.js';
import { createSession } from './db/sessions.js';
import { initSessionFolder, writeOutboundDirect, writeSessionMessage } from './session-manager.js';
import { createReadApiHandler } from './read-api.js';

const TOKEN = 'read-api-token-1234567890abcdef1234';

function get(handler: ReturnType<typeof createReadApiHandler>, query: string, token: string | null = TOKEN) {
  return handler(
    new Request(`http://localhost/api/read/message-history?${query}`, {
      method: 'GET',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }),
  );
}

type Envelope = {
  ok: boolean;
  data?: { messages: Array<Record<string, unknown>>; nextCursor: string | null };
  error?: { code: string };
};

async function body(response: Response): Promise<Envelope> {
  return (await response.json()) as Envelope;
}

describe('read API — message-history', () => {
  beforeEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    fs.mkdirSync(`${TEST_DIR}/data`, { recursive: true });
    runMigrations(initTestDb());

    createAgentGroup({
      id: 'ag-1',
      name: 'Pan Teen calm-acre',
      folder: 'pan-teen-calm-acre',
      agent_provider: null,
      created_at: '2026-07-01T00:00:00.000Z',
    });
    createSession({
      id: 'sess-1',
      agent_group_id: 'ag-1',
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: '2026-07-01T00:00:00.000Z',
    });
    initSessionFolder('ag-1', 'sess-1');

    writeSessionMessage('ag-1', 'sess-1', {
      id: 'in-1',
      kind: 'chat',
      timestamp: '2026-07-01T10:00:00.000Z',
      platformId: 'cli:local',
      channelType: 'cli',
      content: JSON.stringify({ text: 'hello pan', sender: 'cli' }),
    });
    writeOutboundDirect('ag-1', 'sess-1', {
      id: 'out-1',
      kind: 'chat',
      platformId: 'cli:local',
      channelType: 'cli',
      threadId: null,
      content: JSON.stringify({ text: 'hello teen' }),
    });
  });

  afterEach(() => {
    closeDb();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('rejects a missing or wrong token', async () => {
    const handler = createReadApiHandler({ token: TOKEN });
    expect((await get(handler, 'groupName=pan-teen-calm-acre', null)).status).toBe(403);
    expect((await get(handler, 'groupName=pan-teen-calm-acre', 'wrong')).status).toBe(403);
  });

  it('rejects a group outside the prefix scope', async () => {
    const handler = createReadApiHandler({ token: TOKEN, groupPrefixes: 'other-' });
    const response = await get(handler, 'groupName=pan-teen-calm-acre');
    expect(response.status).toBe(403);
    expect((await body(response)).error?.code).toBe('forbidden');
  });

  it('merges inbound and outbound in (ts, id) order with parsed text', async () => {
    const handler = createReadApiHandler({ token: TOKEN, groupPrefixes: 'pan-' });
    const response = await get(handler, 'groupName=pan-teen-calm-acre');
    expect(response.status).toBe(200);
    const { data } = await body(response);
    expect(data?.messages.map((m) => [m.direction, m.text])).toEqual([
      ['inbound', 'hello pan'],
      ['outbound', 'hello teen'],
    ]);
    expect(data?.nextCursor).toBeNull();
  });

  it('returns empty for an unknown group', async () => {
    const handler = createReadApiHandler({ token: TOKEN });
    const { data } = await body(await get(handler, 'groupName=pan-teen-unknown'));
    expect(data?.messages).toEqual([]);
  });

  it('paginates with an opaque cursor', async () => {
    const handler = createReadApiHandler({ token: TOKEN });
    const first = await body(await get(handler, 'groupName=pan-teen-calm-acre&limit=1'));
    expect(first.data?.messages).toHaveLength(1);
    expect(first.data?.nextCursor).toBeTruthy();

    const second = await body(
      await get(handler, `groupName=pan-teen-calm-acre&limit=1&cursor=${first.data?.nextCursor}`),
    );
    expect(second.data?.messages).toHaveLength(1);
    expect(second.data?.messages[0].id).not.toBe(first.data?.messages[0].id);
  });

  it('rejects malformed cursors and unknown resources', async () => {
    const handler = createReadApiHandler({ token: TOKEN });
    expect((await get(handler, 'groupName=pan-teen-calm-acre&cursor=%%%')).status).toBe(400);
    const unknown = await handler(
      new Request('http://localhost/api/read/nope', {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
    );
    expect(unknown.status).toBe(404);
  });
});
