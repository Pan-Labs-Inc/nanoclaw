/**
 * `messages` — host-originated, verbatim channel sends.
 *
 * Unlike the table-backed resources, `messages` has no DB table of its own:
 * it is a thin action surface over `writeOutboundDirect`. The single verb
 *
 *     ncl messages send --folder <group-folder> --text <message>
 *
 * resolves a group folder → agent group → its wired messaging group, opens
 * (or reuses) a shared session, and writes the text straight to that
 * session's outbound.db as a `kind: 'agent'` message. The delivery poller
 * then ships it to the channel VERBATIM — it is never routed through the
 * agent's LLM.
 *
 * This is the sanctioned host→channel send (the same primitive command-gate
 * uses for denial replies). Because the host writes outbound.db with
 * `INSERT OR IGNORE` under an open-write-close connection, it is safe whether
 * or not a container for the group is currently running: the poller reads the
 * row out of band, and the (platformId, channelType) on the row hits the
 * delivery layer's origin-chat auto-allow, so no agent_destinations ACL row
 * is required.
 *
 * Registered as a plain command (not via `registerResource`) because there is
 * no underlying table for the generic CRUD handlers to operate on.
 */
import { randomUUID } from 'crypto';

import { getAgentGroupByFolder } from '../../db/agent-groups.js';
import { getMessagingGroupsByAgentGroup, getMessagingGroupAgentByPair } from '../../db/messaging-groups.js';
import { resolveSession, writeOutboundDirect, writeSessionMessage } from '../../session-manager.js';
import { log } from '../../log.js';
import { register } from '../registry.js';

interface SendArgs {
  folder: string;
  text: string;
  channelType?: string;
  platformId?: string;
  /**
   * When true, also record the sent text into the OWNING agent's inbound.db as
   * a `kind: 'delivered'`, `trigger: 0` row — so the agent that owns this
   * channel sees, on its next turn, that this message was already delivered on
   * its behalf (and does not repeat it). Without this flag the send is
   * delivery-only and invisible to the agent's own conversation history.
   */
  record?: boolean;
}

function parseSendArgs(raw: Record<string, unknown>): SendArgs {
  // Accept both --folder and --group-folder; both --text and --message.
  const folder = (raw.folder ?? raw['group-folder'] ?? raw.group_folder) as unknown;
  const text = (raw.text ?? raw.message) as unknown;
  const channelType = (raw['channel-type'] ?? raw.channel_type ?? raw.channelType) as unknown;
  const platformId = (raw['platform-id'] ?? raw.platform_id ?? raw.platformId) as unknown;
  // Bare `--record` parses to boolean true (client.ts); also accept the
  // string forms a non-CLI caller might pass.
  const rawRecord = raw.record ?? raw['record-inbound'] ?? raw.seedHistory;
  const record = rawRecord === true || rawRecord === 'true' || rawRecord === '' || rawRecord === '1';

  if (typeof folder !== 'string' || folder.trim() === '') {
    throw new Error('--folder is required (the group folder, e.g. pan-parent-abc123)');
  }
  if (typeof text !== 'string' || text === '') {
    throw new Error('--text is required (the verbatim message to deliver)');
  }
  return {
    folder: folder.trim(),
    text,
    channelType: typeof channelType === 'string' ? channelType : undefined,
    platformId: typeof platformId === 'string' ? platformId : undefined,
    record,
  };
}

