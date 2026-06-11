import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

// Per-group observability identity. When set, the Langfuse Stop hook uses it
// as the trace `userId` at every log tier — it is operator-assigned config
// (a pseudonymous tenant key, e.g. Pan's `{family_id}-{dyad}`), not
// conversation content, so it is not gated by LANGFUSE_LOG_LEVEL the way the
// implicit assistantName fallback is.
export const migration016: Migration = {
  version: 16,
  name: 'trace-user-id',
  up(db: Database.Database) {
    db.prepare('ALTER TABLE container_configs ADD COLUMN trace_user_id TEXT').run();
  },
};
