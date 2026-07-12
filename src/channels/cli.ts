/**
 * CLI channel — talk to your agent from a local terminal via Unix socket.
 *
 * Always-on, zero-credentials channel that ships with main. The daemon
 * listens on `data/cli.sock`; the `scripts/chat.ts` client connects, writes
 * a JSON line per message, reads JSON lines back. The channel plumbs into
 * the normal router/delivery path like any other adapter — `/clear` and
 * other session-level commands work identically.
 *
 * Wire format: one JSON object per line.
 *
 *   Client → server:
 *     { "text": "user message" }                          # default — talk to cli/local
 *     { "bind": { "platformId": "some-slot" } }           # hello — become the chat
 *                                                         # client for cli/<some-slot>
 *     { "text": "...", "to": {"channelType": "discord",
 *                             "platformId": "discord:@me:149...",
 *                             "threadId": null} }         # route to a specific mg
 *     { "text": "...", "to": {...}, "reply_to": {...} }   # + redirect replies
 *   Server → client:
 *     { "text": "agent reply" }
 *     { "ok": true, "bound": "some-slot" }                # bind acknowledgement
 *
 * The `to` and `reply_to` addressing is how admin transports (the bootstrap
 * script) inject messages targeting any wired channel. `reply_to` is a
 * router-layer concept — agents cannot set it; it is carried only on
 * inbound events from CLI clients that hold operator privilege (the socket
 * is chmod 0600, so "connected to this socket" ≈ "is the owner").
 *
 * Single-client chat semantics: one connected terminal at a time. A second
 * "chat" connection closes the first with a "superseded" notice. Admin
 * route-opcode connections (`to` set) are one-shot and do NOT evict an
 * active chat client.
 *
 * Bound (per-slot) chat semantics: a connection whose first line is a
 * `bind` hello becomes the chat client for `cli/<platformId>` — the exact
 * analog of the default client, for a named slot. Plain `{ text }` lines on
 * a bound connection route inbound with the bound platform id (including
 * `start <token>` activation, which rebinds the registration onto that
 * slot), and deliver() targets the bound socket for that platform id. N
 * bound clients coexist — this is what lets N agent groups be exercised
 * concurrently over one socket. Binding never touches the default chat
 * client; a second bind for the SAME slot supersedes the first, mirroring
 * the single-client rule per slot. The server acks a bind with
 * `{ ok: true, bound: <platformId> }` so clients can distinguish a server
 * that supports binding from one that would silently fall through to
 * cli/local.
 *
 * deliver() silently no-ops when no client is connected. The outbound row
 * is already in outbound.db, so the message isn't lost — it just doesn't
 * reach this run's terminal. Reconnect to see subsequent replies.
 */
