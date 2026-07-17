import { describe, expect, it } from 'vitest';

import { redactPlatformId, redactUserId, redactStartToken } from './platform-redaction.js';

describe('platform redaction', () => {
  it('redacts SMS platform IDs and leaves non-SMS IDs unchanged', () => {
    expect(redactPlatformId('sms', '+15551234567')).toBe('+15...4567');
    expect(redactPlatformId('sms', 'not-a-phone')).toBe('[invalid-phone]');
    expect(redactPlatformId('telegram', 'telegram:123')).toBe('telegram:123');
  });

  it('redacts SMS user IDs and raw E.164 user IDs', () => {
    expect(redactUserId('sms:+15551234567')).toBe('sms:+15...4567');
    expect(redactUserId('+15551234567')).toBe('+15...4567');
    expect(redactUserId('telegram:123')).toBe('telegram:123');
    expect(redactUserId(null)).toBeNull();
  });

  it('masks a start-token placeholder — keeps the channel prefix, hides the credential', () => {
    // The token is the consent-gating activation credential; a log must never
    // carry it whole. Only the channel + a short prefix survives.
    const masked = redactStartToken('telegram:tok_a1b2c3d4e5f6');
    expect(masked).toBe('telegram:tok_a1…');
    expect(masked).not.toContain('b2c3d4e5f6'); // the entropy tail is gone
    // A bare token (no channel prefix) is masked the same way.
    expect(redactStartToken('tok_a1b2c3d4e5f6')).toBe('tok_a1…');
    expect(redactStartToken('')).toBe('');
    expect(redactStartToken(null)).toBeNull();
  });
});
