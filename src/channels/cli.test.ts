/**
 * Tests for the CLI channel adapter — default (single-client) chat semantics
 * and the bound per-slot chat clients (`{ bind: { platformId } }` hello) that
 * let N agent groups be exercised concurrently over one socket.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import net from 'net';
import path from 'path';

import type { ChannelAdapter, ChannelSetup } from './adapter.js';

const TEST_DIR = `/tmp/nanoclaw-test-cli-${process.pid}`;

// Override DATA_DIR so the socket lands in a test-scoped tmp dir.
vi.mock('../config.js', async () => {
  const actual = await vi.importActual('../config.js');
  return { ...actual, DATA_DIR: `/tmp/nanoclaw-test-cli-${process.pid}` };
});

// The start-token interceptor is unit-tested in start-token.test.ts; here we
// only care WHICH platform id the adapter hands it and what the adapter does
// with the result.
vi.mock('./start-token.js', () => ({
  tryActivateStartToken: vi.fn().mockReturnValue(null),
}));

import { tryActivateStartToken } from './start-token.js';
import { getChannelAdapter, initChannelAdapters, teardownChannelAdapters } from './channel-registry.js';
import './cli.js';

const SOCK = path.join(TEST_DIR, 'cli.sock');

/** A test client: line-framed JSON over the cli socket. */
class TestClient {
  socket!: net.Socket;
  lines: Array<Record<string, unknown>> = [];
  private waiters: Array<() => void> = [];
  private buffer = '';
  closed = false;

