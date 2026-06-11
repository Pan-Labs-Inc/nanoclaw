import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DIR } = vi.hoisted(() => ({
  TEST_DIR: '/tmp/nanoclaw-telegram-start-token-test',
}));

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return {
    ...actual,
    DATA_DIR: `${TEST_DIR}/data`,
    GROUPS_DIR: `${TEST_DIR}/groups`,
  };
});

import { closeDb, initTestDb, runMigrations } from '../db/index.js';
import { getMessagingGroupByPlatform } from '../db/messaging-groups.js';
import { readDmRegistrations } from '../dm-registrations.js';
import { sessionsBaseDir } from '../session-manager.js';
import { createAdminMcpHandler } from '../admin-mcp.js';
import { extractStartToken, tryActivateStartToken } from './telegram-start-token.js';

const TOKEN = 'admin-mcp-token-1234567890abcdef1234';
const START_TOKEN = 'tok_a1b2c3d4e5f6';
const GROUP = 'pan-teen-test-fid-aa11bb';

async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const handler = createAdminMcpHandler({ token: TOKEN });
  const res = await handler(
    new Request('http://localhost/webhook/admin-mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    }),
  );
  const body = (await res.json()) as { result?: { content: Array<{ text: string }> }; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return JSON.parse(body.result!.content[0].text) as Record<string, unknown>;
}

function registerPending(): Promise<Record<string, unknown>> {
  return callTool('dm_register', {
    channel: 'telegram',
    address: START_TOKEN,
    groupName: GROUP,
    require_opt_in: true,
  });
}

/** Read all kind='task' rows across every session inbound.db under the test dir. */
function readSeededTasks(): Array<{ content: string; trigger: number }> {
  const base = sessionsBaseDir();
  if (!fs.existsSync(base)) return [];
  const rows: Array<{ content: string; trigger: number }> = [];
  for (const ag of fs.readdirSync(base)) {
    const agDir = path.join(base, ag);
    for (const sess of fs.readdirSync(agDir)) {
      const dbPath = path.join(agDir, sess, 'inbound.db');
      if (!fs.existsSync(dbPath)) continue;
      const db = new Database(dbPath, { readonly: true });
      try {
        rows.push(
          ...(db
            .prepare("SELECT content, trigger FROM messages_in WHERE kind = 'task'")
            .all() as Array<{ content: string; trigger: number }>),
        );
      } finally {
        db.close();
      }
    }
  }
  return rows;
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  runMigrations(initTestDb());
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('extractStartToken', () => {
  it('extracts the payload from /start <token>', () => {
    expect(extractStartToken(`/start ${START_TOKEN}`, 'pan_bot')).toBe(START_TOKEN);
  });

  it('extracts from the privacy-ON group form /start@bot <token>', () => {
    expect(extractStartToken(`/start@pan_bot ${START_TOKEN}`, 'pan_bot')).toBe(START_TOKEN);
    expect(extractStartToken(`/START@PAN_BOT ${START_TOKEN}`, 'pan_bot')).toBe(START_TOKEN);
  });

  it('rejects a mismatched bot username', () => {
    expect(extractStartToken(`/start@other_bot ${START_TOKEN}`, 'pan_bot')).toBeNull();
  });

  it('rejects bare /start, short payloads, and non-token text', () => {
    expect(extractStartToken('/start', 'pan_bot')).toBeNull();
    expect(extractStartToken('/start hi', 'pan_bot')).toBeNull(); // < 8 chars
    expect(extractStartToken('/start has spaces in it', 'pan_bot')).toBeNull();
    expect(extractStartToken('hello /start tok_a1b2c3d4', 'pan_bot')).toBeNull();
    expect(extractStartToken('/start tok!llegal$chars', 'pan_bot')).toBeNull();
  });
});

describe('tryActivateStartToken', () => {
  it('activates a pending registration: rebinds the messaging group, stamps the store, seeds awareness', async () => {
    await registerPending();

    const result = tryActivateStartToken({
      text: `/start ${START_TOKEN}`,
      botUsername: 'pan_bot',
      platformId: 'telegram:123456789',
    });

    expect(result).toMatchObject({
      groupName: GROUP,
      tokenPlatformId: `telegram:${START_TOKEN}`,
      boundPlatformId: 'telegram:123456789',
      replay: false,
    });

    // Messaging group rebound from the token placeholder to the real chat id.
    expect(getMessagingGroupByPlatform('telegram', `telegram:${START_TOKEN}`)).toBeFalsy();
    expect(getMessagingGroupByPlatform('telegram', 'telegram:123456789')).toBeTruthy();

    // Registration stamped (key stays the token platform id).
    const reg = readDmRegistrations()[`telegram:${START_TOKEN}`];
    expect(reg.activatedAt).toBeTruthy();
    expect(reg.boundPlatformId).toBe('telegram:123456789');

    // Awareness task seeded into the wired agent session (beyond the
    // dm_register-time /welcome task).
    const tasks = readSeededTasks().filter((t) => t.content.includes('channel is now active'));
    expect(tasks).toHaveLength(1);
    expect(tasks[0].trigger).toBe(1);
  });

  it('does not consume non-matching messages or unknown tokens', async () => {
    await registerPending();
    expect(
      tryActivateStartToken({ text: 'hey there', botUsername: 'pan_bot', platformId: 'telegram:1' }),
    ).toBeNull();
    expect(
      tryActivateStartToken({ text: '/start tok_unknown99', botUsername: 'pan_bot', platformId: 'telegram:1' }),
    ).toBeNull();
    // Registration untouched.
    expect(readDmRegistrations()[`telegram:${START_TOKEN}`].activatedAt).toBeUndefined();
  });

  it('refuses activation when the chat already has a messaging group (UNIQUE conflict)', async () => {
    await registerPending();
    // Simulate the chat having messaged the bot before tapping the link.
    await callTool('dm_register', {
      channel: 'telegram',
      address: '123456789',
      groupName: GROUP,
      require_opt_in: false,
    });

    const result = tryActivateStartToken({
      text: `/start ${START_TOKEN}`,
      botUsername: 'pan_bot',
      platformId: 'telegram:123456789',
    });

    expect(result).toBeNull();
    // Registration stays pending; the placeholder messaging group survives.
    expect(readDmRegistrations()[`telegram:${START_TOKEN}`].activatedAt).toBeUndefined();
    expect(getMessagingGroupByPlatform('telegram', `telegram:${START_TOKEN}`)).toBeTruthy();
  });

  it('swallows a same-chat replay but ignores the token from a different chat', async () => {
    await registerPending();
    const first = tryActivateStartToken({
      text: `/start ${START_TOKEN}`,
      botUsername: 'pan_bot',
      platformId: 'telegram:123456789',
    });
    expect(first?.replay).toBe(false);

    const replay = tryActivateStartToken({
      text: `/start ${START_TOKEN}`,
      botUsername: 'pan_bot',
      platformId: 'telegram:123456789',
    });
    expect(replay?.replay).toBe(true);

    const foreign = tryActivateStartToken({
      text: `/start ${START_TOKEN}`,
      botUsername: 'pan_bot',
      platformId: 'telegram:999999999',
    });
    expect(foreign).toBeNull();
  });
});

describe('dm_status telegram activation states', () => {
  it('reports pending before activation and active (with start control event) after', async () => {
    await registerPending();

    const before = await callTool('dm_status', { channel: 'telegram', address: START_TOKEN });
    expect(before).toMatchObject({ registered: true, activationState: 'pending', lastControlEvent: null });

    tryActivateStartToken({
      text: `/start ${START_TOKEN}`,
      botUsername: 'pan_bot',
      platformId: 'telegram:123456789',
    });

    // Status by token still resolves after the rebind (boundPlatformId follow).
    const after = await callTool('dm_status', { channel: 'telegram', address: START_TOKEN });
    expect(after.registered).toBe(true);
    expect(after.activationState).toBe('active');
    expect((after.lastControlEvent as { keyword: string }).keyword).toBe('start');
  });

  it('telegram registration without require_opt_in is active immediately', async () => {
    await callTool('dm_register', {
      channel: 'telegram',
      address: '555000111',
      groupName: GROUP,
      require_opt_in: false,
    });
    const status = await callTool('dm_status', { channel: 'telegram', address: '555000111' });
    expect(status.activationState).toBe('active');
  });
});
