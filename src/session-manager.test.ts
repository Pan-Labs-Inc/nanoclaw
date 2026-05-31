import fs from 'fs';

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Redirect DATA_DIR to a temp dir so writeOutboundDirect's in-module session
// path resolution (sessionDir → DATA_DIR) lands on a DB we own. importOriginal
// keeps the rest of config intact for the other modules in the import graph.
const TMP_DATA_DIR = vi.hoisted(
  () => `${(process.env.TMPDIR || '/tmp').replace(/\/$/, '')}/ncl-writeoutbound-${process.pid}`,
);
vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  DATA_DIR: TMP_DATA_DIR,
}));

import { ensureSchema } from './db/session-db.js';
import {
  writeOutboundDirect,
  openOutboundDb,
  outboundDbPath,
  sessionDir,
} from './session-manager.js';

const AG = 'ag-writeoutbound-test';
const SESS = 'sess-writeoutbound-test';

/**
 * Regression for the "attempt to write a readonly database" bug:
 * writeOutboundDirect opened outbound.db via openOutboundDb ({ readonly: true },
 * the host's read-and-ship handle) and then ran an INSERT, so every host→outbound
 * write (command-gate denials, the `ncl messages send` verb) threw at run().
 *
 * messages.test.ts could not catch this — it mocks writeOutboundDirect and only
 * asserts the handler CALLS it. This drives the REAL function against a REAL
 * outbound.db, so it is RED on the readonly opener and GREEN once it opens RW.
 */
describe('writeOutboundDirect — host write reaches messages_out (readonly-opener regression)', () => {
  beforeEach(() => {
    fs.mkdirSync(sessionDir(AG, SESS), { recursive: true });
    ensureSchema(outboundDbPath(AG, SESS), 'outbound');
  });

  afterEach(() => {
    fs.rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  });

  it('persists the row instead of throwing "readonly database"', () => {
    expect(() =>
      writeOutboundDirect(AG, SESS, {
        id: 'host-send-test-1',
        kind: 'agent',
        platformId: '99887766',
        channelType: 'telegram',
        threadId: null,
        content: JSON.stringify({ text: 'Pan flagged a safety concern' }),
      }),
    ).not.toThrow();

    const db: Database.Database = openOutboundDb(AG, SESS);
    try {
      const row = db
        .prepare(
          'SELECT id, kind, platform_id, channel_type, content FROM messages_out WHERE id = ?',
        )
        .get('host-send-test-1') as
        | { id: string; kind: string; platform_id: string; channel_type: string; content: string }
        | undefined;

      expect(row).toBeDefined();
      expect(row?.kind).toBe('agent');
      expect(row?.platform_id).toBe('99887766');
      expect(row?.channel_type).toBe('telegram');
      expect(JSON.parse(row!.content).text).toBe('Pan flagged a safety concern');
    } finally {
      db.close();
    }
  });
});
