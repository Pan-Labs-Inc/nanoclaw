import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DIR } = vi.hoisted(() => ({
  TEST_DIR: `/tmp/nanoclaw-sms-activation-test-${process.pid}`,
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    DATA_DIR: `${TEST_DIR}/data`,
  };
});

import type { ChannelSetup } from './channels/adapter.js';
import { createSmsAdapter, createSmsWebhookHandler, setSmsOptOut, type SmsConfig } from './channels/sms.js';

function optOutStorePath(): string {
  return path.join(TEST_DIR, 'data', 'sms-opt-outs.json');
}

function baseConfig(overrides: Partial<SmsConfig> = {}): SmsConfig {
  return {
    accountSid: 'AC123',
    authToken: 'secret',
    fromNumber: '+15550001111',
    validateSignature: false,
    validateCredentials: false,
    optOutStorePath: optOutStorePath(),
    ...overrides,
  };
}

function hostSetup(overrides: Partial<ChannelSetup> = {}): ChannelSetup {
  return {
    onInbound: async () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
    ...overrides,
  };
}

async function sendInbound(
  handler: ReturnType<typeof createSmsWebhookHandler>,
  from: string,
  body: string,
): Promise<Response> {
  const params = new URLSearchParams({
    MessageSid: 'SM123',
    From: from,
    To: '+15550001111',
    Body: body,
    NumMedia: '0',
  });
  return handler(
    new Request('http://localhost/webhook/sms', {
      method: 'POST',
      body: params.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }),
    { waitUntil: () => {} },
  );
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(TEST_DIR, 'data'), { recursive: true });
});

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

const PHONE = '+15551234567';

describe('SMS activation state machine — six scenarios', () => {
  it('scenario 1: keyword for unregistered number seeds nothing and changes no state', async () => {
    // No dm-registrations entry for this number. START is processed as a control
    // event but produces no seeding prompt (prevState='active'+action='start'
    // → no awareness row in production). State stays 'active' — verified by
    // sending a regular message afterward and confirming onInbound IS called.
    let inboundCalled = false;
    const handler = createSmsWebhookHandler(
      baseConfig(), // no hooks — real resolveActivationState + real seeding path
      hostSetup({
        onInbound: async () => {
          inboundCalled = true;
        },
      }),
    );

    await sendInbound(handler, PHONE, 'START');
    // After START for an unregistered number, regular messages still reach the agent.
    await sendInbound(handler, PHONE, 'hello');

    expect(inboundCalled).toBe(true);
  });

  it('scenario 2: keyword older than registration leaves pending', async () => {
    // Register with require_opt_in=true. Write a START event with at===registeredAt
    // (stale: not strictly after). Non-keyword inbound must be dropped by the
    // consent gate (resolveActivationState returns 'pending').
    const registeredAt = '2026-01-01T00:00:00.000Z';
    const regs = {
      [PHONE]: { requireOptIn: true, registeredAt, groupName: 'test', channel: 'sms', address: PHONE },
    };
    fs.writeFileSync(path.join(TEST_DIR, 'data', 'dm-registrations.json'), JSON.stringify(regs, null, 2));

    const store = {
      optedOut: {},
      controlEvents: {
        [PHONE]: { action: 'start', keyword: 'START', receivedAt: registeredAt, at: registeredAt },
      },
    };
    fs.writeFileSync(optOutStorePath(), JSON.stringify(store, null, 2));

    let inboundCalled = false;
    const handler = createSmsWebhookHandler(
      baseConfig(), // no checkActivationState hook → real resolveActivationState
      hostSetup({
        onInbound: async () => {
          inboundCalled = true;
        },
      }),
    );

    await sendInbound(handler, PHONE, 'hello');

    expect(inboundCalled).toBe(false);
  });

  it('scenario 3: non-keyword inbound while pending triggers no agent turn', async () => {
    let inboundCalled = false;
    const config = baseConfig({ checkActivationState: () => 'pending' });
    const handler = createSmsWebhookHandler(
      config,
      hostSetup({
        onInbound: async () => {
          inboundCalled = true;
        },
      }),
    );

    await sendInbound(handler, PHONE, 'hello, how are you?');

    expect(inboundCalled).toBe(false);
  });

  it('scenario 4: fresh START flips pending→active and writes activation messages_in row', async () => {
    const seeds: Array<{ phone: string; action: string; prevState: string }> = [];
    const config = baseConfig({
      checkActivationState: () => 'pending',
      seedControlEvent: (phone, action, prevState) => seeds.push({ phone, action, prevState }),
    });
    const handler = createSmsWebhookHandler(config, hostSetup());

    await sendInbound(handler, PHONE, 'START');

    expect(seeds).toHaveLength(1);
    expect(seeds[0]).toMatchObject({ phone: PHONE, action: 'start', prevState: 'pending' });
  });

  it('scenario 5: STOP on active writes turn-triggering messages_in row', async () => {
    const seeds: Array<{ phone: string; action: string; prevState: string }> = [];
    const config = baseConfig({
      checkActivationState: () => 'active',
      seedControlEvent: (phone, action, prevState) => seeds.push({ phone, action, prevState }),
    });
    const handler = createSmsWebhookHandler(config, hostSetup());

    await sendInbound(handler, PHONE, 'STOP');

    expect(seeds).toHaveLength(1);
    expect(seeds[0]).toMatchObject({ phone: PHONE, action: 'stop', prevState: 'active' });
  });

  it('scenario 6: outbound suppression blocks sends regardless of seeding', async () => {
    const fetchCalls: string[] = [];
    const config = baseConfig({
      fetchImpl: async (_url, init) => {
        fetchCalls.push(String(init?.body));
        return new Response(JSON.stringify({ sid: 'SMout' }), { status: 201 });
      },
    });
    const adapter = createSmsAdapter(config);

    setSmsOptOut(PHONE, true, config);
    // Even if seeding notified the agent, outbound delivery is still suppressed.
    const sid = await adapter.deliver(PHONE, null, { kind: 'chat', content: 'hi' });

    expect(sid).toBeUndefined();
    expect(fetchCalls).toHaveLength(0);
  });
});