import fs from 'fs';
import net from 'net';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { log } from '../log.js';
import type { ChannelAdapter, ChannelSetup, DeliveryAddress, InboundEvent, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';
import { tryActivateStartToken } from './start-token.js';

const PLATFORM_ID = 'local';

function socketPath(): string {
  return path.join(DATA_DIR, 'cli.sock');
}

function createAdapter(): ChannelAdapter {
  let server: net.Server | null = null;
  let client: net.Socket | null = null;
  // Per-slot chat clients, keyed by the platform id a connection bound to.
  const boundClients = new Map<string, net.Socket>();

  const adapter: ChannelAdapter = {
    name: 'cli',
    channelType: 'cli',
    supportsThreads: false,

    async setup(config: ChannelSetup): Promise<void> {
      const sock = socketPath();

      // Stale socket cleanup: a previous run that crashed may have left the
      // file behind, and net.createServer refuses to bind to an existing path.
      try {
        fs.unlinkSync(sock);
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code !== 'ENOENT') {
          log.warn('Failed to unlink stale CLI socket (will try to bind anyway)', { sock, err });
        }
      }

      server = net.createServer((socket) => handleConnection(socket, config));
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.listen(sock, () => {
          // Tighten perms so only the owner can connect. Unix socket files
          // obey filesystem perms — 0700 on the socket means other local
          // users can't send into this agent.
          try {
            fs.chmodSync(sock, 0o600);
          } catch (err) {
            log.warn('Failed to chmod CLI socket (continuing)', { sock, err });
          }
          log.info('CLI channel listening', { sock });
          resolve();
        });
      });
    },

    async teardown(): Promise<void> {
      if (client) {
        try {
          client.end();
        } catch {
          // swallow — teardown is best-effort
        }
        client = null;
      }
      for (const sock of boundClients.values()) {
        try {
          sock.end();
        } catch {
          // swallow — teardown is best-effort
        }
      }
      boundClients.clear();
      if (server) {
        await new Promise<void>((resolve) => {
          server!.close(() => resolve());
        });
        server = null;
      }
      // Remove the socket file so a relaunch doesn't trip over it.
      try {
        fs.unlinkSync(socketPath());
      } catch {
        // swallow
      }
    },

    isConnected(): boolean {
      return server !== null;
    },

    async deliver(platformId, _threadId, message: OutboundMessage): Promise<string | undefined> {
      // A bound per-slot client wins; the default client serves only 'local'.
      const target = boundClients.get(platformId) ?? (platformId === PLATFORM_ID ? client : null);
      if (!target) {
        // No live terminal — outbound row is already persisted, so this
        // isn't a data loss. User will see it on the next connect cycle
        // (or never, if we don't add scroll-back). Not worth throwing.
        return undefined;
      }
      const text = extractText(message);
      if (text === null) return undefined;
      try {
        target.write(JSON.stringify({ text }) + '\n');
      } catch (err) {
        log.warn('Failed to write to CLI client', { err });
      }
      return undefined;
    },
  };

  function handleConnection(socket: net.Socket, config: ChannelSetup): void {
    // Defer the chat-slot swap until we see the first line — if it turns out
    // to be a routed (`to`-bearing) one-shot, we leave the existing chat
    // client in place. Only plain chat connections participate in supersede.
    let claimedChatSlot = false;
    // The slot this connection bound to via a `bind` hello (null = default
    // client semantics). Bound connections never touch the default chat slot.
    let boundId: string | null = null;

    const claimChatSlot = () => {
      if (claimedChatSlot) return;
      claimedChatSlot = true;
      if (client && client !== socket) {
        try {
          client.write(JSON.stringify({ text: '[superseded by a newer client]' }) + '\n');
          client.end();
        } catch {
          // swallow
        }
      }
      client = socket;
      log.info('CLI client connected');
    };

    // Register this connection as the chat client for a named slot.
    // Synchronous — a bind hello is fully applied before the next line on the
    // same connection is processed, so hello-then-text framing can't race.
    const bindSlot = (platformId: string) => {
      const prev = boundClients.get(platformId);
      if (prev && prev !== socket) {
        try {
          prev.write(JSON.stringify({ text: '[superseded by a newer client]' }) + '\n');
          prev.end();
        } catch {
          // swallow
        }
      }
      boundClients.set(platformId, socket);
      boundId = platformId;
      try {
        socket.write(JSON.stringify({ ok: true, bound: platformId }) + '\n');
      } catch (err) {
        log.warn('CLI: failed to ack bind', { platformId, err });
      }
      log.info('CLI client bound', { platformId });
    };

    const conn = {
      socket,
      claimChatSlot,
      bindSlot,
      getBoundId: () => boundId,
    };

    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        void handleLine(line, config, conn);
      }
    });

    socket.on('close', () => {
      if (client === socket) client = null;
      if (boundId && boundClients.get(boundId) === socket) boundClients.delete(boundId);
      if (claimedChatSlot || boundId) log.info('CLI client disconnected', boundId ? { boundId } : undefined);
    });

    socket.on('error', (err) => {
      log.warn('CLI client socket error', { err });
    });
  }

  async function handleLine(
    line: string,
    config: ChannelSetup,
    conn: {
      socket: net.Socket;
      claimChatSlot: () => void;
      bindSlot: (platformId: string) => void;
      getBoundId: () => string | null;
    },
  ): Promise<void> {
    let payload: {
      text?: unknown;
      to?: unknown;
      reply_to?: unknown;
      sender?: unknown;
      senderId?: unknown;
      bind?: unknown;
    };
    try {
      payload = JSON.parse(line);
    } catch (err) {
      log.warn('CLI: ignoring non-JSON line from client', { line });
      return;
    }

    // Bind hello — `{ bind: { platformId } }`. Hello-only lines: any `text` on
    // the same line is ignored (send it as its own line, after the ack).
    if (payload.bind !== undefined) {
      const bind = payload.bind as Record<string, unknown> | null;
      const platformId = bind && typeof bind === 'object' && typeof bind.platformId === 'string'
        ? bind.platformId.trim()
        : '';
      if (!platformId) {
        log.warn('CLI: ignoring malformed bind hello', { line });
        return;
      }
      conn.bindSlot(platformId);
      return;
    }

    if (typeof payload.text !== 'string' || payload.text.length === 0) return;

    const to = parseAddress(payload.to);
    const replyTo = parseAddress(payload.reply_to);

    if (to) {
      // Routed message — admin transport. Build a full InboundEvent targeting
      // `to`'s channel/platform, and let `reply_to` (if any) redirect replies.
      // Does NOT claim the chat slot, so an active terminal chat isn't evicted.
      const event: InboundEvent = {
        channelType: to.channelType,
        platformId: to.platformId,
        threadId: to.threadId,
        message: {
          id: `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          kind: 'chat',
          timestamp: new Date().toISOString(),
          content: JSON.stringify({
            text: payload.text,
            sender: typeof payload.sender === 'string' ? payload.sender : 'cli',
            senderId: typeof payload.senderId === 'string' ? payload.senderId : `cli:${PLATFORM_ID}`,
          }),
        },
        replyTo: replyTo ?? undefined,
      };
      try {
        await config.onInboundEvent(event);
      } catch (err) {
        log.error('CLI: onInboundEvent threw', { err });
      }
      return;
    }

    // Plain chat. On a bound connection the message belongs to the bound slot;
    // otherwise claim the default chat slot (evicting any prior client) and
    // route to 'local'. Either way it goes via the standard onInbound path
    // (adapter injects its own channelType).
    const chatPlatformId = conn.getBoundId() ?? PLATFORM_ID;
    if (!conn.getBoundId()) conn.claimChatSlot();

    // Channel-agnostic start-token activation (#1018): a `start <token>` (or a
    // bare token) binds this cli slot to a born-suppressed `cli:<token>`
    // registration — rebinding its placeholder onto the id plain chat on this
    // connection routes to ('local', or the bound slot) and seeding the
    // activation-awareness task that drives the greeting. The token message is
    // consumed; it never reaches an agent.
    const activation = tryActivateStartToken({ channel: 'cli', text: payload.text, platformId: chatPlatformId });
    if (activation) {
      log.info('CLI start-token activation', {
        boundPlatformId: activation.boundPlatformId,
        replay: activation.replay,
        openerDelivered: Boolean(activation.openerText),
      });
      // Deliver the registration's canned opener as the instant activation
      // reply (openerText is null on replay) to the connection that redeemed
      // the token. Best-effort, same as deliver().
      if (activation.openerText) {
        try {
          conn.socket.write(JSON.stringify({ text: activation.openerText }) + '\n');
        } catch (err) {
          log.warn('CLI: failed to write start-token opener to client', { err });
        }
      }
      return;
    }

    try {
      await config.onInbound(chatPlatformId, null, {
        id: `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'chat',
        timestamp: new Date().toISOString(),
        content: {
          text: payload.text,
          sender: 'cli',
          senderId: `cli:${chatPlatformId}`,
        },
      });
    } catch (err) {
      log.error('CLI: onInbound threw', { err });
    }
  }

  function parseAddress(raw: unknown): DeliveryAddress | null {
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;
    if (typeof obj.channelType !== 'string' || typeof obj.platformId !== 'string') return null;
    const threadId =
      obj.threadId === null || obj.threadId === undefined
        ? null
        : typeof obj.threadId === 'string'
          ? obj.threadId
          : null;
    return {
      channelType: obj.channelType,
      platformId: obj.platformId,
      threadId,
    };
  }

  return adapter;
}

function extractText(message: OutboundMessage): string | null {
  const content = message.content as Record<string, unknown> | string | undefined;
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return content.text;
  }
  return null;
}

registerChannelAdapter('cli', { factory: createAdapter });
