/**
 * Wire format shared between the socket transport (host caller) and — when
 * it lands — the DB transport (container agent caller).
 *
 * Same JSON whether it goes over a socket as a line or sits in a
 * `frame_json TEXT` column on a session DB. Caller identity is NOT carried
 * in the frame — it's filled in by whichever server-side adapter received
 * the bytes (see CallerContext).
 */
import type BetterSqlite3Database from 'better-sqlite3';

export type RequestFrame = {
  /** Correlation key set by the client. */
  id: string;
  /** Registry name, e.g. "list-groups". */
  command: string;
  /** Command-specific. Each command's parseArgs validates. */
  args: Record<string, unknown>;
};

export type ResponseFrame =
  | { id: string; ok: true; data: unknown }
  | { id: string; ok: false; error: { code: ErrorCode; message: string } };

export type ErrorCode =
  | 'unknown-command'
  | 'invalid-args'
  | 'permission-denied'
  | 'forbidden'
  | 'approval-pending'
  | 'not-found'
  | 'handler-error'
  | 'transport-error';

/**
 * Filled in by the transport adapter on the server side. Handlers read
 * caller identity from here, never from the frame.
 */
export type CallerContext =
  | { caller: 'host' }
  | {
      caller: 'agent';
      sessionId: string;
      agentGroupId: string;
      messagingGroupId: string;
      /**
       * The caller's session inbound DB, threaded by the DB (cli_request)
       * transport so a host-side handler can write a row scoped to the caller's
       * own session — e.g. schedule a task into that session's `messages_in`.
       * Absent on the socket transport (host `bin/ncl`): a command that needs it
       * must reject a DB-less caller. Type-only import (erased at runtime).
       */
      inDb?: BetterSqlite3Database.Database;
    };
