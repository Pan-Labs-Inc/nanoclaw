/**
 * Channel-agnostic start-token activation — the generic leg of the dm_register
 * born-suppressed state machine (see admin-mcp.ts dmRegisterTool).
 *
 * `dm_register({channel, address:<token>, require_opt_in:true})` creates a
 * messaging group keyed by a placeholder platform id (`<channel>:<token>`)
 * because the real chat/sender id is unknown until the user first contacts us.
 * The registrar hands the user a channel-appropriate way to send the token:
 *   - Telegram: a deep link (https://t.me/<bot>?start=<token>) → `/start <token>`
 *   - SMS:      "text START <token> to <number>"
 *   - cli:      "send `start <token>`"
 * On receipt, the channel adapter's inbound interceptor calls
 * `tryActivateStartToken`, which rebinds the placeholder messaging group to the
 * real platform id, stamps the registration `activatedAt` (flipping dm_status
 * 'pending' → 'active'), and seeds an awareness task into the owning agent's
 * session. The unguessable single-use token is what binds the sender's chat to
 * the registration action — so one token works on ANY channel.
 *
 * Distinct from telegram-pairing.ts: pairing proves an OPERATOR owns a chat
 * (interactive 4-digit code); start-token activation binds an END USER's chat to
 * a pre-provisioned registration. Tokens are long random strings, so a miss is a
 * stale/foreign link, not a brute-force concern — misses pass through, never
 * invalidate.
 */
import {
  getMessagingGroupByPlatform,
  getMessagingGroupAgents,
  updateMessagingGroup,
  deleteMessagingGroup,
} from '../db/messaging-groups.js';
import { wakeContainer } from '../container-runner.js';
import { readDmRegistrations, writeDmRegistrations, type DmRegistration } from '../dm-registrations.js';
import { log } from '../log.js';
import { isTelegramGroupPlatformId } from '../platform-id.js';
import { resolveSession, writeSessionMessage } from '../session-manager.js';

// The token alphabet/length, shared by every channel: Telegram start payloads
// are [A-Za-z0-9_-]{1,64}; we require ≥8 so a short word after a bare "start"
// can never consume a registration by accident.
const TOKEN = '([A-Za-z0-9_-]{8,64})';
// Telegram: `/start <token>` and the privacy-ON group form `/start@bot <token>`.
const TELEGRAM_RE = new RegExp(`^/start(?:@(\\S+))?\\s+${TOKEN}$`, 'i');
// Every other channel (SMS, cli, …): an optional `start`/`/start` keyword then
// the token, OR the bare token alone (the registration lookup is the real
// guard — an unknown token simply passes through). Carriers fold the CTIA
// `START` opt-in keyword; `START <token>` reaches us as this same shape.
const GENERIC_RE = new RegExp(`^(?:/?start\\s+)?${TOKEN}$`, 'i');

/**
 * Extract a start-token from an inbound message for the given channel. Telegram
 * requires the `/start[@bot] <token>` command form (and a matching bot
 * username); other channels accept `start <token>` or a bare token. Returns
 * null for any non-match.
 */
export function extractStartToken(text: string, opts: { channel: string; botUsername?: string | null }): string | null {
  const trimmed = text.trim();
  if (opts.channel === 'telegram') {
    const m = trimmed.match(TELEGRAM_RE);
    if (!m) return null;
    // Reject a mismatched @bot address (a different bot in the same group).
    if (m[1] && (!opts.botUsername || m[1].toLowerCase() !== opts.botUsername.toLowerCase())) return null;
    return m[2];
  }
  const m = trimmed.match(GENERIC_RE);
  return m ? m[1] : null;
}

/**
 * Whether a messaging group's platform id is still an UNREDEEMED start-token
 * placeholder — a born-suppressed `require_opt_in` registration whose token has
 * not yet been tapped (no `activatedAt`). The placeholder's platform id is the
 * `<channel>:<token>` the registration is keyed by, which resolves to no real
 * chat. A delivering container must NOT spawn for such a group: its outbound
 * would be addressed to the unbound token and fail permanently, and Day-1 must
 * not fire for a pending persona (#1068 / #728).
 *
 * After the `/start` rebind the registration KEY stays the token but the group's
 * platform id becomes the real chat id (`tryActivateStartToken` flips it in
 * place), so a lookup keyed by the now-bound platform id no longer matches and
 * this returns false — the group is live.
 */
export function isUnredeemedStartTokenPlaceholder(
  platformId: string | null | undefined,
  regs: Record<string, DmRegistration> = readDmRegistrations(),
): boolean {
  if (!platformId) return false;
  const reg = regs[platformId];
  return Boolean(reg && reg.requireOptIn && !reg.activatedAt);
}

/** Whether a bound platform id is a multi-party group for the channel. */
function isGroupPlatformId(channel: string, platformId: string): boolean {
  // Only Telegram has the group/DM platform-id distinction today; SMS and cli
  // are 1:1. New group-capable channels extend this switch.
  return channel === 'telegram' ? isTelegramGroupPlatformId(platformId) : false;
}

export interface StartTokenActivation {
  groupName: string;
  tokenPlatformId: string;
  boundPlatformId: string;
  /** True when this was a re-send of an already-consumed token from the same chat. */
  replay: boolean;
  /**
   * The registration's canned opener, for the channel adapter to deliver via
   * its instant-reply path in place of the generic confirmation. Null when the
   * registration carries none, and on replay (never re-send the opener).
   */
  openerText: string | null;
}