  async connect(): Promise<this> {
    this.socket = net.connect(SOCK);
    await new Promise<void>((resolve, reject) => {
      this.socket.once('connect', () => resolve());
      this.socket.once('error', reject);
    });
    this.socket.on('data', (chunk) => {
      this.buffer += chunk.toString('utf8');
      let idx: number;
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        this.lines.push(JSON.parse(line));
        for (const w of this.waiters.splice(0)) w();
      }
    });
    this.socket.on('close', () => {
      this.closed = true;
      for (const w of this.waiters.splice(0)) w();
    });
    return this;
  }

  send(obj: Record<string, unknown>): void {
    this.socket.write(JSON.stringify(obj) + '\n');
  }

  /** Wait until a received line satisfies `pred` (or time out loudly). */
  async waitForLine(pred: (l: Record<string, unknown>) => boolean, timeoutMs = 2000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.lines.find(pred);
      if (hit) return hit;
      if (Date.now() > deadline)
        throw new Error(`no matching line within ${timeoutMs}ms — got ${JSON.stringify(this.lines)}`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 50);
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  async waitForClose(timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.closed) {
      if (Date.now() > deadline) throw new Error('socket did not close in time');
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  end(): void {
    try {
      this.socket.end();
    } catch {
      // best effort
    }
  }
}

const flush = () => new Promise((r) => setTimeout(r, 100));

describe('cli channel adapter', () => {
  let adapter: ChannelAdapter;
  let onInbound: ReturnType<typeof vi.fn>;
  let onInboundEvent: ReturnType<typeof vi.fn>;
  const clients: TestClient[] = [];

  const client = async () => {
    const c = await new TestClient().connect();
    clients.push(c);
    return c;
  };

  beforeEach(async () => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    vi.mocked(tryActivateStartToken).mockReset().mockReturnValue(null);
    onInbound = vi.fn().mockResolvedValue(undefined);
    onInboundEvent = vi.fn().mockResolvedValue(undefined);
    await initChannelAdapters(() => ({ onInbound, onInboundEvent }) as unknown as ChannelSetup);
    adapter = getChannelAdapter('cli')!;
    expect(adapter).toBeDefined();
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) c.end();
    await teardownChannelAdapters();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('default (unbound) chat semantics', () => {
    it('routes plain text to cli/local and delivers replies to the chat client', async () => {
      const c = await client();
      c.send({ text: 'hello' });
      await flush();
      expect(onInbound).toHaveBeenCalledTimes(1);
      const [platformId, threadId, message] = onInbound.mock.calls[0];
      expect(platformId).toBe('local');
      expect(threadId).toBeNull();
      expect(message.content).toMatchObject({ text: 'hello', sender: 'cli', senderId: 'cli:local' });

      await adapter.deliver('local', null, { content: { text: 'hi back' } } as never);
      await c.waitForLine((l) => l.text === 'hi back');
    });

    it('a second plain client supersedes the first', async () => {
      const first = await client();
      first.send({ text: 'one' });
      await flush();
      const second = await client();
      second.send({ text: 'two' });
      await first.waitForLine((l) => String(l.text).includes('superseded'));
      await first.waitForClose();
    });
  });

  describe('bind hello', () => {
    it('acks a bind and delivers slot-addressed outbound to the bound socket only', async () => {
      const bound = await client();
      bound.send({ bind: { platformId: 'pan-teen-test-aa' } });
      await bound.waitForLine((l) => l.ok === true && l.bound === 'pan-teen-test-aa');

      await adapter.deliver('pan-teen-test-aa', null, { content: { text: 'for aa' } } as never);
      await bound.waitForLine((l) => l.text === 'for aa');

      // A slot with no bound client: no throw, nothing delivered anywhere.
      await adapter.deliver('pan-teen-test-zz', null, { content: { text: 'for zz' } } as never);
      await flush();
      expect(bound.lines.filter((l) => l.text === 'for zz')).toHaveLength(0);
    });

    it('routes plain text on a bound connection with the bound platform id', async () => {
      const bound = await client();
      bound.send({ bind: { platformId: 'pan-teen-test-aa' } });
      await bound.waitForLine((l) => l.ok === true);
      bound.send({ text: 'hey' });
      await flush();
      expect(onInbound).toHaveBeenCalledTimes(1);
      const [platformId, , message] = onInbound.mock.calls[0];
      expect(platformId).toBe('pan-teen-test-aa');
      expect(message.content).toMatchObject({ text: 'hey', senderId: 'cli:pan-teen-test-aa' });
    });

    it('N bound clients coexist with each other and with the default client', async () => {
      const plain = await client();
      plain.send({ text: 'plain chat' });
      await flush();

      const a = await client();
      a.send({ bind: { platformId: 'slot-a' } });
      const b = await client();
      b.send({ bind: { platformId: 'slot-b' } });
      await a.waitForLine((l) => l.ok === true);
      await b.waitForLine((l) => l.ok === true);

      await adapter.deliver('slot-a', null, { content: { text: 'to a' } } as never);
      await adapter.deliver('slot-b', null, { content: { text: 'to b' } } as never);
      await adapter.deliver('local', null, { content: { text: 'to plain' } } as never);

      await a.waitForLine((l) => l.text === 'to a');
      await b.waitForLine((l) => l.text === 'to b');
      await plain.waitForLine((l) => l.text === 'to plain');
      // No cross-slot bleed, and binding never evicted the plain client.
      expect(a.lines.some((l) => l.text === 'to b' || l.text === 'to plain')).toBe(false);
      expect(b.lines.some((l) => l.text === 'to a' || l.text === 'to plain')).toBe(false);
      expect(plain.closed).toBe(false);
    });

    it('a second bind for the SAME slot supersedes the first', async () => {
      const first = await client();
      first.send({ bind: { platformId: 'slot-a' } });
      await first.waitForLine((l) => l.ok === true);
      const second = await client();
      second.send({ bind: { platformId: 'slot-a' } });
      await second.waitForLine((l) => l.ok === true);
      await first.waitForLine((l) => String(l.text ?? '').includes('superseded'));
      await first.waitForClose();

      await adapter.deliver('slot-a', null, { content: { text: 'still routed' } } as never);
      await second.waitForLine((l) => l.text === 'still routed');
    });

    it('a closed bound client is unregistered — delivery becomes a no-op, not a stale write', async () => {
      const bound = await client();
      bound.send({ bind: { platformId: 'slot-a' } });
      await bound.waitForLine((l) => l.ok === true);
      bound.end();
      await bound.waitForClose();
      await flush();
      // Must not throw, and must not resurrect the socket.
      await adapter.deliver('slot-a', null, { content: { text: 'late' } } as never);
    });

    it('ignores a malformed bind hello (no crash, no ack)', async () => {
      const c = await client();
      c.send({ bind: { platformId: '' } });
      c.send({ bind: 'nope' });
      await flush();
      expect(c.lines).toHaveLength(0);
      // The connection still works as a plain client afterwards.
      c.send({ text: 'still alive' });
      await flush();
      expect(onInbound).toHaveBeenCalledTimes(1);
      expect(onInbound.mock.calls[0][0]).toBe('local');
    });
  });

  describe('start-token activation', () => {
    it('runs the interceptor with the BOUND platform id and writes the opener to that socket', async () => {
      vi.mocked(tryActivateStartToken).mockReturnValue({
        groupName: 'Pan Teen test-aa',
        tokenPlatformId: 'cli:tok',
        boundPlatformId: 'pan-teen-test-aa',
        replay: false,
        openerText: 'hey, i am pan',
      });
      const bound = await client();
      bound.send({ bind: { platformId: 'pan-teen-test-aa' } });
      await bound.waitForLine((l) => l.ok === true);
      bound.send({ text: 'start sometoken123' });
      await bound.waitForLine((l) => l.text === 'hey, i am pan');
      expect(tryActivateStartToken).toHaveBeenCalledWith({
        channel: 'cli',
        text: 'start sometoken123',
        platformId: 'pan-teen-test-aa',
      });
      // Consumed — never reaches an agent.
      expect(onInbound).not.toHaveBeenCalled();
    });

    it('keeps running the interceptor with "local" for unbound chat', async () => {
      const c = await client();
      c.send({ text: 'start sometoken123' });
      await flush();
      expect(tryActivateStartToken).toHaveBeenCalledWith({
        channel: 'cli',
        text: 'start sometoken123',
        platformId: 'local',
      });
    });
  });

  describe('routed (`to`) lines', () => {
    it('still build a full InboundEvent without claiming any chat slot', async () => {
      const plain = await client();
      plain.send({ text: 'claim' });
      await flush();
      const oneShot = await client();
      oneShot.send({ text: 'routed', to: { channelType: 'telegram', platformId: 'tg:123', threadId: null } });
      await flush();
      expect(onInboundEvent).toHaveBeenCalledTimes(1);
      expect(onInboundEvent.mock.calls[0][0]).toMatchObject({ channelType: 'telegram', platformId: 'tg:123' });
      expect(plain.closed).toBe(false);
    });
  });
});
