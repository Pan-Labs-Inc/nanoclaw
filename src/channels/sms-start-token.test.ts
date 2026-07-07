/**
 * SMS start-token activation (#1018 SMS slice / #1419).
 *
 * SMS is a born-suppressed start-token channel like Telegram/cli — it differs
 * ONLY in transport (a Twilio webhook carrying `START <token>` instead of a
 * deep-link tap or a cli line). This proves the SMS webhook drives the shared
 * `tryActivateStartToken` core end-to-end: it stamps `activatedAt` (the single
 * activation truth the host-sweep wake gate reads), rebinds the `sms:<token>`
 * placeholder onto the real phone, and seeds the activation-awareness task.
 *
 * The RED assertion (#1419): before this slice the webhook ran a bespoke
 * control-event path that never stamped `activatedAt`, so
 * `isUnredeemedStartTokenPlaceholder(phone)` stayed TRUE forever and host-sweep
 * skipped the session — onboarding never fired.
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';

const { TEST_DIR } = vi.hoisted(() => ({
  TEST_DIR: '/tmp/nanoclaw-sms-start-token-test',
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
import { isUnredeemedStartTokenPlaceholder } from './start-token.js';
import { createSmsWebhookHandler, type SmsConfig } from './sms.js';
import type { ChannelSetup } from './adapter.js';

const ADMIN_TOKEN = 'admin-mcp-token-1234567890abcdef1234';
const START_TOKEN = 'brave-otter-clever-river'; // kebab, human-readable, matches [A-Za-z0-9_-]{8,64}
const GROUP = 'pan-teen-test-fid-aa11bb';
const PHONE = '+13476689441';
const SHARED_NUMBER = '+15550001111';

async function dmRegister(args: Record<string, unknown>): Promise<void> {
  const handler = createAdminMcpHandler({ token: ADMIN_TOKEN });
  const res = await handler(
    new Request('http://localhost/webhook/admin-mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'dm_register', arguments: args },
      }),
    }),
  );
  const body = (await res.json()) as { error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
}

/** A born-suppressed SMS registration keyed by the `sms:<token>` placeholder. */
function registerPendingSms(): Promise<void> {
  return dmRegister({ channel: 'sms', address: START_TOKEN, groupName: GROUP, require_opt_in: true });
}

function smsConfig(): SmsConfig {
  return {
    accountSid: 'AC00000000000000000000000000000000',
    authToken: 'test-auth-token-secret',
    sender: SHARED_NUMBER,
    validateSignature: false,
    validateCredentials: false,
  };
}

function setup(overrides: Partial<ChannelSetup> = {}): ChannelSetup {
  return {
    onInbound: () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
    ...overrides,
  };
}

async function postInbound(body: string, from = PHONE): Promise<Response> {
  const handler = createSmsWebhookHandler(smsConfig(), setup());
  const params = new URLSearchParams({ From: from, To: SHARED_NUMBER, Body: body });
  return handler(
    new Request('http://localhost/webhook/sms', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    }),
    { waitUntil: () => {} },
  );
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
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('SMS webhook — start-token activation (#1419)', () => {
  it('activates a pending sms:<token> registration on "START <token>": stamps activatedAt, rebinds, seeds awareness', async () => {
    await registerPendingSms();

    // RED before the fix: the placeholder is unredeemed and the wake gate agrees.
    expect(isUnredeemedStartTokenPlaceholder(`sms:${START_TOKEN}`)).toBe(true);

    const res = await postInbound(`START ${START_TOKEN}`);
    expect(res.status).toBe(200);

    // Registration stamped by the shared core (key stays the token placeholder).
    const reg = readDmRegistrations()[`sms:${START_TOKEN}`];
    expect(reg.activatedAt).toBeTruthy();
    expect(reg.boundPlatformId).toBe(PHONE);

    // Placeholder messaging group rebound from `sms:<token>` onto the real phone.
    expect(getMessagingGroupByPlatform('sms', `sms:${START_TOKEN}`)).toBeFalsy();
    expect(getMessagingGroupByPlatform('sms', PHONE)).toBeTruthy();

    // The #1419 AC: the wake gate now resolves the bound group as LIVE, so
    // host-sweep will wake the container and fire Day-1 — no manual state edit.
    expect(isUnredeemedStartTokenPlaceholder(PHONE)).toBe(false);

    // Activation-awareness task seeded (drives the Day-1 greeting).
    const tasks = readSeededTasks().filter((t) => t.content.includes('channel is now active'));
    expect(tasks).toHaveLength(1);
    expect(tasks[0].trigger).toBe(1);
  });

  it('a bare CTIA START (no token) does NOT activate a pending persona — consent gate holds', async () => {
    await registerPendingSms();

    // Bare "START" is < 8 chars → never matches a token → the core ignores it.
    // It is the CTIA re-subscribe keyword, not an activation credential.
    const res = await postInbound('START');
    expect(res.status).toBe(200);

    const reg = readDmRegistrations()[`sms:${START_TOKEN}`];
    expect(reg.activatedAt).toBeUndefined();
    expect(isUnredeemedStartTokenPlaceholder(`sms:${START_TOKEN}`)).toBe(true);
  });

  it('an unknown token passes through without activating anything', async () => {
    await registerPendingSms();
    const res = await postInbound('START some-other-unknown-token');
    expect(res.status).toBe(200);
    expect(readDmRegistrations()[`sms:${START_TOKEN}`].activatedAt).toBeUndefined();
  });
});
