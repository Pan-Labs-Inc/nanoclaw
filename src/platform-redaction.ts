const E164_PHONE_RE = /^\+[1-9]\d{7,14}$/;
const SMS_USER_ID_RE = /^sms:(\+[1-9]\d{7,14})$/;

export function redactPlatformId(
  channelType: string | null | undefined,
  platformId: string | null | undefined,
): string | null | undefined {
  if (channelType !== 'sms') return platformId;
  const normalized = String(platformId || '').trim();
  if (!normalized) return platformId;
  if (!E164_PHONE_RE.test(normalized)) return '[invalid-phone]';
  return `${normalized.slice(0, 3)}...${normalized.slice(-4)}`;
}

export function redactUserId(userId: string | null | undefined): string | null | undefined {
  const normalized = String(userId || '').trim();
  if (!normalized) return userId;
  const smsMatch = normalized.match(SMS_USER_ID_RE);
  if (smsMatch) return `sms:${redactPlatformId('sms', smsMatch[1])}`;
  if (E164_PHONE_RE.test(normalized)) return redactPlatformId('sms', normalized);
  return userId;
}
