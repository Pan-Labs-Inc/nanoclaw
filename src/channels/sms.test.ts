import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import type { ChannelSetup, InboundMessage } from './adapter.js';
import {
  createSmsAdapter,
  createSmsWebhookHandler,
  extractSmsText,
  getSmsControlEvent,
  isSmsOptedOut,
  parseSmsOptOutType,
  parseTwilioInbound,
  parseSmsControlAction,
  readSmsConfig,
  sendTwilioSms,
  setSmsOptOut,
  stripSmsMarkdown,
  twilioInboundToMessage,
  validateTwilioSignature,
  type SmsConfig,
} from './sms.js';

const VALID_ACCOUNT_SID = 'AC00000000000000000000000000000000';
const VALID_MESSAGING_SERVICE_SID = 'MG1234567890abcdef1234567890abcdef';

function baseConfig(overrides: Partial<SmsConfig> = {}): SmsConfig {
  return {
    accountSid: 'AC123',
    authToken: 'secret',
    sender: '+15550001111',
    validateSignature: true,
    validateCredentials: false,
    ...overrides,
  };
}

function signature(url: string, params: URLSearchParams, token = 'secret'): string {
  const payload =
    url +
    [...new Set([...params.keys()])]
      .sort()
      .map((key) => `${key}${params.getAll(key).join('')}`)
      .join('');
  return crypto.createHmac('sha1', token).update(payload).digest('base64');
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

function optOutStorePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-sms-test-'));
  return path.join(dir, 'sms-opt-outs.json');
}