/**
 * Try to activate a pending start-token registration from an inbound message on
 * any channel. Returns activation details on success (the caller short-circuits
 * the message — the token never reaches an agent), or null on no match (the
 * caller passes the message through).
 */
export function tryActivateStartToken(input: {
  text: string;
  channel: string;
  platformId: string;
  botUsername?: string | null;
}): StartTokenActivation | null {
  const token = extractStartToken(input.text, { channel: input.channel, botUsername: input.botUsername });
  if (!token) return null;

  const tokenPlatformId = `${input.channel}:${token}`;
  const regs = readDmRegistrations();
  const reg = regs[tokenPlatformId];
  if (!reg || reg.channel !== input.channel || !reg.requireOptIn) return null;

  if (reg.activatedAt) {
    // Re-send of a consumed token. Same chat: swallow (idempotent). Different
    // chat: stale/forwarded token — pass through.
    if (reg.boundPlatformId === input.platformId) {
      return {
        groupName: reg.groupName,
        tokenPlatformId,
        boundPlatformId: input.platformId,
        replay: true,
        openerText: null,
      };
    }
    log.warn('start-token re-use from a different chat ignored', {
      channel: input.channel,
      groupName: reg.groupName,
      platformId: input.platformId,
    });
    return null;
  }

  const placeholder = getMessagingGroupByPlatform(input.channel, tokenPlatformId);
  if (!placeholder) {
    log.error('start-token registration has no placeholder messaging group', {
      channel: input.channel,
      groupName: reg.groupName,
      tokenPlatformId,
    });
    return null;
  }

  const isGroup = isGroupPlatformId(input.channel, input.platformId);
  const now = new Date().toISOString();

  // A row already exists for this chat — the chat contacted us before the token
  // was redeemed. The two shapes diverge here (#958):
  const existing = getMessagingGroupByPlatform(input.channel, input.platformId);
  if (existing) {
    if (!isGroup) {
      // DM/1:1: rebinding the placeholder onto this chat would violate
      // UNIQUE(channel_type, platform_id). Refuse loudly and leave the
      // registration pending — the operator resolves it; silent merging would
      // mis-wire agents on a 1:1 channel.
      log.error('start-token activation refused — chat already has a messaging group', {
        channel: input.channel,
        groupName: reg.groupName,
        platformId: input.platformId,
        existingMessagingGroupId: existing.id,
      });
      return null;
    }
    // Group: evict the unwanted occupant (typically an unwired stub the
    // channel-registration flow created) to free the UNIQUE slot, then take it
    // over with the placeholder, which already carries the registration's agent
    // wiring + session. Groups are public by nature, so the activating member is
    // never dropped as not_member.
    deleteMessagingGroup(existing.id);
  }

  // Clean bind (also reached after a group-squatter eviction): repoint the
  // placeholder onto the real platform id. For a group also flip is_group (the
  // placeholder is born is_group=0 for a 1:1); the placeholder's
  // unknown_sender_policy is already 'public' (born so for every require_opt_in
  // registration), so it carries through.
  updateMessagingGroup(placeholder.id, {
    platform_id: input.platformId,
    ...(isGroup ? { is_group: 1 } : {}),
  });
  regs[tokenPlatformId] = { ...reg, activatedAt: now, boundPlatformId: input.platformId };
  writeDmRegistrations(regs);

  // wake_on_redeem: false (per-registration) = stay dormant until the user's
  // first real inbound — no awareness task, no wake. The first container turn
  // is then the user's own message, which opens a clean per-turn hook cycle
  // instead of being pushed mid-stream into a long warming turn
  // (pantalaimon#1451). The instant opener below is unaffected.
  if (reg.wakeOnRedeem !== false) {
    seedActivationAwareness(reg.groupName, placeholder.id, input.channel, input.platformId, now);
  } else {
    log.info('start-token activation is dormant (wake_on_redeem: false) — first spawn rides the first inbound', {
      channel: input.channel,
      groupName: reg.groupName,
    });
  }

  log.info('start-token activation accepted', {
    channel: input.channel,
    groupName: reg.groupName,
    platformId: input.platformId,
    isGroup,
  });

  return {
    groupName: reg.groupName,
    tokenPlatformId,
    boundPlatformId: input.platformId,
    replay: false,
    openerText: reg.cannedOpener ?? null,
  };
}

/**
 * Seed an awareness task into every agent session wired to the activated
 * messaging group — the generic analog of sms.ts seedControlEventAwareness's
 * pending→active START transition. Best-effort: activation already succeeded.
 */
function seedActivationAwareness(
  groupName: string,
  messagingGroupId: string,
  channel: string,
  platformId: string,
  now: string,
): void {
  try {
    const wirings = getMessagingGroupAgents(messagingGroupId);
    for (const wiring of wirings) {
      const { session } = resolveSession(wiring.agent_group_id, messagingGroupId, null, wiring.session_mode);
      writeSessionMessage(wiring.agent_group_id, session.id, {
        id: `activate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'task',
        timestamp: now,
        platformId,
        channelType: channel,
        content: JSON.stringify({
          prompt: `User activated the ${channel} channel via start-token — channel is now active`,
        }),
        trigger: 1,
      });
      // #1420: wake immediately rather than leaving the seeded task for the
      // next host-sweep tick (up to 60s away) — the user just opted in and is
      // watching the chat. The group was rebound above, so the sweep's
      // placeholder guard no longer applies. Fire-and-forget: wakeContainer
      // never throws and dedups concurrent wakes.
      void wakeContainer(session);
    }
  } catch (err) {
    log.warn('Failed to seed start-token activation awareness', { groupName, channel, err });
  }
}
