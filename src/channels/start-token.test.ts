import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DIR } = vi.hoisted(() => ({
  TEST_DIR: '/tmp/nanoclaw-start-token-test',
}));

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return {
    ...actual,
    DATA_DIR: `${TEST_DIR}/data`,
    GROUPS_DIR: `${TEST_DIR}/groups`,
  };
});

// tryActivateStartToken wakes the bound session's container at redemption
// (#1420) — stub it so tests never attempt a real docker spawn.
vi.mock('../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
}));

import { wakeContainer } from '../container-runner.js';
import { closeDb, initTestDb, runMigrations } from '../db/index.js';
import {
  getMessagingGroupByPlatform,
  getMessagingGroup,
  getMessagingGroupAgents,
  createMessagingGroup,
} from '../db/messaging-groups.js';
import { readDmRegistrations, writeDmRegistrations } from '../dm-registrations.js';
import { sessionsBaseDir } from '../session-manager.js';
import { createAdminMcpHandler } from '../admin-mcp.js';
import { extractStartToken, tryActivateStartToken, isUnredeemedStartTokenPlaceholder } from './start-token.js';
import type { DmRegistration } from '../dm-registrations.js';

const TOKEN = 'admin-mcp-token-1234567890abcdef1234';
const START_TOKEN = 'tok_a1b2c3d4e5f6';
const GROUP = 'pan-teen-test-fid-aa11bb';

const tg = { channel: 'telegram', botUsername: 'pan_bot' };

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
          ...(db.prepare("SELECT content, trigger FROM messages_in WHERE kind = 'task'").all() as Array<{
            content: string;
            trigger: number;
          }>),
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
  vi.mocked(wakeContainer).mockClear();
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('extractStartToken — Telegram (/start command form)', () => {
  it('extracts the payload from /start <token>', () => {
    expect(extractStartToken(`/start ${START_TOKEN}`, tg)).toBe(START_TOKEN);
  });

  it('extracts from the privacy-ON group form /start@bot <token>', () => {
    expect(extractStartToken(`/start@pan_bot ${START_TOKEN}`, tg)).toBe(START_TOKEN);
    expect(extractStartToken(`/START@PAN_BOT ${START_TOKEN}`, tg)).toBe(START_TOKEN);
  });

  it('rejects a mismatched bot username', () => {
    expect(extractStartToken(`/start@other_bot ${START_TOKEN}`, tg)).toBeNull();
  });

  it('rejects bare /start, short payloads, and non-token text', () => {
    expect(extractStartToken('/start', tg)).toBeNull();
    expect(extractStartToken('/start hi', tg)).toBeNull(); // < 8 chars
    expect(extractStartToken('/start has spaces in it', tg)).toBeNull();
    expect(extractStartToken('hello /start tok_a1b2c3d4', tg)).toBeNull();
    expect(extractStartToken('/start tok!llegal$chars', tg)).toBeNull();
  });

  it('does NOT accept a bare token on Telegram (command form required)', () => {
    expect(extractStartToken(START_TOKEN, tg)).toBeNull();
  });
});

describe('extractStartToken — generic channels (SMS, cli)', () => {
  for (const channel of ['sms', 'cli']) {
    it(`[${channel}] accepts "start <token>", "/start <token>", and a bare token`, () => {
      expect(extractStartToken(`start ${START_TOKEN}`, { channel })).toBe(START_TOKEN);
      expect(extractStartToken(`START ${START_TOKEN}`, { channel })).toBe(START_TOKEN);
      expect(extractStartToken(`/start ${START_TOKEN}`, { channel })).toBe(START_TOKEN);
      expect(extractStartToken(START_TOKEN, { channel })).toBe(START_TOKEN);
      expect(extractStartToken(`  ${START_TOKEN}  `, { channel })).toBe(START_TOKEN);
    });

    it(`[${channel}] rejects short payloads, illegal chars, and prose`, () => {
      expect(extractStartToken('start hi', { channel })).toBeNull(); // < 8 chars
      expect(extractStartToken('start has spaces in it', { channel })).toBeNull();
      expect(extractStartToken('hey what is this', { channel })).toBeNull();
      expect(extractStartToken(`start ${START_TOKEN}!extra`, { channel })).toBeNull();
    });
  }
});