function withSmsEnv(env: Record<string, string>, fn: () => void): void {
  const keys = [
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_MESSAGING_SERVICE_SID',
    'TWILIO_PHONE_NUMBER',
    'TWILIO_FROM_NUMBER',
    'TWILIO_SMS_WEBHOOK_URL',
    'TWILIO_SMS_STATUS_CALLBACK_URL',
    'TWILIO_STATUS_CALLBACK_URL',
    'NANOCLAW_SMS_ALLOW_PHONE_SENDER',
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, env);
  try {
    fn();
  } finally {
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('SMS channel helpers', () => {
  it('parses Twilio inbound webhook fields into NanoClaw chat content', () => {
    const inbound = parseTwilioInbound(
      new URLSearchParams({
        MessageSid: 'SM123',
        From: '+15551234567',
        To: '+15557654321',
        Body: 'hello',
        NumMedia: '1',
        MediaUrl0: 'https://api.twilio.com/media/ME123',
        MediaContentType0: 'image/jpeg',
      }),
    );

    expect(inbound).toEqual({
      messageSid: 'SM123',
      from: '+15551234567',
      to: '+15557654321',
      body: 'hello',
      numMedia: 1,
      media: [{ url: 'https://api.twilio.com/media/ME123', contentType: 'image/jpeg' }],
    });

    const message = twilioInboundToMessage(inbound);
    expect(message).toMatchObject({
      id: 'SM123',
      kind: 'chat',
      isMention: true,
      isGroup: false,
    });
    expect(message.content).toMatchObject({
      text: 'hello',
      sender: '+15551234567',
      senderId: '+15551234567',
      provider: 'twilio',
    });
  });

  it('strips markdown before delivery', () => {
    expect(stripSmsMarkdown('# Heading\n\nUse **bold**, _italic_, and [link](https://example.com).')).toBe(
      'Heading\n\nUse bold, italic, and link.',
    );
    expect(extractSmsText({ kind: 'chat', content: { markdown: '*hello* [there](https://x.test)' } })).toBe(
      'hello there',
    );
  });

  it('renders ask-question payloads as numbered plain text', () => {
    expect(
      extractSmsText({
        kind: 'chat',
        content: {
          type: 'ask_question',
          title: 'Pick one',
          question: 'Which option?',
          options: [
            { label: 'A', value: 'a' },
            { label: 'B', value: 'b' },
          ],
        },
      }),
    ).toBe('Pick one\n\nWhich option?\n\n1. A\n2. B');
  });

  it('validates Twilio webhook signatures', () => {
    const url = 'https://example.com/webhook/sms';
    const params = new URLSearchParams({
      From: '+15551234567',
      Body: 'hello',
      MessageSid: 'SM123',
    });
    const sig = signature(url, params);

    expect(validateTwilioSignature('secret', url, params, sig)).toBe(true);
    expect(validateTwilioSignature('wrong', url, params, sig)).toBe(false);
  });

  it('recognizes SMS opt-out control keywords only as standalone messages', () => {
    expect(parseSmsControlAction('STOP')).toBe('stop');
    expect(parseSmsControlAction('stop!')).toBe('stop');
    expect(parseSmsControlAction('START')).toBe('start');
    expect(parseSmsControlAction('HELP')).toBe('help');
    expect(parseSmsControlAction('please stop')).toBeNull();
  });

  it('maps Twilio Advanced Opt-Out types to local control actions', () => {
    expect(parseSmsOptOutType('STOP')).toBe('stop');
    expect(parseSmsOptOutType('START')).toBe('start');
    expect(parseSmsOptOutType('HELP')).toBe('help');
    expect(parseSmsOptOutType('OTHER')).toBeNull();
  });

  it('prefers a Messaging Service SID over a phone sender when both are configured', () => {
    withSmsEnv(
      {
        TWILIO_ACCOUNT_SID: VALID_ACCOUNT_SID,
        TWILIO_AUTH_TOKEN: '0123456789abcdef',
        TWILIO_MESSAGING_SERVICE_SID: VALID_MESSAGING_SERVICE_SID,
        TWILIO_PHONE_NUMBER: '+15550001111',
        TWILIO_SMS_WEBHOOK_URL: 'https://example.com/webhook/sms',
        TWILIO_SMS_STATUS_CALLBACK_URL: 'https://example.com/webhook/sms/status',
      },
      () => {
        expect(readSmsConfig()?.sender).toBe(VALID_MESSAGING_SERVICE_SID);
      },
    );
  });

  it('requires explicit webhook and status callback URLs for Messaging Service SMS at runtime', () => {
    withSmsEnv(
      {
        TWILIO_ACCOUNT_SID: VALID_ACCOUNT_SID,
        TWILIO_AUTH_TOKEN: '0123456789abcdef',
        TWILIO_MESSAGING_SERVICE_SID: VALID_MESSAGING_SERVICE_SID,
      },
      () => {
        expect(() => readSmsConfig()).toThrow(/TWILIO_SMS_WEBHOOK_URL/);
      },
    );

    withSmsEnv(
      {
        TWILIO_ACCOUNT_SID: VALID_ACCOUNT_SID,
        TWILIO_AUTH_TOKEN: '0123456789abcdef',
        TWILIO_MESSAGING_SERVICE_SID: VALID_MESSAGING_SERVICE_SID,
        TWILIO_SMS_WEBHOOK_URL: 'https://example.com/webhook/sms',
      },
      () => {
        expect(() => readSmsConfig()).toThrow(/TWILIO_SMS_STATUS_CALLBACK_URL/);
      },
    );

    withSmsEnv(
      {
        TWILIO_ACCOUNT_SID: VALID_ACCOUNT_SID,
        TWILIO_AUTH_TOKEN: '0123456789abcdef',
        TWILIO_MESSAGING_SERVICE_SID: VALID_MESSAGING_SERVICE_SID,
        TWILIO_SMS_WEBHOOK_URL: 'https://example.com/webhook/sms',
        TWILIO_STATUS_CALLBACK_URL: 'https://example.com/webhook/sms/status',
      },
      () => {
        expect(() => readSmsConfig()).toThrow(/TWILIO_SMS_STATUS_CALLBACK_URL/);
      },
    );

    withSmsEnv(
      {
        TWILIO_ACCOUNT_SID: VALID_ACCOUNT_SID,
        TWILIO_AUTH_TOKEN: '0123456789abcdef',
        TWILIO_MESSAGING_SERVICE_SID: VALID_MESSAGING_SERVICE_SID,
        TWILIO_SMS_WEBHOOK_URL: 'https://example.com/webhook/sms',
        TWILIO_SMS_STATUS_CALLBACK_URL: 'https://example.com/webhook/sms/status',
      },
      () => {
        expect(readSmsConfig()?.statusCallbackUrl).toBe('https://example.com/webhook/sms/status');
      },
    );
  });

  it('rejects malformed Twilio runtime env values', () => {
    withSmsEnv(
      {
        TWILIO_ACCOUNT_SID: VALID_ACCOUNT_SID,
        TWILIO_AUTH_TOKEN: '0123456789abcdef',
        TWILIO_MESSAGING_SERVICE_SID: 'MG123',
        TWILIO_PHONE_NUMBER: '+15550001111',
      },
      () => {
        expect(() => readSmsConfig()).toThrow(/TWILIO_MESSAGING_SERVICE_SID/);
      },
    );
  });

  it('rejects SMS sender env values that are neither Messaging Service SIDs nor E.164 phone numbers', () => {
    withSmsEnv(
      {
        TWILIO_ACCOUNT_SID: VALID_ACCOUNT_SID,
        TWILIO_AUTH_TOKEN: '0123456789abcdef',
        TWILIO_PHONE_NUMBER: 'not-a-phone',
      },
      () => {
        expect(() => readSmsConfig()).toThrow(/TWILIO_PHONE_NUMBER/);
      },
    );

    withSmsEnv(
      {
        TWILIO_ACCOUNT_SID: VALID_ACCOUNT_SID,
        TWILIO_AUTH_TOKEN: '0123456789abcdef',
        TWILIO_FROM_NUMBER: 'not-a-sender',
      },
      () => {
        expect(() => readSmsConfig()).toThrow(/TWILIO_FROM_NUMBER/);
      },
    );
  });

  it('requires an explicit local/dev flag for phone-number SMS senders at runtime', () => {
    withSmsEnv(
      {
        TWILIO_ACCOUNT_SID: VALID_ACCOUNT_SID,
        TWILIO_AUTH_TOKEN: '0123456789abcdef',
        TWILIO_PHONE_NUMBER: '+15550001111',
      },
      () => {
        expect(() => readSmsConfig()).toThrow(/NANOCLAW_SMS_ALLOW_PHONE_SENDER/);
      },
    );

    withSmsEnv(
      {
        TWILIO_ACCOUNT_SID: VALID_ACCOUNT_SID,
        TWILIO_AUTH_TOKEN: '0123456789abcdef',
        TWILIO_PHONE_NUMBER: '+15550001111',
        NANOCLAW_SMS_ALLOW_PHONE_SENDER: 'true',
      },
      () => {
        expect(readSmsConfig()?.sender).toBe('+15550001111');
      },
    );
  });

  it('rejects malformed Twilio webhook URLs at startup', () => {
    withSmsEnv(
      {
        TWILIO_ACCOUNT_SID: VALID_ACCOUNT_SID,
        TWILIO_AUTH_TOKEN: '0123456789abcdef',
        TWILIO_MESSAGING_SERVICE_SID: VALID_MESSAGING_SERVICE_SID,
        TWILIO_SMS_WEBHOOK_URL: 'not-a-url',
        TWILIO_SMS_STATUS_CALLBACK_URL: 'https://example.com/webhook/sms/status',
      },
      () => {
        expect(() => readSmsConfig()).toThrow(/TWILIO_SMS_WEBHOOK_URL/);
      },
    );

    withSmsEnv(
      {
        TWILIO_ACCOUNT_SID: VALID_ACCOUNT_SID,
        TWILIO_AUTH_TOKEN: '0123456789abcdef',
        TWILIO_MESSAGING_SERVICE_SID: VALID_MESSAGING_SERVICE_SID,
        TWILIO_SMS_WEBHOOK_URL: 'https://example.com/webhook/sms',
        TWILIO_SMS_STATUS_CALLBACK_URL: 'ftp://example.com/webhook/sms/status',
      },
      () => {
        expect(() => readSmsConfig()).toThrow(/TWILIO_SMS_STATUS_CALLBACK_URL/);
      },
    );
  });

  it('derives and validates status callback URL from the inbound webhook URL', () => {
    withSmsEnv(
      {
        TWILIO_ACCOUNT_SID: VALID_ACCOUNT_SID,
        TWILIO_AUTH_TOKEN: '0123456789abcdef',
        TWILIO_PHONE_NUMBER: '+15550001111',
        NANOCLAW_SMS_ALLOW_PHONE_SENDER: 'true',
        TWILIO_SMS_WEBHOOK_URL: 'https://example.com/webhook/sms',
      },
      () => {
        expect(readSmsConfig()?.statusCallbackUrl).toBe('https://example.com/webhook/sms/status');
      },
    );
  });
});

describe('SMS delivery', () => {
  it('posts outbound messages to Twilio with From number auth', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ sid: 'SMout' }), { status: 201 });
    };

    const sid = await sendTwilioSms(baseConfig({ fetchImpl }), '+15551234567', 'hello');

    expect(sid).toBe('SMout');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from('AC123:secret').toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    expect(String(calls[0].init.body)).toBe('To=%2B15551234567&Body=hello&From=%2B15550001111');
  });

  it('uses MessagingServiceSid and status callback when configured', async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      calls.push(String(init?.body));
      return new Response(JSON.stringify({ sid: 'SMout' }), { status: 201 });
    };

    await sendTwilioSms(
      baseConfig({
        sender: VALID_MESSAGING_SERVICE_SID,
        statusCallbackUrl: 'https://example.com/webhook/sms/status',
        fetchImpl,
      }),
      '+15551234567',
      'hello',
    );

    expect(calls[0]).toBe(
      `To=%2B15551234567&Body=hello&MessagingServiceSid=${VALID_MESSAGING_SERVICE_SID}&StatusCallback=https%3A%2F%2Fexample.com%2Fwebhook%2Fsms%2Fstatus`,
    );
  });

  it('rejects invalid outbound senders before calling Twilio', async () => {
    let called = false;
    const fetchImpl: typeof fetch = async () => {
      called = true;
      return new Response('{}', { status: 201 });
    };

    await expect(
      sendTwilioSms(baseConfig({ sender: 'not-a-sender', fetchImpl }), '+15551234567', 'hello'),
    ).rejects.toThrow(/SMS sender/);
    await expect(sendTwilioSms(baseConfig({ sender: 'MG123', fetchImpl }), '+15551234567', 'hello')).rejects.toThrow(
      /SMS sender/,
    );
    expect(called).toBe(false);
  });

  it('rejects invalid outbound recipients before calling Twilio', async () => {
    let called = false;
    const fetchImpl: typeof fetch = async () => {
      called = true;
      return new Response('{}', { status: 201 });
    };

    await expect(sendTwilioSms(baseConfig({ fetchImpl }), 'not-a-phone', 'hello')).rejects.toThrow(/SMS recipient/);
    await expect(sendTwilioSms(baseConfig({ fetchImpl }), '+1555', 'hello')).rejects.toThrow(/SMS recipient/);
    expect(called).toBe(false);
  });

  it('redacts phone numbers from Twilio send errors', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response('Cannot send from +15550001111 to %2B15551234567', { status: 400 });

    let err: unknown;
    try {
      await sendTwilioSms(baseConfig({ fetchImpl }), '+15551234567', 'hello');
    } catch (caught) {
      err = caught;
    }

    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain('[redacted-phone]');
    expect(message).not.toContain('+15550001111');
    expect(message).not.toContain('+15551234567');
    expect(message).not.toContain('%2B15551234567');
  });

  it('does not manually split long messages before handing them to Twilio', async () => {
    const bodies: string[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      bodies.push(new URLSearchParams(String(init?.body)).get('Body') || '');
      return new Response(JSON.stringify({ sid: 'SMout' }), { status: 201 });
    };
    const longText = 'x'.repeat(500);
    const adapter = createSmsAdapter(baseConfig({ fetchImpl }));

    const sid = await adapter.deliver('+15551234567', null, { kind: 'chat', content: { text: longText } });

    expect(sid).toBe('SMout');
    expect(bodies).toEqual([longText]);
  });

  it('suppresses outbound messages to locally opted-out phone numbers', async () => {
    const calls: string[] = [];
    const config = baseConfig({
      optOutStorePath: optOutStorePath(),
      fetchImpl: async (_url, init) => {
        calls.push(String(init?.body));
        return new Response(JSON.stringify({ sid: 'SMout' }), { status: 201 });
      },
    });
    const adapter = createSmsAdapter(config);

    setSmsOptOut('+15551234567', true, config);
    const sid = await adapter.deliver('+15551234567', null, { kind: 'chat', content: 'hello' });

    expect(sid).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('suppresses outbound fail closed when the local opt-out store is corrupt', async () => {
    const calls: string[] = [];
    const storePath = optOutStorePath();
    fs.writeFileSync(storePath, '{not-json');
    const config = baseConfig({
      optOutStorePath: storePath,
      fetchImpl: async (_url, init) => {
        calls.push(String(init?.body));
        return new Response(JSON.stringify({ sid: 'SMout' }), { status: 201 });
      },
    });
    const adapter = createSmsAdapter(config);

    const sid = await adapter.deliver('+15551234567', null, { kind: 'chat', content: 'hello' });

    expect(sid).toBeUndefined();
    expect(calls).toEqual([]);
  });
});

