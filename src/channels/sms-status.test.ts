import crypto from 'crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getActiveSessions: vi.fn(),
  openInboundDb: vi.fn(),
  updateDeliveredStatusByPlatformMessageId: vi.fn(),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../db/sessions.js', () => ({
  getActiveSessions: mocks.getActiveSessions,
}));

vi.mock('../session-manager.js', () => ({
  openInboundDb: mocks.openInboundDb,
}));

vi.mock('../db/session-db.js', () => ({
  updateDeliveredStatusByPlatformMessageId: mocks.updateDeliveredStatusByPlatformMessageId,
}));

vi.mock('../log.js', () => ({
  log: mocks.log,
}));

import type { ChannelSetup } from './adapter.js';
import { createSmsWebhookHandler, parseTwilioStatusCallback, type SmsConfig } from './sms.js';

function baseConfig(overrides: Partial<SmsConfig> = {}): SmsConfig {
  return {
    accountSid: 'AC123',
    authToken: 'secret',
    fromNumber: '+15550001111',
    validateSignature: true,
    validateCredentials: false,
    ...overrides,
  };
}

function setup(): ChannelSetup {
  return {
    onInbound: () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
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

describe('SMS status callbacks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parses Twilio delivery status callback fields', () => {
    const status = parseTwilioStatusCallback(
      new URLSearchParams({
        MessageSid: 'SM123',
        MessageStatus: 'delivered',
        To: '+15551234567',
        From: '+15550001111',
      }),
    );

    expect(status).toEqual({
      sid: 'SM123',
      status: 'delivered',
      to: '+15551234567',
      from: '+15550001111',
      errorCode: undefined,
      errorMessage: undefined,
    });
  });

  it('records signed Twilio status callbacks against delivered rows', async () => {
    const db1 = { close: vi.fn() };
    const db2 = { close: vi.fn() };
    mocks.getActiveSessions.mockReturnValue([
      { agent_group_id: 'ag-1', id: 'session-1' },
      { agent_group_id: 'ag-2', id: 'session-2' },
    ]);
    mocks.openInboundDb.mockReturnValueOnce(db1).mockReturnValueOnce(db2);
    mocks.updateDeliveredStatusByPlatformMessageId.mockReturnValueOnce(1).mockReturnValueOnce(0);

    const url = 'http://localhost/webhook/sms/status';
    const params = new URLSearchParams({
      MessageSid: 'SM123',
      MessageStatus: 'delivered',
      To: '+15551234567',
      From: '+15550001111',
    });
    const handler = createSmsWebhookHandler(baseConfig({ statusCallbackUrl: url }), setup());

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
    expect(await response.text()).toBe('OK');
    expect(mocks.openInboundDb).toHaveBeenCalledWith('ag-1', 'session-1');
    expect(mocks.openInboundDb).toHaveBeenCalledWith('ag-2', 'session-2');
    expect(mocks.updateDeliveredStatusByPlatformMessageId).toHaveBeenCalledWith(db1, 'SM123', 'delivered');
    expect(mocks.updateDeliveredStatusByPlatformMessageId).toHaveBeenCalledWith(db2, 'SM123', 'delivered');
    expect(db1.close).toHaveBeenCalled();
    expect(db2.close).toHaveBeenCalled();
  });

  it('redacts phone numbers from status callback logs', async () => {
    mocks.getActiveSessions.mockReturnValue([]);

    const url = 'http://localhost/webhook/sms/status';
    const params = new URLSearchParams({
      MessageSid: 'SM123',
      MessageStatus: 'failed',
      To: '+15551234567',
      From: '+15550001111',
      ErrorCode: '30003',
      ErrorMessage: 'Carrier rejected +15551234567 from %2B15550001111',
    });
    const handler = createSmsWebhookHandler(baseConfig({ statusCallbackUrl: url }), setup());

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
    expect(mocks.log.warn).toHaveBeenCalledWith(
      'Twilio SMS delivery failed',
      expect.objectContaining({
        to: '+15...4567',
        from: '+15...1111',
        errorMessage: 'Carrier rejected [redacted-phone] from [redacted-phone]',
      }),
    );
  });

  it('rejects status callbacks with bad Twilio signatures', async () => {
    const url = 'http://localhost/webhook/sms/status';
    const params = new URLSearchParams({
      MessageSid: 'SM123',
      MessageStatus: 'failed',
    });
    const handler = createSmsWebhookHandler(baseConfig({ statusCallbackUrl: url }), setup());

    const response = await handler(
      new Request(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-twilio-signature': signature(url, params, 'wrong'),
        },
        body: params.toString(),
      }),
      { waitUntil: () => {} },
    );

    expect(response.status).toBe(403);
    expect(mocks.getActiveSessions).not.toHaveBeenCalled();
    expect(mocks.updateDeliveredStatusByPlatformMessageId).not.toHaveBeenCalled();
  });
});
