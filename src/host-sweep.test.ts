/**
 * Unit tests for the stuck-container decision logic introduced by
 * ACTION-ITEMS item 9. Lives on the pure helper `decideStuckAction` so we
 * don't have to mock the filesystem or the container runner.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { PLACEHOLDER_TEST_DIR } = vi.hoisted(() => ({
  PLACEHOLDER_TEST_DIR: '/tmp/nanoclaw-host-sweep-placeholder-test',
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: `${PLACEHOLDER_TEST_DIR}/data`, GROUPS_DIR: `${PLACEHOLDER_TEST_DIR}/groups` };
});

import { deleteOrphanProcessingClaims, getProcessingClaims } from './db/session-db.js';
import {
  ABSOLUTE_CEILING_MS,
  CLAIM_STUCK_MS,
  _resetStuckProcessingRowsForTesting,
  decideStuckAction,
  isPendingPlaceholderSession,
  parseSqliteUtc,
  reapDefunctSessionContainers,
} from './host-sweep.js';
import {
  closeDb,
  initTestDb,
  runMigrations,
  createAgentGroup,
  createMessagingGroup,
  createSession,
} from './db/index.js';
import { updateMessagingGroup } from './db/messaging-groups.js';
import { markContainerStopped, resolveSession } from './session-manager.js';
import { readDmRegistrations, writeDmRegistrations } from './dm-registrations.js';
import type { Session } from './types.js';

const BASE = Date.parse('2026-04-20T12:00:00.000Z');

function claim(id: string, offsetMs: number) {
  return { message_id: id, status_changed: new Date(BASE - offsetMs).toISOString() };
}

describe('decideStuckAction', () => {
  it('returns ok when heartbeat is fresh and no claims', () => {
    expect(
      decideStuckAction({
        now: BASE,
        heartbeatMtimeMs: BASE - 5_000,
        containerState: null,
        claims: [],
      }),
    ).toEqual({ action: 'ok' });
  });

  it('returns kill-ceiling when heartbeat older than 30 min', () => {
    const heartbeatMtimeMs = BASE - ABSOLUTE_CEILING_MS - 1_000;
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs,
      containerState: null,
      claims: [],
    });
    expect(res.action).toBe('kill-ceiling');
    if (res.action !== 'kill-ceiling') return;
    expect(res.ceilingMs).toBe(ABSOLUTE_CEILING_MS);
    expect(res.heartbeatAgeMs).toBeGreaterThan(ABSOLUTE_CEILING_MS);
  });

  it('skips the ceiling check when no heartbeat file exists (fresh container not yet ticked)', () => {
    // A freshly-spawned container hasn't produced any SDK events yet, so no
    // heartbeat. Prior behavior treated this as infinitely stale and killed
    // every container within seconds of spawn. With no claims either, we
    // should conclude everything is fine.
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: 0,
      containerState: null,
      claims: [],
    });
    expect(res.action).toBe('ok');
  });

  it('kills on claim-stuck when heartbeat is absent AND a claim has aged past tolerance', () => {
    // Hanging fresh container: spawned, picked up a message (claim recorded
    // in processing_ack), but never wrote a heartbeat. Falls through the
    // skipped ceiling check into claim-stuck — which correctly fires.
    const claimedAgeMs = CLAIM_STUCK_MS + 5_000;
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: 0,
      containerState: null,
      claims: [claim('msg-1', claimedAgeMs)],
    });
    expect(res.action).toBe('kill-claim');
  });

  it('extends the ceiling when Bash has a declared timeout longer than 30 min', () => {
    const twoHrMs = 2 * 60 * 60 * 1000;
    const res = decideStuckAction({
      now: BASE,
      // 45 min — over the default ceiling, but under the Bash timeout
      heartbeatMtimeMs: BASE - 45 * 60 * 1000,
      containerState: {
        current_tool: 'Bash',
        tool_declared_timeout_ms: twoHrMs,
        tool_started_at: new Date(BASE - 45 * 60 * 1000).toISOString(),
      },
      claims: [],
    });
    expect(res.action).toBe('ok');
  });

  it('returns kill-claim when a claim is past 60s and heartbeat has not moved', () => {
    const claimedAgeMs = CLAIM_STUCK_MS + 10_000;
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - claimedAgeMs - 5_000, // older than the claim
      containerState: null,
      claims: [claim('msg-1', claimedAgeMs)],
    });
    expect(res.action).toBe('kill-claim');
    if (res.action !== 'kill-claim') return;
    expect(res.messageId).toBe('msg-1');
    expect(res.toleranceMs).toBe(CLAIM_STUCK_MS);
  });

  it('does not kill when heartbeat has been touched since the claim', () => {
    const claimedAgeMs = CLAIM_STUCK_MS + 10_000;
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - 2_000, // fresh, updated after the claim
      containerState: null,
      claims: [claim('msg-1', claimedAgeMs)],
    });
    expect(res.action).toBe('ok');
  });

  it('does not kill when claim age is below tolerance', () => {
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - CLAIM_STUCK_MS - 10_000, // old, but claim is recent
      containerState: null,
      claims: [claim('msg-1', 5_000)],
    });
    expect(res.action).toBe('ok');
  });

  it('widens per-claim tolerance for a running Bash with long timeout', () => {
    const tenMinMs = 10 * 60 * 1000;
    const res = decideStuckAction({
      now: BASE,
      // 5 min since claim, over the 60s default but under the declared Bash timeout
      heartbeatMtimeMs: BASE - 5 * 60 * 1000 - 5_000,
      containerState: {
        current_tool: 'Bash',
        tool_declared_timeout_ms: tenMinMs,
        tool_started_at: new Date(BASE - 5 * 60 * 1000).toISOString(),
      },
      claims: [claim('msg-1', 5 * 60 * 1000)],
    });
    expect(res.action).toBe('ok');
  });

  it('ignores claims with unparseable timestamps', () => {
    const res = decideStuckAction({
      now: BASE,
      heartbeatMtimeMs: BASE - 5_000,
      containerState: null,
      claims: [{ message_id: 'x', status_changed: 'not-a-date' }],
    });
    expect(res.action).toBe('ok');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Orphan claim cleanup (regression test for the SIGKILL → claim-stuck loop)
//
// Repro of the production bug seen 2026-04-30: container A claimed message M
// (writes processing_ack row with status='processing'). Host kills A by
// absolute-ceiling. Old behavior: messages_in.M was reset to pending but
// processing_ack.M survived. On the next sweep tick, wakeContainer spawned B,
// the same-tick SLA check saw M's stale claim age (hours), and SIGKILL'd B
// before agent-runner could run clearStaleProcessingAcks(). Loop. The fix
// deletes processing_ack 'processing' rows when the host kills/cleans the
// container, breaking the loop atomically.
// ─────────────────────────────────────────────────────────────────────────────

function makeSessionDbs(): { inDb: Database.Database; outDb: Database.Database } {
  const inDb = new Database(':memory:');
  inDb.exec(`
    CREATE TABLE messages_in (
      id            TEXT PRIMARY KEY,
      seq           INTEGER UNIQUE,
      kind          TEXT NOT NULL,
      timestamp     TEXT NOT NULL,
      status        TEXT DEFAULT 'pending',
      process_after TEXT,
      recurrence    TEXT,
      series_id     TEXT,
      tries         INTEGER DEFAULT 0,
      trigger       INTEGER NOT NULL DEFAULT 1,
      platform_id   TEXT,
      channel_type  TEXT,
      thread_id     TEXT,
      content       TEXT NOT NULL
    );
  `);
  const outDb = new Database(':memory:');
  outDb.exec(`
    CREATE TABLE processing_ack (
      message_id     TEXT PRIMARY KEY,
      status         TEXT NOT NULL,
      status_changed TEXT NOT NULL
    );
  `);
  return { inDb, outDb };
}

function fakeSession(): Session {
  return {
    id: 'sess-test',
    agent_group_id: 'ag-test',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: new Date().toISOString(),
  };
}

describe('deleteOrphanProcessingClaims', () => {
  it('removes only processing rows, leaves completed/failed alone', () => {
    const { outDb } = makeSessionDbs();
    const ts = new Date().toISOString();
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-proc', 'processing', ?)").run(ts);
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-done', 'completed', ?)").run(ts);
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-fail', 'failed', ?)").run(ts);

    const removed = deleteOrphanProcessingClaims(outDb);

    expect(removed).toBe(1);
    const remaining = outDb.prepare('SELECT message_id, status FROM processing_ack ORDER BY message_id').all();
    expect(remaining).toEqual([
      { message_id: 'm-done', status: 'completed' },
      { message_id: 'm-fail', status: 'failed' },
    ]);
  });

  it('returns 0 when nothing to clear', () => {
    const { outDb } = makeSessionDbs();
    expect(deleteOrphanProcessingClaims(outDb)).toBe(0);
  });
});

describe('resetStuckProcessingRows — orphan claim cleanup', () => {
  it('deletes orphan processing_ack rows so next sweep tick does not see them', () => {
    const { inDb, outDb } = makeSessionDbs();
    const claimedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago

    // messages_in.status stays 'pending' during processing — only the
    // container's processing_ack moves to 'processing'. See
    // src/db/schema.ts header comment on processing_ack.
    inDb
      .prepare(
        "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES ('m-1', 1, 'chat', ?, 'pending', '{}')",
      )
      .run(claimedAt);
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-1', 'processing', ?)").run(claimedAt);

    // Sanity: the orphan claim is what would trip claim-stuck.
    expect(getProcessingClaims(outDb)).toHaveLength(1);

    _resetStuckProcessingRowsForTesting(inDb, outDb, fakeSession(), 'absolute-ceiling');

    // Regression assertion: orphan claim is gone — next sweep tick will see
    // an empty claims list and not kill the freshly respawned container.
    expect(getProcessingClaims(outDb)).toEqual([]);

    // And the message itself was rescheduled with backoff (existing behavior).
    const row = inDb.prepare('SELECT status, tries, process_after FROM messages_in WHERE id = ?').get('m-1') as {
      status: string;
      tries: number;
      process_after: string | null;
    };
    expect(row.status).toBe('pending');
    expect(row.tries).toBe(1);
    expect(row.process_after).not.toBeNull();
  });

  it('still clears orphan claims even when the inbound message has already been retried (skip path)', () => {
    // Edge case: the inbound row was already rescheduled (process_after in
    // future), so the per-message retry loop skips it. The orphan in
    // processing_ack must still be removed — otherwise the bug remains.
    const { inDb, outDb } = makeSessionDbs();
    const claimedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();

    inDb
      .prepare(
        "INSERT INTO messages_in (id, seq, kind, timestamp, status, process_after, tries, content) VALUES ('m-2', 2, 'chat', ?, 'pending', ?, 1, '{}')",
      )
      .run(claimedAt, future);
    outDb.prepare("INSERT INTO processing_ack VALUES ('m-2', 'processing', ?)").run(claimedAt);

    _resetStuckProcessingRowsForTesting(inDb, outDb, fakeSession(), 'claim-stuck');

    expect(getProcessingClaims(outDb)).toEqual([]);
    const row = inDb.prepare('SELECT tries FROM messages_in WHERE id = ?').get('m-2') as { tries: number };
    expect(row.tries).toBe(1); // not bumped, the skip path held
  });
});

describe('parseSqliteUtc', () => {
  // Regression: SQLite TIMESTAMP strings have no zone marker, but Date.parse
  // treats those as local time. On non-UTC hosts this made every claim look
  // (TZ offset) hours stale and tripped kill-claim on freshly-claimed messages.
  // The helper appends "Z" only when no marker is present, so parsing is
  // always anchored to UTC regardless of host timezone.

  const utcMs = Date.parse('2026-04-20T12:00:00.000Z');

  it('treats a SQLite-style timestamp (no zone) as UTC', () => {
    expect(parseSqliteUtc('2026-04-20 12:00:00')).toBe(utcMs);
    expect(parseSqliteUtc('2026-04-20T12:00:00')).toBe(utcMs);
    expect(parseSqliteUtc('2026-04-20T12:00:00.000')).toBe(utcMs);
  });

  it('preserves an explicit Z marker', () => {
    expect(parseSqliteUtc('2026-04-20T12:00:00.000Z')).toBe(utcMs);
    expect(parseSqliteUtc('2026-04-20T12:00:00z')).toBe(utcMs);
  });

  it('preserves an explicit numeric offset', () => {
    // 14:00+02:00 == 12:00 UTC
    expect(parseSqliteUtc('2026-04-20T14:00:00+02:00')).toBe(utcMs);
    expect(parseSqliteUtc('2026-04-20T14:00:00+0200')).toBe(utcMs);
    // 07:00-05:00 == 12:00 UTC
    expect(parseSqliteUtc('2026-04-20T07:00:00-05:00')).toBe(utcMs);
  });

  it('returns NaN for unparseable input', () => {
    expect(Number.isNaN(parseSqliteUtc('not a date'))).toBe(true);
  });

  it('does not drift across host timezones for SQLite-style input', () => {
    // The helper itself is timezone-independent because it forces UTC parsing.
    // (Verifying the regex branch — without the helper, `Date.parse` of the
    // bare string returns different values depending on the host TZ.)
    const bare = '2026-04-20T12:00:00';
    expect(parseSqliteUtc(bare)).toBe(Date.parse(bare + 'Z'));
  });
});

describe('isPendingPlaceholderSession (#1068)', () => {
  const TOKEN_PID = 'telegram:tok_a1b2c3d4e5f6';
  const BOUND_PID = 'telegram:-5467520989';

  beforeEach(() => {
    if (fs.existsSync(PLACEHOLDER_TEST_DIR)) fs.rmSync(PLACEHOLDER_TEST_DIR, { recursive: true });
    fs.mkdirSync(`${PLACEHOLDER_TEST_DIR}/data`, { recursive: true });
    const db = initTestDb();
    runMigrations(db);
    createAgentGroup({
      id: 'ag-1',
      name: 'Teen',
      folder: 'pan-teen-fid',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    createMessagingGroup({
      id: 'mg-1',
      channel_type: 'telegram',
      platform_id: TOKEN_PID,
      name: 'Teen',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: new Date().toISOString(),
    });
    writeDmRegistrations({
      [TOKEN_PID]: {
        groupName: 'pan-teen-fid',
        channel: 'telegram',
        address: 'tok_a1b2c3d4e5f6',
        registeredAt: new Date().toISOString(),
        requireOptIn: true,
      },
    });
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(PLACEHOLDER_TEST_DIR)) fs.rmSync(PLACEHOLDER_TEST_DIR, { recursive: true });
  });

  it('is true for a session bound to an unredeemed start-token placeholder (do not wake)', () => {
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    expect(isPendingPlaceholderSession(session)).toBe(true);
  });

  it('is false after the token is redeemed (rebind flips platform_id + activatedAt → wake normally)', () => {
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    // Simulate tryActivateStartToken: rebind the row in place + stamp the reg.
    updateMessagingGroup('mg-1', { platform_id: BOUND_PID, is_group: 1 });
    const regs = readDmRegistrations();
    regs[TOKEN_PID] = { ...regs[TOKEN_PID], activatedAt: new Date().toISOString(), boundPlatformId: BOUND_PID };
    writeDmRegistrations(regs);
    // The session row still references mg-1, which now carries the bound chat.
    expect(isPendingPlaceholderSession(session)).toBe(false);
  });

  it('is false for a session with no messaging group', () => {
    const orphan = { messaging_group_id: null } as unknown as Session;
    expect(isPendingPlaceholderSession(orphan)).toBe(false);
  });
});

describe('reapDefunctSessionContainers', () => {
  const sess = (over: Partial<Session> & { id: string }): Session =>
    ({
      agent_group_id: 'ag-1',
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'closed',
      container_status: 'running',
      last_active: null,
      created_at: new Date().toISOString(),
      ...over,
    }) as Session;

  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
    createAgentGroup({
      id: 'ag-1',
      name: 'Teen',
      folder: 'pan-teen-fid',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
  });

  afterEach(() => {
    closeDb();
  });

  function runtimeRecorder(runningIds: string[]) {
    const killed: string[] = [];
    const stopped: string[] = [];
    return {
      killed,
      stopped,
      runtime: {
        isRunning: (id: string) => runningIds.includes(id),
        kill: (id: string, _reason: string) => killed.push(id),
        markStopped: (id: string) => stopped.push(id),
      },
    };
  }

  it("kills the container of a 'closed' session and leaves row-marking to the exit handler", () => {
    createSession(sess({ id: 'sess-closed' }));
    const { killed, stopped, runtime } = runtimeRecorder(['sess-closed']);
    expect(reapDefunctSessionContainers(runtime)).toBe(1);
    expect(killed).toEqual(['sess-closed']);
    expect(stopped).toEqual([]);
  });

  it("reaps a 'completed' session — Pan's clear-session spelling, outside the TS union", () => {
    // SQLite doesn't enforce the Session status union; external completion
    // paths write 'completed'. The reap must match any non-active status.
    createSession(sess({ id: 'sess-completed', status: 'completed' as Session['status'] }));
    const { killed, runtime } = runtimeRecorder(['sess-completed']);
    expect(reapDefunctSessionContainers(runtime)).toBe(1);
    expect(killed).toEqual(['sess-completed']);
  });

  it('marks a registry-miss container stopped instead of killing (convergence)', () => {
    createSession(sess({ id: 'sess-orphan', container_status: 'idle' }));
    const killed: string[] = [];
    const stopped: string[] = [];
    const runtime = {
      isRunning: () => false,
      kill: (id: string, _reason: string) => killed.push(id),
      // Record AND perform the real row update so the convergence half of
      // this test exercises the production markContainerStopped path.
      markStopped: (id: string) => {
        stopped.push(id);
        markContainerStopped(id);
      },
    };
    expect(reapDefunctSessionContainers(runtime)).toBe(0);
    expect(killed).toEqual([]);
    expect(stopped).toEqual(['sess-orphan']);
    // The row is healed, so the next tick no longer selects it.
    const again = runtimeRecorder([]);
    expect(reapDefunctSessionContainers(again.runtime)).toBe(0);
    expect(again.stopped).toEqual([]);
  });

  it('never touches active sessions or already-stopped rows', () => {
    createSession(sess({ id: 'sess-active', status: 'active' }));
    createSession(sess({ id: 'sess-done', container_status: 'stopped' }));
    const { killed, stopped, runtime } = runtimeRecorder(['sess-active']);
    expect(reapDefunctSessionContainers(runtime)).toBe(0);
    expect(killed).toEqual([]);
    expect(stopped).toEqual([]);
  });
});
