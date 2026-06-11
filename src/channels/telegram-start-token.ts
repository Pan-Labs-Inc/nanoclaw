/**
 * Telegram /start-token activation — the Telegram leg of the dm_register
 * born-suppressed state machine (see admin-mcp.ts dmRegisterTool).
 *
 * dm_register({channel:'telegram', address:<token>, require_opt_in:true})
 * creates a messaging group keyed by a placeholder platform id
 * (`telegram:<token>`) because the real chat id is unknown until the user
 * first contacts the bot. The registrar hands the user a deep link
 * (https://t.me/<bot>?start=<token>); tapping it makes Telegram deliver
 * `/start <token>` as the chat's first message. The inbound interceptor in
 * telegram.ts calls tryActivateStartToken, which rebinds the messaging group
 * to the real chat platform id, stamps the registration `activatedAt`
 * (flipping dm_status from 'pending' to 'active'), and seeds an awareness
 * task into the owning agent's session — mirroring the SMS START transition
 * in sms.ts. The unguessable single-use token is what binds the chat to the
 * registration action.
 *
 * Distinct from telegram-pairing.ts: pairing proves an OPERATOR owns a chat
 * (interactive 4-digit code, one-attempt invalidation); start-token
 * activation binds an END USER's chat to a pre-provisioned registration.
 * Tokens are long random strings, so a miss here is a stale/foreign link,
 * not a brute-force concern — misses pass through, they never invalidate.
 */
import {
  getMessagingGroupByPlatform,
  getMessagingGroupAgents,
  updateMessagingGroup,
} from '../db/messaging-groups.js';
import { readDmRegistrations, writeDmRegistrations } from '../dm-registrations.js';
import { log } from '../log.js';
import { resolveSession, writeSessionMessage } from '../session-manager.js';

// Telegram start payloads are [A-Za-z0-9_-]{1,64}; require ≥8 so short words
// after a bare "/start" can never consume a registration by accident.
const START_TOKEN_RE = /^\/start(?:@(\S+))?\s+([A-Za-z0-9_-]{8,64})$/i;

/**
 * Extract a start-token from an inbound message. Matches `/start <token>`
 * and `/start@botname <token>` (group privacy-ON form). Returns null for a
 * bare /start, a mismatched bot username, or any other text.
 */
export function extractStartToken(text: string, botUsername: string): string | null {
  const m = text.trim().match(START_TOKEN_RE);
  if (!m) return null;
  if (m[1] && m[1].toLowerCase() !== botUsername.toLowerCase()) return null;
  return m[2];
}

export interface StartTokenActivation {
  groupName: string;
  tokenPlatformId: string;
  boundPlatformId: string;
  /** True when this was a re-tap of an already-consumed link from the same chat. */
  replay: boolean;
}

/**
 * Try to activate a pending Telegram start-token registration from an inbound
 * message. Returns activation details on success (caller should short-circuit
 * the message — the token never reaches an agent), or null on no match
 * (caller passes the message through).
 */
export function tryActivateStartToken(input: {
  text: string;
  botUsername: string;
  platformId: string;
}): StartTokenActivation | null {
  const token = extractStartToken(input.text, input.botUsername);
  if (!token) return null;

  const tokenPlatformId = `telegram:${token}`;
  const regs = readDmRegistrations();
  const reg = regs[tokenPlatformId];
  if (!reg || reg.channel !== 'telegram' || !reg.requireOptIn) return null;

  if (reg.activatedAt) {
    // Re-tap of a consumed link. Same chat: swallow the token message
    // (idempotent). Different chat: stale/forwarded link — pass through.
    if (reg.boundPlatformId === input.platformId) {
      return { groupName: reg.groupName, tokenPlatformId, boundPlatformId: input.platformId, replay: true };
    }
    log.warn('Telegram start-token re-use from a different chat ignored', {
      groupName: reg.groupName,
      platformId: input.platformId,
    });
    return null;
  }

  const placeholder = getMessagingGroupByPlatform('telegram', tokenPlatformId);
  if (!placeholder) {
    log.error('Telegram start-token registration has no placeholder messaging group', {
      groupName: reg.groupName,
      tokenPlatformId,
    });
    return null;
  }

  // Rebinding would violate UNIQUE(channel_type, platform_id) if the chat
  // already has a row (e.g. the user messaged the bot before tapping the
  // link). Refuse loudly and leave the registration pending — the operator
  // resolves the conflict; silent merging would mis-wire agents.
  const existing = getMessagingGroupByPlatform('telegram', input.platformId);
  if (existing) {
    log.error('Telegram start-token activation refused — chat already has a messaging group', {
      groupName: reg.groupName,
      platformId: input.platformId,
      existingMessagingGroupId: existing.id,
    });
    return null;
  }

  const now = new Date().toISOString();
  updateMessagingGroup(placeholder.id, { platform_id: input.platformId });
  regs[tokenPlatformId] = { ...reg, activatedAt: now, boundPlatformId: input.platformId };
  writeDmRegistrations(regs);

  seedActivationAwareness(reg.groupName, placeholder.id, input.platformId, now);

  log.info('Telegram start-token activation accepted', {
    groupName: reg.groupName,
    platformId: input.platformId,
  });

  return { groupName: reg.groupName, tokenPlatformId, boundPlatformId: input.platformId, replay: false };
}

/**
 * Seed an awareness task into every agent session wired to the activated
 * messaging group — the Telegram analog of sms.ts seedControlEventAwareness's
 * pending→active START transition. Best-effort: activation already succeeded.
 */
function seedActivationAwareness(
  groupName: string,
  messagingGroupId: string,
  platformId: string,
  now: string,
): void {
  try {
    const wirings = getMessagingGroupAgents(messagingGroupId);
    for (const wiring of wirings) {
      const { session } = resolveSession(wiring.agent_group_id, messagingGroupId, null, wiring.session_mode);
      writeSessionMessage(wiring.agent_group_id, session.id, {
        id: `tg-activate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'task',
        timestamp: now,
        platformId,
        channelType: 'telegram',
        content: JSON.stringify({
          prompt: 'User activated the Telegram channel via /start link — channel is now active',
        }),
        trigger: 1,
      });
    }
  } catch (err) {
    log.warn('Failed to seed Telegram activation awareness', { groupName, err });
  }
}
