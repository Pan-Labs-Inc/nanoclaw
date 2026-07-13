/**
 * Tests for the `task schedule` / `task delete` CLI verbs (#751 P5 S4a).
 *
 * These expose the scheduling module's insertTask/cancelTask on the CLI so an
 * in-container hook can arm/cancel a one-shot task (Pan's per-turn lease) without
 * an agent turn. The verbs write ONLY into the caller's own session inbound DB
 * (ctx.inDb), so they are resource-less + group-scoped by construction.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect, afterEach } from 'vitest';

import './scheduling.js'; // side-effect: register the verbs
import { lookup } from '../registry.js';
import { ensureSchema, openInboundDb } from '../../db/session-db.js';
import type { CallerContext } from '../frame.js';

const TEST_DIR = '/tmp/nanoclaw-cli-scheduling-test';
const DB_PATH = path.join(TEST_DIR, 'inbound.db');

function freshDb() {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  ensureSchema(DB_PATH, 'inbound');
  return openInboundDb(DB_PATH);
}

function agentCtx(inDb: ReturnType<typeof openInboundDb>): CallerContext {
  return {
    caller: 'agent',
    sessionId: 'sess-1',
    agentGroupId: 'ag-1',
    messagingGroupId: 'mg-1',
    inDb,
  };
}

function taskRow(db: ReturnType<typeof openInboundDb>, id: string) {
  return db
    .prepare('SELECT id, kind, status, process_after, recurrence, content, trigger FROM messages_in WHERE id = ?')
    .get(id) as
    | {
        id: string;
        kind: string;
        status: string;
        process_after: string;
        recurrence: string | null;
        content: string;
        trigger: number;
      }
    | undefined;
}

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('ncl task verbs — registration shape (scope-robust)', () => {
  it('task-schedule + task-delete are registered, resource-less, and access:open', () => {
    for (const name of ['task-schedule', 'task-delete']) {
      const cmd = lookup(name);
      expect(cmd, `${name} must be registered`).toBeTruthy();
      // Resource-less → not subject to the cli_scope='group' resource whitelist,
      // so a hook can call it under group OR global scope (blocked only when CLI
      // is disabled). access:'open' → no approval gate.
      expect(cmd!.resource).toBeUndefined();
      expect(cmd!.access).toBe('open');
    }
  });
});

describe('ncl task schedule', () => {
  it('inserts a one-shot kind=task row carrying the pre-task script (trigger=1, recurrence null)', async () => {
    const db = freshDb();
    const cmd = lookup('task-schedule')!;
    const script = 'cd /workspace/agent && node .hooks/turn-lease-fire.js 1>&2\necho \'{"wakeAgent": false}\'';
    const args = cmd.parseArgs({
      id: 'pan-turn-lease-t1',
      'process-after': '2026-06-15T14:30:00.000Z',
      script,
    });

    const out = await cmd.handler(args, agentCtx(db));
    expect(out).toMatchObject({ scheduled: true, id: 'pan-turn-lease-t1' });

    const row = taskRow(db, 'pan-turn-lease-t1');
    expect(row).toBeTruthy();
    expect(row!.kind).toBe('task');
    expect(row!.status).toBe('pending');
    expect(row!.recurrence).toBeNull(); // one-shot
    expect(row!.trigger).toBe(1); // schema default → countDueMessages will wake it
    expect(row!.process_after).toBe('2026-06-15T14:30:00.000Z');
    expect(JSON.parse(row!.content).script).toBe(script); // pre-task script round-trips
    db.close();
  });

  it('rejects missing --id and missing --process-after', () => {
    const cmd = lookup('task-schedule')!;
    expect(() => cmd.parseArgs({ 'process-after': '2026-01-01T00:00:00Z' })).toThrow(/--id/);
    expect(() => cmd.parseArgs({ id: 't1' })).toThrow(/--process-after/);
  });

  it('refuses a host (DB-less) caller — only the in-container DB transport can schedule', async () => {
    const cmd = lookup('task-schedule')!;
    const args = cmd.parseArgs({ id: 't1', 'process-after': '2026-01-01T00:00:00Z' });
    await expect(cmd.handler(args, { caller: 'host' })).rejects.toThrow(/in-container/);
  });
});

describe('ncl task delete', () => {
  it('cancels a pending task (idempotent — succeeds even when absent)', async () => {
    const db = freshDb();
    const schedule = lookup('task-schedule')!;
    const del = lookup('task-delete')!;

    await schedule.handler(
      schedule.parseArgs({ id: 'pan-turn-lease-t2', 'process-after': '2026-06-15T14:30:00.000Z' }),
      agentCtx(db),
    );
    expect(taskRow(db, 'pan-turn-lease-t2')!.status).toBe('pending');

    const out = await del.handler(del.parseArgs({ id: 'pan-turn-lease-t2' }), agentCtx(db));
    expect(out).toMatchObject({ deleted: true, id: 'pan-turn-lease-t2' });
    expect(taskRow(db, 'pan-turn-lease-t2')!.status).toBe('completed');

    // Deleting again (or an unknown id) is a no-op, not an error.
    await expect(del.handler(del.parseArgs({ id: 'never-existed' }), agentCtx(db))).resolves.toMatchObject({
      deleted: true,
    });
    db.close();
  });

  it('requires --id', () => {
    const cmd = lookup('task-delete')!;
    expect(() => cmd.parseArgs({})).toThrow(/--id/);
  });
});
