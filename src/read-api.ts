/**
 * read-api.ts — NanoClaw's read surface (`/api/read/...`).
 *
 * v1 resource: `GET /api/read/message-history?groupName=<folder>` — the merged
 * inbound + outbound message stream for an agent group's sessions, newest
 * envelope described in pan's docs/design/nanoclaw-read-surface.md. This is
 * the owned contract that replaces external readers opening the per-session
 * SQLite files directly: consumers (pan's turn-log reassembly) speak HTTP,
 * and the session-DB schema stays private to NanoClaw.
 *
 * Auth: `Authorization: Bearer <NANOCLAW_ADMIN_MCP_TOKEN>` — deliberately the
 * same token as admin-MCP (decision recorded in the design doc; a separate
 * read token is the upgrade path if control- and read-holders ever diverge).
 * Group access honors NANOCLAW_ADMIN_MCP_GROUP_PREFIXES like the group-scoped
 * admin-MCP verbs. One audit log line per query, like admin-MCP writes.
 *
 * Pagination: ascending (ts, id) order; `cursor` is an opaque base64url of
 * the last row's (ts, id); `limit` defaults to 500, max 2000.
 */
import crypto from 'crypto';
import fs from 'fs';

import { getAgentGroupByFolder } from './db/agent-groups.js';
import { getSessionsByAgentGroup } from './db/sessions.js';
import { isValidGroupFolder } from './group-folder.js';
import { log } from './log.js';
import {
  inboundDbPath,
  openInboundDb,
  openOutboundDb,
  outboundDbPath,
} from './session-manager.js';
import { registerApiHandler } from './webhook-server.js';

const ENDPOINT_NAME = 'read';
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;

export type HistoryMessage = {
  id: string;
  sessionId: string;
  direction: 'inbound' | 'outbound';
  kind: string;
  ts: string;
  text: string | null;
  platformId: string | null;
  threadId: string | null;
};

type RowShape = {
  id: string;
  kind: string;
  timestamp: string;
  platform_id: string | null;
  thread_id: string | null;
  content: string;
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse(status, { ok: false, error: { code, message } });
}

// Same check admin-mcp.ts uses (kept local: importing admin-mcp would run its
// registration side effects in tests).
function authorized(request: Request, expected: string): boolean {
  const header = request.headers.get('authorization') || '';
  const actual = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  if (!actual || actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

function groupPrefixAllowed(groupName: string, groupPrefixes: string | undefined): boolean {
  if (!groupPrefixes) return true;
  const prefixes = groupPrefixes
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (prefixes.length === 0) return true;
  return prefixes.some((p) => groupName.startsWith(p));
}

function encodeCursor(ts: string, id: string): string {
  return Buffer.from(JSON.stringify([ts, id])).toString('base64url');
}

function decodeCursor(cursor: string): [string, string] | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as unknown;
    if (Array.isArray(parsed) && typeof parsed[0] === 'string' && typeof parsed[1] === 'string') {
      return [parsed[0], parsed[1]];
    }
    return null;
  } catch {
    return null;
  }
}

function textOf(content: string): string | null {
  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    return typeof parsed.text === 'string' ? parsed.text : null;
  } catch {
    return null;
  }
}

/** (ts, id) tuple order — the pagination order. */
function compareMessages(a: HistoryMessage, b: HistoryMessage): number {
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function collectGroupMessages(agentGroupId: string): HistoryMessage[] {
  const messages: HistoryMessage[] = [];

  for (const session of getSessionsByAgentGroup(agentGroupId)) {
    if (fs.existsSync(inboundDbPath(agentGroupId, session.id))) {
      const db = openInboundDb(agentGroupId, session.id);
      try {
        const rows = db
          .prepare('SELECT id, kind, timestamp, platform_id, thread_id, content FROM messages_in')
          .all() as RowShape[];
        for (const row of rows) {
          messages.push({
            id: row.id,
            sessionId: session.id,
            direction: 'inbound',
            kind: row.kind,
            ts: row.timestamp,
            text: textOf(row.content),
            platformId: row.platform_id,
            threadId: row.thread_id,
          });
        }
      } finally {
        db.close();
      }
    }

    if (fs.existsSync(outboundDbPath(agentGroupId, session.id))) {
      const db = openOutboundDb(agentGroupId, session.id);
      try {
        const rows = db
          .prepare('SELECT id, kind, timestamp, platform_id, thread_id, content FROM messages_out')
          .all() as RowShape[];
        for (const row of rows) {
          messages.push({
            id: row.id,
            sessionId: session.id,
            direction: 'outbound',
            kind: row.kind,
            ts: row.timestamp,
            text: textOf(row.content),
            platformId: row.platform_id,
            threadId: row.thread_id,
          });
        }
      } finally {
        db.close();
      }
    }
  }

  return messages.sort(compareMessages);
}

export function createReadApiHandler({
  token = process.env.NANOCLAW_ADMIN_MCP_TOKEN,
  groupPrefixes = process.env.NANOCLAW_ADMIN_MCP_GROUP_PREFIXES,
} = {}) {
  return async (request: Request): Promise<Response> => {
    if (!token) return errorResponse(404, 'disabled', 'Read API is disabled');
    if (!authorized(request, token)) return errorResponse(403, 'forbidden', 'Forbidden');
    if (request.method !== 'GET') return errorResponse(405, 'method-not-allowed', 'GET only');

    const url = new URL(request.url);
    const resource = url.pathname.replace(/^\/api\/read\/?/, '');
    if (resource !== 'message-history') {
      return errorResponse(404, 'unknown-resource', `Unknown read resource: '${resource || '(none)'}'`);
    }

    const groupName = url.searchParams.get('groupName') ?? '';
    if (!isValidGroupFolder(groupName)) {
      return errorResponse(400, 'bad-request', `Invalid group folder name: '${groupName}'`);
    }
    if (!groupPrefixAllowed(groupName, groupPrefixes)) {
      return errorResponse(403, 'forbidden', `Group '${groupName}' is not in the allowed prefix scope`);
    }

    const limitRaw = url.searchParams.get('limit');
    const limit = Math.min(Math.max(parseInt(limitRaw ?? String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const since = url.searchParams.get('since');
    const until = url.searchParams.get('until');
    const cursorRaw = url.searchParams.get('cursor');
    const cursor = cursorRaw ? decodeCursor(cursorRaw) : null;
    if (cursorRaw && !cursor) {
      return errorResponse(400, 'bad-request', 'Malformed cursor');
    }

    const agentGroup = getAgentGroupByFolder(groupName);
    let messages = agentGroup ? collectGroupMessages(agentGroup.id) : [];

    if (since) messages = messages.filter((m) => m.ts >= since);
    if (until) messages = messages.filter((m) => m.ts <= until);
    if (cursor) {
      const [cursorTs, cursorId] = cursor;
      messages = messages.filter((m) => m.ts > cursorTs || (m.ts === cursorTs && m.id > cursorId));
    }

    const page = messages.slice(0, limit);
    const nextCursor =
      messages.length > limit && page.length > 0
        ? encodeCursor(page[page.length - 1].ts, page[page.length - 1].id)
        : null;

    log.info('read-api audit', { resource, groupName, count: page.length });
    return jsonResponse(200, { ok: true, data: { messages: page, nextCursor } });
  };
}

if (process.env.NANOCLAW_ADMIN_MCP_TOKEN) {
  registerApiHandler(ENDPOINT_NAME, createReadApiHandler());
}