describe('tryActivateStartToken — Telegram', () => {
  it('activates a pending registration: rebinds the messaging group, stamps the store, seeds awareness', async () => {
    await registerPending();

    const result = tryActivateStartToken({
      text: `/start ${START_TOKEN}`,
      channel: 'telegram',
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
      tryActivateStartToken({
        text: 'hey there',
        channel: 'telegram',
        botUsername: 'pan_bot',
        platformId: 'telegram:1',
      }),
    ).toBeNull();
    expect(
      tryActivateStartToken({
        text: '/start tok_unknown99',
        channel: 'telegram',
        botUsername: 'pan_bot',
        platformId: 'telegram:1',
      }),
    ).toBeNull();
    // Registration untouched.
    expect(readDmRegistrations()[`telegram:${START_TOKEN}`].activatedAt).toBeUndefined();
  });

  it('refuses activation when a DM chat already has a messaging group (UNIQUE conflict)', async () => {
    await registerPending();
    // Simulate the chat having messaged the bot before tapping the link.
    // Positive chat id = a 1:1 DM, where the refusal still holds (#958).
    await callTool('dm_register', {
      channel: 'telegram',
      address: '123456789',
      groupName: GROUP,
      require_opt_in: false,
    });

    const result = tryActivateStartToken({
      text: `/start ${START_TOKEN}`,
      channel: 'telegram',
      botUsername: 'pan_bot',
      platformId: 'telegram:123456789',
    });

    expect(result).toBeNull();
    // Registration stays pending; the placeholder messaging group survives.
    expect(readDmRegistrations()[`telegram:${START_TOKEN}`].activatedAt).toBeUndefined();
    expect(getMessagingGroupByPlatform('telegram', `telegram:${START_TOKEN}`)).toBeTruthy();
  });

  it('clean group bind flips is_group on the rebound placeholder (#958)', async () => {
    await registerPending();
    // Negative chat id = a group; no pre-existing row for it.
    const result = tryActivateStartToken({
      text: `/start ${START_TOKEN}`,
      channel: 'telegram',
      botUsername: 'pan_bot',
      platformId: 'telegram:-1009998887',
    });

    expect(result?.replay).toBe(false);
    expect(getMessagingGroupByPlatform('telegram', `telegram:${START_TOKEN}`)).toBeFalsy();
    const bound = getMessagingGroupByPlatform('telegram', 'telegram:-1009998887');
    expect(bound).toBeTruthy();
    // Group rebind sets is_group=1 (placeholder is born is_group=0) and the
    // policy stays public (born so for require_opt_in registrations).
    expect(bound!.is_group).toBe(1);
    expect(bound!.unknown_sender_policy).toBe('public');
  });

  it('takes over an existing group row instead of refusing (#958)', async () => {
    await registerPending();
    // The bot was already in the target group, so an (unwired, strict) stub row
    // exists for it — the `?startgroup=` add-flow won't re-trigger and the
    // operator redeems by hand with `/start@<bot> <token>`.
    createMessagingGroup({
      id: 'mg-squatter-group',
      channel_type: 'telegram',
      platform_id: 'telegram:-1009998887',
      name: 'pre-existing group',
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: new Date().toISOString(),
    });
    expect(getMessagingGroupAgents('mg-squatter-group')).toHaveLength(0);

    const result = tryActivateStartToken({
      text: `/start@pan_bot ${START_TOKEN}`,
      channel: 'telegram',
      botUsername: 'pan_bot',
      platformId: 'telegram:-1009998887',
    });

    expect(result).toMatchObject({
      groupName: GROUP,
      boundPlatformId: 'telegram:-1009998887',
      replay: false,
    });

    // The stub is evicted; the placeholder (which holds the registration's
    // wiring + session) takes over the chat id and is promoted to a public
    // group. Both the token-placeholder id and the squatter id are gone.
    expect(getMessagingGroupByPlatform('telegram', `telegram:${START_TOKEN}`)).toBeFalsy();
    expect(getMessagingGroup('mg-squatter-group')).toBeUndefined();
    const bound = getMessagingGroupByPlatform('telegram', 'telegram:-1009998887');
    expect(bound).toBeTruthy();
    expect(bound!.id).not.toBe('mg-squatter-group');
    expect(bound!.is_group).toBe(1);
    expect(bound!.unknown_sender_policy).toBe('public');
    // The registration's agent wiring rode across on the surviving placeholder.
    expect(getMessagingGroupAgents(bound!.id)).toHaveLength(1);

    // Registration stamped active, and awareness seeded into the rebound agent.
    expect(readDmRegistrations()[`telegram:${START_TOKEN}`].activatedAt).toBeTruthy();
    const tasks = readSeededTasks().filter((t) => t.content.includes('channel is now active'));
    expect(tasks).toHaveLength(1);
  });

  it('swallows a same-chat replay but ignores the token from a different chat', async () => {
    await registerPending();
    const first = tryActivateStartToken({
      text: `/start ${START_TOKEN}`,
      channel: 'telegram',
      botUsername: 'pan_bot',
      platformId: 'telegram:123456789',
    });
    expect(first?.replay).toBe(false);

    const replay = tryActivateStartToken({
      text: `/start ${START_TOKEN}`,
      channel: 'telegram',
      botUsername: 'pan_bot',
      platformId: 'telegram:123456789',
    });
    expect(replay?.replay).toBe(true);

    const foreign = tryActivateStartToken({
      text: `/start ${START_TOKEN}`,
      channel: 'telegram',
      botUsername: 'pan_bot',
      platformId: 'telegram:999999999',
    });
    expect(foreign).toBeNull();
  });
});

describe('tryActivateStartToken — generic channel (cli)', () => {
  // Seed a pending cli registration + placeholder messaging group directly. The
  // admin-mcp dm_register token-mode for non-telegram channels lands in a later
  // slice; this proves the channel-agnostic activation core in isolation.
  function seedPendingCli(): void {
    const now = new Date().toISOString();
    const regs = readDmRegistrations();
    regs[`cli:${START_TOKEN}`] = {
      groupName: GROUP,
      channel: 'cli',
      address: START_TOKEN,
      registeredAt: now,
      requireOptIn: true,
    };
    writeDmRegistrations(regs);
    createMessagingGroup({
      id: 'mg-cli-placeholder',
      channel_type: 'cli',
      platform_id: `cli:${START_TOKEN}`,
      name: GROUP,
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now,
    });
  }

  it('binds a cli "start <token>" onto the real platform id and stamps the store', () => {
    seedPendingCli();

    const result = tryActivateStartToken({
      text: `start ${START_TOKEN}`,
      channel: 'cli',
      platformId: 'local',
    });

    expect(result).toMatchObject({
      groupName: GROUP,
      tokenPlatformId: `cli:${START_TOKEN}`,
      boundPlatformId: 'local',
      replay: false,
    });
    // Rebound placeholder → real cli platform id.
    expect(getMessagingGroupByPlatform('cli', `cli:${START_TOKEN}`)).toBeFalsy();
    expect(getMessagingGroupByPlatform('cli', 'local')).toBeTruthy();
    // Registration stamped active.
    const reg = readDmRegistrations()[`cli:${START_TOKEN}`];
    expect(reg.activatedAt).toBeTruthy();
    expect(reg.boundPlatformId).toBe('local');
  });

  it('a bare token (no "start" keyword) also activates on cli', () => {
    seedPendingCli();
    const result = tryActivateStartToken({ text: START_TOKEN, channel: 'cli', platformId: 'local' });
    expect(result?.boundPlatformId).toBe('local');
  });

  it('does not cross channels — a telegram token does not match a cli registration', () => {
    seedPendingCli();
    // Same token, wrong channel namespace → no telegram registration exists.
    expect(
      tryActivateStartToken({
        text: `/start ${START_TOKEN}`,
        channel: 'telegram',
        botUsername: 'pan_bot',
        platformId: 'telegram:1',
      }),
    ).toBeNull();
    expect(readDmRegistrations()[`cli:${START_TOKEN}`].activatedAt).toBeUndefined();
  });
});

describe('canned opener + immediate wake (#1420)', () => {
  const OPENER = "hey Jamie — it's Pan. your mom set this up; reply whenever.";

  function registerWithOpener(): Promise<Record<string, unknown>> {
    return callTool('dm_register', {
      channel: 'telegram',
      address: START_TOKEN,
      groupName: GROUP,
      require_opt_in: true,
      canned_opener: OPENER,
    });
  }

  const activate = (platformId = 'telegram:123456789') =>
    tryActivateStartToken({
      text: `/start ${START_TOKEN}`,
      channel: 'telegram',
      botUsername: 'pan_bot',
      platformId,
    });

  it('dm_register persists canned_opener and reports it in the result', async () => {
    const result = await registerWithOpener();
    expect(result.cannedOpener).toBe(true);
    expect(readDmRegistrations()[`telegram:${START_TOKEN}`].cannedOpener).toBe(OPENER);
  });

  it('dm_register without canned_opener reports cannedOpener:false and persists none', async () => {
    const result = await registerPending();
    expect(result.cannedOpener).toBe(false);
    expect(readDmRegistrations()[`telegram:${START_TOKEN}`].cannedOpener).toBeUndefined();
  });

  it('rejects an oversize canned_opener loudly instead of persisting it', async () => {
    await expect(
      callTool('dm_register', {
        channel: 'telegram',
        address: START_TOKEN,
        groupName: GROUP,
        require_opt_in: true,
        canned_opener: 'x'.repeat(8193),
      }),
    ).rejects.toThrow(/canned_opener too long/);
    expect(readDmRegistrations()[`telegram:${START_TOKEN}`]).toBeUndefined();
  });

  it('clean bind returns the registration opener; replay returns null (never re-delivered)', async () => {
    await registerWithOpener();
    const first = activate();
    expect(first?.replay).toBe(false);
    expect(first?.openerText).toBe(OPENER);

    const replay = activate();
    expect(replay?.replay).toBe(true);
    expect(replay?.openerText).toBeNull();
  });

  it('clean bind without a registered opener returns openerText null', async () => {
    await registerPending();
    expect(activate()?.openerText).toBeNull();
  });

  it('wakes the container immediately on a clean bind WITH an opener', async () => {
    await registerWithOpener();
    activate();
    expect(vi.mocked(wakeContainer)).toHaveBeenCalledTimes(1);
  });

  it('wakes the container immediately on a clean bind WITHOUT an opener — the #1420 sweep-wait fix', async () => {
    await registerPending();
    activate();
    expect(vi.mocked(wakeContainer)).toHaveBeenCalledTimes(1);
  });

  it('does not wake on a replay or a non-match', async () => {
    await registerWithOpener();
    activate();
    vi.mocked(wakeContainer).mockClear();

    activate(); // same-chat replay
    tryActivateStartToken({
      text: 'hey there',
      channel: 'telegram',
      botUsername: 'pan_bot',
      platformId: 'telegram:123456789',
    });
    expect(vi.mocked(wakeContainer)).not.toHaveBeenCalled();
  });
});

describe('dm_status telegram activation states', () => {
  it('reports pending before activation and active (with start control event) after', async () => {
    await registerPending();

    const before = await callTool('dm_status', { channel: 'telegram', address: START_TOKEN });
    expect(before).toMatchObject({ registered: true, activationState: 'pending', lastControlEvent: null });

    tryActivateStartToken({
      text: `/start ${START_TOKEN}`,
      channel: 'telegram',
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

describe('isUnredeemedStartTokenPlaceholder (#1068)', () => {
  const reg = (over: Partial<DmRegistration>): DmRegistration => ({
    groupName: GROUP,
    channel: 'telegram',
    address: START_TOKEN,
    registeredAt: '2026-06-22T00:00:00.000Z',
    requireOptIn: true,
    ...over,
  });

  const placeholderPid = `telegram:${START_TOKEN}`;
  const boundPid = 'telegram:-5467520989';

  it('is true while a require_opt_in registration is still pending (no activatedAt)', () => {
    const regs = { [placeholderPid]: reg({}) };
    expect(isUnredeemedStartTokenPlaceholder(placeholderPid, regs)).toBe(true);
  });

  it('is false once the token is redeemed — the bound chat id is not a registration key', () => {
    // After rebind the registration KEY stays the token placeholder but the
    // messaging group now carries the real chat id; a lookup by that id misses.
    const regs = { [placeholderPid]: reg({ activatedAt: '2026-06-22T15:40:49.000Z', boundPlatformId: boundPid }) };
    expect(isUnredeemedStartTokenPlaceholder(boundPid, regs)).toBe(false);
    // And the consumed placeholder id itself is no longer "unredeemed" either.
    expect(isUnredeemedStartTokenPlaceholder(placeholderPid, regs)).toBe(false);
  });

  it('is false for a non-opt-in registration (active immediately, never a placeholder)', () => {
    const regs = { 'telegram:555000111': reg({ address: '555000111', requireOptIn: false }) };
    expect(isUnredeemedStartTokenPlaceholder('telegram:555000111', regs)).toBe(false);
  });

  it('is false for an ordinary chat with no registration, and for null/empty ids', () => {
    expect(isUnredeemedStartTokenPlaceholder('telegram:123', {})).toBe(false);
    expect(isUnredeemedStartTokenPlaceholder(null, {})).toBe(false);
    expect(isUnredeemedStartTokenPlaceholder(undefined, {})).toBe(false);
  });
});