register({
  name: 'messages-send',
  description:
    'Send a verbatim, host-authored message to a group folder’s channel. Resolves folder → agent group → wired messaging group and delivers the text as-is (NOT through the agent). Args: --folder <group-folder> --text <message> [--channel-type <type> --platform-id <id> to disambiguate when a folder is wired to multiple channels] [--record to also seed the text into the owning agent’s inbound history as a kind:delivered, trigger:0 row so the agent knows it was sent on its behalf].',
  access: 'open',
  resource: 'messages',
  parseArgs: parseSendArgs,
  handler: async (args: SendArgs) => {
    const { folder, text, channelType, platformId, record } = args;

    const agentGroup = getAgentGroupByFolder(folder);
    if (!agentGroup) {
      throw new Error(`no agent group for folder "${folder}"`);
    }

    const wired = getMessagingGroupsByAgentGroup(agentGroup.id);
    if (wired.length === 0) {
      throw new Error(`folder "${folder}" has no wired messaging group to deliver to`);
    }

    // Disambiguate when the folder is wired to more than one channel.
    let target = wired[0];
    if (wired.length > 1 || channelType || platformId) {
      const matches = wired.filter(
        (mg) =>
          (channelType === undefined || mg.channel_type === channelType) &&
          (platformId === undefined || mg.platform_id === platformId),
      );
      if (matches.length === 0) {
        throw new Error(
          `folder "${folder}" has no wired channel matching channel_type=${channelType ?? '*'} platform_id=${platformId ?? '*'}`,
        );
      }
      if (matches.length > 1) {
        const options = matches.map((mg) => `${mg.channel_type}:${mg.platform_id}`).join(', ');
        throw new Error(
          `folder "${folder}" is wired to multiple channels (${options}); pass --channel-type and --platform-id to pick one`,
        );
      }
      target = matches[0];
    }

    // Resolve using the wiring's ACTUAL configured session_mode so we land on
    // the SAME session NanoClaw's own delivery path uses. Pan wires family
    // groups as session_mode='agent-shared'; forcing 'shared' here would take
    // resolveSession's findSessionForAgent(session_mode='shared') branch instead
    // of findSessionByAgentGroup, miss the live agent-shared session, and CREATE
    // A SECOND active session for the agent group — tripping pan-events-watcher's
    // single-active-session tripwire and violating the single-owner turn-store
    // invariant. Fall back to 'shared' only when there is no wiring row.
    const wiring = getMessagingGroupAgentByPair(target.id, agentGroup.id);
    const sessionMode = (wiring?.session_mode ?? 'shared') as 'shared' | 'per-thread' | 'agent-shared';
    const { session } = resolveSession(agentGroup.id, target.id, null, sessionMode);

    const messageId = `host-send-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const content = JSON.stringify({ text });
    writeOutboundDirect(agentGroup.id, session.id, {
      id: messageId,
      kind: 'agent',
      platformId: target.platform_id,
      channelType: target.channel_type,
      threadId: null,
      content,
    });

    // --record: mirror the delivered text into the OWNING agent's inbound.db so
    // it appears in that agent's own conversation history. trigger:0 means the
    // row is accumulated context only — it does NOT wake the container; it rides
    // along on the next real turn (see getPendingMessages / countDueMessages).
    // kind:'delivered' renders via the formatter as a "you already delivered
    // this" block, so the agent neither re-sends it (teen cold-open) nor forgets
    // it (parent escalation). The inbound row id is derived from the outbound id
    // for traceability; they live in separate DBs so there is no collision.
    //
    // CHANNEL-FIRST: delivery (writeOutboundDirect, above) already happened. The
    // history seed is best-effort — if it throws, we must NOT fail the command,
    // or a caller that retries on non-zero exit (e.g. Pan's escalation-watcher)
    // would RE-DELIVER an already-sent message (double-alert on the safety path).
    // So a seed failure is logged loudly and reported via `recorded:false`, never
    // raised. The flag's whole purpose (agent visibility) degrades gracefully to
    // the pre-flag behavior (delivery-only) on seed failure.
    let recordedMessageId: string | null = null;
    let recorded = false;
    if (record) {
      recordedMessageId = `${messageId}-rec`;
      try {
        writeSessionMessage(agentGroup.id, session.id, {
          id: recordedMessageId,
          kind: 'delivered',
          timestamp: new Date().toISOString(),
          platformId: target.platform_id,
          channelType: target.channel_type,
          threadId: null,
          content,
          trigger: 0,
        });
        recorded = true;
      } catch (err) {
        recordedMessageId = null;
        log.error('messages send --record: history seed failed (delivery already succeeded)', {
          folder,
          agentGroupId: agentGroup.id,
          sessionId: session.id,
          messageId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      delivered: true,
      recorded,
      folder,
      agentGroupId: agentGroup.id,
      messagingGroupId: target.id,
      channelType: target.channel_type,
      platformId: target.platform_id,
      sessionId: session.id,
      messageId,
      recordedMessageId,
    };
  },
});