describe('SMS webhook handler', () => {
  it('accepts signed inbound webhooks and forwards to host routing', async () => {
    const received: Array<{ platformId: string; threadId: string | null; message: InboundMessage }> = [];
    const params = new URLSearchParams({
      MessageSid: 'SM123',
      From: '+15551234567',
      To: '+15557654321',
      Body: 'hello',
    });
    const url = 'http://localhost/webhook/sms';
    const handler = createSmsWebhookHandler(
      baseConfig(),
      setup({
        onInbound(platformId, threadId, message) {
          received.push({ platformId, threadId, message });
        },
      }),
    );

    const response = await handler(
      new Request(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-twilio-signature': signature(url, params),
        },
        body: params.toString(),
      }),
      { waitUntil: () => {} },
    );

    expect(response.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      platformId: '+15551234567',
      threadId: null,
      message: { id: 'SM123', kind: 'chat' },
    });
  });

  it('rejects inbound webhooks with bad signatures', async () => {
    const params = new URLSearchParams({
      MessageSid: 'SM123',
      From: '+15551234567',
      Body: 'hello',
    });
    const handler = createSmsWebhookHandler(baseConfig(), setup());

    const response = await handler(
      new Request('http://localhost/webhook/sms', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-twilio-signature': signature('http://localhost/webhook/sms', params, 'wrong'),
        },
        body: params.toString(),
      }),
      { waitUntil: () => {} },
    );

    expect(response.status).toBe(403);
  });

  it('rejects inbound webhooks with malformed sender phone numbers before routing', async () => {
    const received: InboundMessage[] = [];
    const params = new URLSearchParams({
      MessageSid: 'SM123',
      From: 'not-a-phone',
      To: '+15557654321',
      Body: 'hello',
    });
    const url = 'http://localhost/webhook/sms';
    const handler = createSmsWebhookHandler(
      baseConfig(),
      setup({
        onInbound(_platformId, _threadId, message) {
          received.push(message);
        },
      }),
    );

    const response = await handler(
      new Request(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-twilio-signature': signature(url, params),
        },
        body: params.toString(),
      }),
      { waitUntil: () => {} },
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe('Invalid From');
    expect(received).toEqual([]);
  });

  it('handles STOP locally, records opt-out, and does not forward to host routing', async () => {
    const received: InboundMessage[] = [];
    const storePath = optOutStorePath();
    const config = baseConfig({ optOutStorePath: storePath });
    const params = new URLSearchParams({
      MessageSid: 'SM123',
      From: '+15551234567',
      To: '+15557654321',
      Body: 'STOP',
    });
    const url = 'http://localhost/webhook/sms';
    const handler = createSmsWebhookHandler(
      config,
      setup({
        onInbound(_platformId, _threadId, message) {
          received.push(message);
        },
      }),
    );

    const response = await handler(
      new Request(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-twilio-signature': signature(url, params),
        },
        body: params.toString(),
      }),
      { waitUntil: () => {} },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Reply START to resubscribe');
    expect(isSmsOptedOut('+15551234567', config)).toBe(true);
    expect(getSmsControlEvent('+15551234567', config)).toMatchObject({
      action: 'stop',
      keyword: 'STOP',
    });
    expect(fs.statSync(storePath).mode & 0o777).toBe(0o600);
    expect(received).toEqual([]);
  });

  it('handles STOP as control traffic when the local opt-out store is corrupt', async () => {
    const received: InboundMessage[] = [];
    const storePath = optOutStorePath();
    fs.writeFileSync(storePath, '{bad json');
    const config = baseConfig({ optOutStorePath: storePath });
    const params = new URLSearchParams({
      MessageSid: 'SM123-corrupt',
      From: '+15551234567',
      To: '+15557654321',
      Body: 'STOP',
    });
    const url = 'http://localhost/webhook/sms';
    const handler = createSmsWebhookHandler(
      config,
      setup({
        onInbound(_platformId, _threadId, message) {
          received.push(message);
        },
      }),
    );

    const response = await handler(
      new Request(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-twilio-signature': signature(url, params),
        },
        body: params.toString(),
      }),
      { waitUntil: () => {} },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('update SMS preferences');
    expect(isSmsOptedOut('+15551234567', config)).toBe(true);
    expect(received).toEqual([]);
  });

  it('handles START locally and resumes outbound delivery', async () => {
    const calls: string[] = [];
    const storePath = optOutStorePath();
    const config = baseConfig({
      optOutStorePath: storePath,
      fetchImpl: async (_url, init) => {
        calls.push(String(init?.body));
        return new Response(JSON.stringify({ sid: 'SMout' }), { status: 201 });
      },
    });
    setSmsOptOut('+15551234567', true, config);
    const params = new URLSearchParams({
      MessageSid: 'SM124',
      From: '+15551234567',
      To: '+15557654321',
      Body: 'START',
    });
    const url = 'http://localhost/webhook/sms';
    const handler = createSmsWebhookHandler(config, setup());

    const response = await handler(
      new Request(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-twilio-signature': signature(url, params),
        },
        body: params.toString(),
      }),
      { waitUntil: () => {} },
    );
    const adapter = createSmsAdapter(config);
    const sid = await adapter.deliver('+15551234567', null, { kind: 'chat', content: 'hello' });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('You are opted in to SMS messages');
    expect(isSmsOptedOut('+15551234567', config)).toBe(false);
    expect(getSmsControlEvent('+15551234567', config)).toMatchObject({
      action: 'start',
      keyword: 'START',
    });
    expect(sid).toBe('SMout');
    expect(calls).toHaveLength(1);
  });

  it('handles START as control traffic when the local opt-out store is corrupt', async () => {
    const received: InboundMessage[] = [];
    const storePath = optOutStorePath();
    fs.writeFileSync(storePath, '{bad json');
    const config = baseConfig({ optOutStorePath: storePath });
    const params = new URLSearchParams({
      MessageSid: 'SM124-corrupt',
      From: '+15551234567',
      To: '+15557654321',
      Body: 'START',
    });
    const url = 'http://localhost/webhook/sms';
    const handler = createSmsWebhookHandler(
      config,
      setup({
        onInbound(_platformId, _threadId, message) {
          received.push(message);
        },
      }),
    );

    const response = await handler(
      new Request(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-twilio-signature': signature(url, params),
        },
        body: params.toString(),
      }),
      { waitUntil: () => {} },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('update SMS preferences');
    expect(isSmsOptedOut('+15551234567', config)).toBe(true);
    expect(received).toEqual([]);
  });

  it('records YES as a start control event without forwarding to host routing', async () => {
    const received: InboundMessage[] = [];
    const storePath = optOutStorePath();
    const config = baseConfig({ optOutStorePath: storePath });
    const params = new URLSearchParams({
      MessageSid: 'SM125',
      From: '+15551234567',
      To: '+15557654321',
      Body: 'YES',
    });
    const url = 'http://localhost/webhook/sms';
    const handler = createSmsWebhookHandler(
      config,
      setup({
        onInbound(_platformId, _threadId, message) {
          received.push(message);
        },
      }),
    );

    const response = await handler(
      new Request(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-twilio-signature': signature(url, params),
        },
        body: params.toString(),
      }),
      { waitUntil: () => {} },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('You are opted in to SMS messages');
    expect(isSmsOptedOut('+15551234567', config)).toBe(false);
    expect(getSmsControlEvent('+15551234567', config)).toMatchObject({
      action: 'start',
      keyword: 'YES',
    });
    expect(received).toEqual([]);
  });

  it('still returns HELP when the local opt-out store is corrupt', async () => {
    const received: InboundMessage[] = [];
    const storePath = optOutStorePath();
    fs.writeFileSync(storePath, '{bad json');
    const config = baseConfig({ optOutStorePath: storePath });
    const params = new URLSearchParams({
      MessageSid: 'SM126',
      From: '+15551234567',
      To: '+15557654321',
      Body: 'HELP',
    });
    const url = 'http://localhost/webhook/sms';
    const handler = createSmsWebhookHandler(
      config,
      setup({
        onInbound(_platformId, _threadId, message) {
          received.push(message);
        },
      }),
    );

    const response = await handler(
      new Request(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-twilio-signature': signature(url, params),
        },
        body: params.toString(),
      }),
      { waitUntil: () => {} },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Reply STOP to opt out');
    expect(received).toEqual([]);
  });

  it('drops non-keyword inbound without calling onInbound when registration is pending', async () => {
    const received: InboundMessage[] = [];
    const storePath = optOutStorePath();
    const config = baseConfig({
      optOutStorePath: storePath,
      checkActivationState: () => 'pending',
    });
    const params = new URLSearchParams({
      MessageSid: 'SM200',
      From: '+15551234567',
      To: '+15557654321',
      Body: 'hello, just checking in',
    });
    const url = 'http://localhost/webhook/sms';
    const handler = createSmsWebhookHandler(
      config,
      setup({
        onInbound(_platformId, _threadId, message) {
          received.push(message);
        },
      }),
    );

    const response = await handler(
      new Request(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-twilio-signature': signature(url, params),
        },
        body: params.toString(),
      }),
      { waitUntil: () => {} },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<Response></Response>');
    expect(received).toEqual([]);
  });

  it('drops non-keyword inbound without calling onInbound when registration is suppressed post-STOP', async () => {
    const received: InboundMessage[] = [];
    const storePath = optOutStorePath();
    const config = baseConfig({
      optOutStorePath: storePath,
      checkActivationState: () => 'suppressed',
    });
    const params = new URLSearchParams({
      MessageSid: 'SM201',
      From: '+15551234567',
      To: '+15557654321',
      Body: 'are you there?',
    });
    const url = 'http://localhost/webhook/sms';
    const handler = createSmsWebhookHandler(
      config,
      setup({
        onInbound(_platformId, _threadId, message) {
          received.push(message);
        },
      }),
    );

    const response = await handler(
      new Request(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-twilio-signature': signature(url, params),
        },
        body: params.toString(),
      }),
      { waitUntil: () => {} },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<Response></Response>');
    expect(received).toEqual([]);
  });

  it('honors Twilio Advanced Opt-Out type even for custom keyword bodies', async () => {
    const received: InboundMessage[] = [];
    const storePath = optOutStorePath();
    const config = baseConfig({ optOutStorePath: storePath });
    const params = new URLSearchParams({
      MessageSid: 'SM126',
      From: '+15551234567',
      To: '+15557654321',
      Body: 'leave me alone',
      OptOutType: 'STOP',
    });
    const url = 'http://localhost/webhook/sms';
    const handler = createSmsWebhookHandler(
      config,
      setup({
        onInbound(_platformId, _threadId, message) {
          received.push(message);
        },
      }),
    );

    const response = await handler(
      new Request(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-twilio-signature': signature(url, params),
        },
        body: params.toString(),
      }),
      { waitUntil: () => {} },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<Response></Response>');
    expect(isSmsOptedOut('+15551234567', config)).toBe(true);
    expect(getSmsControlEvent('+15551234567', config)).toMatchObject({
      action: 'stop',
      keyword: 'STOP',
    });
    expect(received).toEqual([]);
  });

  it('calls seedControlEvent with start+pending when START arrives while registration is pending', async () => {
    const storePath = optOutStorePath();
    const seeds: Array<{ phone: string; action: string; prevState: string }> = [];
    const config = baseConfig({
      optOutStorePath: storePath,
      checkActivationState: () => 'pending',
      seedControlEvent: (phone, action, prevState) => seeds.push({ phone, action, prevState }),
    });
    const params = new URLSearchParams({
      MessageSid: 'SM301',
      From: '+15551234567',
      To: '+15557654321',
      Body: 'START',
    });
    const url = 'http://localhost/webhook/sms';
    const handler = createSmsWebhookHandler(config, setup());
    await handler(
      new Request(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-twilio-signature': signature(url, params),
        },
        body: params.toString(),
      }),
      { waitUntil: () => {} },
    );
    expect(seeds).toHaveLength(1);
    expect(seeds[0]).toMatchObject({ phone: '+15551234567', action: 'start', prevState: 'pending' });
  });

  it('calls seedControlEvent with stop+active when STOP arrives while channel is active', async () => {
    const storePath = optOutStorePath();
    const seeds: Array<{ phone: string; action: string; prevState: string }> = [];
    const config = baseConfig({
      optOutStorePath: storePath,
      checkActivationState: () => 'active',
      seedControlEvent: (phone, action, prevState) => seeds.push({ phone, action, prevState }),
    });
    const params = new URLSearchParams({
      MessageSid: 'SM302',
      From: '+15551234567',
      To: '+15557654321',
      Body: 'STOP',
    });
    const url = 'http://localhost/webhook/sms';
    const handler = createSmsWebhookHandler(config, setup());
    await handler(
      new Request(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-twilio-signature': signature(url, params),
        },
        body: params.toString(),
      }),
      { waitUntil: () => {} },
    );
    expect(seeds).toHaveLength(1);
    expect(seeds[0]).toMatchObject({ phone: '+15551234567', action: 'stop', prevState: 'active' });
  });

  it('calls seedControlEvent with start+suppressed when START re-activates a suppressed channel', async () => {
    const storePath = optOutStorePath();
    const seeds: Array<{ phone: string; action: string; prevState: string }> = [];
    const config = baseConfig({
      optOutStorePath: storePath,
      checkActivationState: () => 'suppressed',
      seedControlEvent: (phone, action, prevState) => seeds.push({ phone, action, prevState }),
    });
    const params = new URLSearchParams({
      MessageSid: 'SM303',
      From: '+15551234567',
      To: '+15557654321',
      Body: 'START',
    });
    const url = 'http://localhost/webhook/sms';
    const handler = createSmsWebhookHandler(config, setup());
    await handler(
      new Request(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-twilio-signature': signature(url, params),
        },
        body: params.toString(),
      }),
      { waitUntil: () => {} },
    );
    expect(seeds).toHaveLength(1);
    expect(seeds[0]).toMatchObject({ phone: '+15551234567', action: 'start', prevState: 'suppressed' });
  });
});
