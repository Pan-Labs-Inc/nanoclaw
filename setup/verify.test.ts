import { describe, expect, it } from 'vitest';

import { detectChannelAuth, determineVerifyStatus } from './verify.js';

const healthyBase = {
  service: 'running' as const,
  credentials: 'configured',
  registeredGroups: 1,
};

describe('determineVerifyStatus', () => {
  it('accepts a healthy install with at least one wired agent group', () => {
    expect(determineVerifyStatus(healthyBase)).toBe('success');
  });

  it('fails when no agent groups are registered', () => {
    expect(
      determineVerifyStatus({
        ...healthyBase,
        registeredGroups: 0,
      }),
    ).toBe('failed');
  });

  it('fails when the service is not running', () => {
    expect(
      determineVerifyStatus({
        ...healthyBase,
        service: 'stopped',
      }),
    ).toBe('failed');
  });

  it('fails when credentials are missing', () => {
    expect(
      determineVerifyStatus({
        ...healthyBase,
        credentials: 'missing',
      }),
    ).toBe('failed');
  });
});

describe('detectChannelAuth', () => {
  function authFrom(values: Record<string, string>) {
    return detectChannelAuth((key) => key in values && values[key] !== '', {
      getValue: (key) => values[key] ?? '',
    });
  }

  it('labels SMS as Messaging Service-backed when a Messaging Service SID is configured', () => {
    const auth = authFrom({
      TWILIO_ACCOUNT_SID: 'AC00000000000000000000000000000000',
      TWILIO_AUTH_TOKEN: '0123456789abcdef',
      TWILIO_MESSAGING_SERVICE_SID: 'MG1234567890abcdef1234567890abcdef',
      TWILIO_PHONE_NUMBER: '+15551234567',
      TWILIO_SMS_WEBHOOK_URL: 'https://example.com/webhook/sms',
      TWILIO_SMS_STATUS_CALLBACK_URL: 'https://example.com/webhook/sms/status',
    });

    expect(auth.sms).toBe('configured:messaging-service');
  });

  it('labels SMS as dev phone-backed when only a phone sender is configured', () => {
    const auth = authFrom({
      TWILIO_ACCOUNT_SID: 'AC00000000000000000000000000000000',
      TWILIO_AUTH_TOKEN: '0123456789abcdef',
      TWILIO_PHONE_NUMBER: '+15551234567',
      TWILIO_SMS_WEBHOOK_URL: 'https://example.com/webhook/sms',
      NANOCLAW_SMS_ALLOW_PHONE_SENDER: 'true',
    });

    expect(auth.sms).toBe('configured:phone-dev');
  });

  it('labels phone-backed SMS as invalid without the explicit local/dev flag', () => {
    const auth = authFrom({
      TWILIO_ACCOUNT_SID: 'AC00000000000000000000000000000000',
      TWILIO_AUTH_TOKEN: '0123456789abcdef',
      TWILIO_PHONE_NUMBER: '+15551234567',
      TWILIO_SMS_WEBHOOK_URL: 'https://example.com/webhook/sms',
    });

    expect(auth.sms).toBe('invalid:phone-dev-flag');
  });

  it('labels SMS as invalid when webhook settings are missing or malformed', () => {
    expect(
      authFrom({
        TWILIO_ACCOUNT_SID: 'AC00000000000000000000000000000000',
        TWILIO_AUTH_TOKEN: '0123456789abcdef',
        TWILIO_MESSAGING_SERVICE_SID: 'MG1234567890abcdef1234567890abcdef',
        TWILIO_SMS_STATUS_CALLBACK_URL: 'https://example.com/webhook/sms/status',
      }).sms,
    ).toBe('invalid:webhook-url');

    expect(
      authFrom({
        TWILIO_ACCOUNT_SID: 'AC00000000000000000000000000000000',
        TWILIO_AUTH_TOKEN: '0123456789abcdef',
        TWILIO_MESSAGING_SERVICE_SID: 'MG1234567890abcdef1234567890abcdef',
        TWILIO_SMS_WEBHOOK_URL: 'https://example.com/webhook/sms',
      }).sms,
    ).toBe('invalid:status-callback-url');
  });

  it('labels malformed SMS sender values as invalid', () => {
    expect(
      authFrom({
        TWILIO_ACCOUNT_SID: 'AC00000000000000000000000000000000',
        TWILIO_AUTH_TOKEN: '0123456789abcdef',
        TWILIO_MESSAGING_SERVICE_SID: 'MG123',
        TWILIO_SMS_WEBHOOK_URL: 'https://example.com/webhook/sms',
        TWILIO_SMS_STATUS_CALLBACK_URL: 'https://example.com/webhook/sms/status',
      }).sms,
    ).toBe('invalid:messaging-service');

    expect(
      authFrom({
        TWILIO_ACCOUNT_SID: 'AC00000000000000000000000000000000',
        TWILIO_AUTH_TOKEN: '0123456789abcdef',
        TWILIO_PHONE_NUMBER: 'not-e164',
        TWILIO_SMS_WEBHOOK_URL: 'https://example.com/webhook/sms',
      }).sms,
    ).toBe('invalid:phone-dev');
  });
});
