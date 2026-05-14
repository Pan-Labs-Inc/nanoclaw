import { spawnSync } from 'child_process';
import { describe, expect, it } from 'vitest';

const SCRIPT = 'setup/add-sms.sh';

function runAddSms(extraEnv: Record<string, string> = {}) {
  return spawnSync('bash', [SCRIPT], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      TWILIO_ACCOUNT_SID: 'AC00000000000000000000000000000000',
      TWILIO_AUTH_TOKEN: '0123456789abcdef',
      TWILIO_SMS_WEBHOOK_URL: 'https://example.com/webhook/sms',
      ...extraEnv,
    },
    encoding: 'utf8',
  });
}

describe('setup/add-sms.sh', () => {
  it('rejects phone-number senders unless the local/dev allow flag is set', () => {
    const result = runAddSms({ TWILIO_PHONE_NUMBER: '+15551234567' });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('STATUS: failed');
    expect(result.stdout).toContain('TWILIO_PHONE_NUMBER is local/dev only');
    expect(result.stdout).toContain('TWILIO_MESSAGING_SERVICE_SID');
  });

  it('asks for a Messaging Service SID when no sender is configured', () => {
    const result = runAddSms();

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('STATUS: failed');
    expect(result.stdout).toContain('set TWILIO_MESSAGING_SERVICE_SID');
  });

  it('requires an explicit status callback URL for Messaging Service installs', () => {
    const result = runAddSms({
      TWILIO_MESSAGING_SERVICE_SID: 'MG1234567890abcdef1234567890abcdef',
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('STATUS: failed');
    expect(result.stdout).toContain('TWILIO_SMS_STATUS_CALLBACK_URL env var not set');
  });

  it('honors the local/dev allow flag before validating a phone sender', () => {
    const result = runAddSms({
      NANOCLAW_SMS_ALLOW_PHONE_SENDER: 'true',
      TWILIO_PHONE_NUMBER: 'not-e164',
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('STATUS: failed');
    expect(result.stdout).toContain('TWILIO_PHONE_NUMBER must be E.164');
  });
});
