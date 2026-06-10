import { describe, expect, it, vi } from 'vitest';

import { configureMessagingServiceWebhooks } from './sms.js';

describe('configureMessagingServiceWebhooks', () => {
  it('updates the Twilio Messaging Service inbound and status callback URLs', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));

    await configureMessagingServiceWebhooks({
      accountSid: 'AC00000000000000000000000000000000',
      authToken: '0123456789abcdef',
      serviceSid: 'MG1234567890abcdef1234567890abcdef',
      inboundRequestUrl: 'https://example.com/webhook/sms',
      statusCallbackUrl: 'https://example.com/webhook/sms/status',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://messaging.twilio.com/v1/Services/MG1234567890abcdef1234567890abcdef');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      Authorization: `Basic ${Buffer.from('AC00000000000000000000000000000000:0123456789abcdef').toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    });

    const body = new URLSearchParams(init.body as string);
    expect(body.get('InboundRequestUrl')).toBe('https://example.com/webhook/sms');
    expect(body.get('InboundMethod')).toBe('POST');
    expect(body.get('StatusCallback')).toBe('https://example.com/webhook/sms/status');
    expect(body.get('UseInboundWebhookOnNumber')).toBe('false');
  });

  it('surfaces Twilio errors without leaking phone numbers from the response body', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('Failed to configure +15551234567 from %2B15550001111', {
          status: 403,
        }),
    );

    let error: unknown;
    try {
      await configureMessagingServiceWebhooks({
        accountSid: 'AC00000000000000000000000000000000',
        authToken: '0123456789abcdef',
        serviceSid: 'MG1234567890abcdef1234567890abcdef',
        inboundRequestUrl: 'https://example.com/webhook/sms',
        statusCallbackUrl: 'https://example.com/webhook/sms/status',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('Twilio Messaging Service webhook configuration failed (403)');
    expect((error as Error).message).not.toContain('+15551234567');
  });
});
