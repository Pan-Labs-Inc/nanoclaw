/**
 * dm-registrations store — registration metadata written by admin-MCP
 * dm_register and read by dm_status and the channel activation state
 * machines (data/dm-registrations.json).
 *
 * Keyed by the namespaced platformId at registration time. For
 * born-suppressed Telegram registrations the key is the start-token
 * placeholder (`telegram:<token>`): the real chat id is unknown until the
 * user taps the deep link, so activation rebinds the messaging group to the
 * real chat platformId and records it here as `boundPlatformId`. The
 * registration key itself stays stable so dm_status lookups by token keep
 * working after activation.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';

export const DM_REGISTRATIONS_FILE = 'dm-registrations.json';

export type DmRegistration = {
  groupName: string;
  channel: string;
  address: string;
  registeredAt: string;
  requireOptIn: boolean;
  /** Stamped when a born-suppressed registration is activated (Telegram /start token). */
  activatedAt?: string;
  /** Real platform id the messaging group was rebound to at activation. */
  boundPlatformId?: string;
  /**
   * Optional opt-in confirmation message, registered as per-registration data
   * and delivered VERBATIM by the channel adapter's instant-reply path at
   * start-token redemption (in place of the generic "You're connected!" text).
   * The registrar owns the content; NanoClaw just carries and returns it.
   */
  cannedOpener?: string;
  /**
   * When false, the registration stays DORMANT until the user's first real
   * inbound message: no register-time /welcome task, no redemption-time
   * awareness task, no redemption wake — the first container turn is the
   * user's own first message. The instant-reply opener is unaffected (the
   * channel adapter delivers it with no container in the loop). Absent/true =
   * the default seed-and-wake behavior. Registrars opt out when a long
   * pre-warmed turn would collide with the user's reply to the opener
   * (pantalaimon#1451: mid-stream messages are pushed into the active query
   * and bypass per-turn hooks).
   */
  wakeOnRedeem?: boolean;
};

export function readDmRegistrations(): Record<string, DmRegistration> {
  const file = path.join(DATA_DIR, DM_REGISTRATIONS_FILE);
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, DmRegistration>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function writeDmRegistrations(regs: Record<string, DmRegistration>): void {
  const file = path.join(DATA_DIR, DM_REGISTRATIONS_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(regs, null, 2)}\n`, 'utf8');
}
