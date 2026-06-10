import { describe, expect, it } from 'vitest';

import { redactPlatformId, redactUserId } from './platform-redaction.js';

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
});
