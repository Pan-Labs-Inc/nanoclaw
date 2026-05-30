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
import {
  getMessagingGroupsByAgentGroup,
  getMessagingGroupAgentByPair,
} from '../../db/messaging-groups.js';
import { resolveSession, writeOutboundDirect } from '../../session-manager.js';
import { register } from '../registry.js';

interface SendArgs {
  folder: string;
  text: string;
  channelType?: string;
  platformId?: string;
}

function parseSendArgs(raw: Record<string, unknown>): SendArgs {
  // Accept both --folder and --group-folder; both --text and --message.
  const folder = (raw.folder ?? raw['group-folder'] ?? raw.group_folder) as unknown;
  const text = (raw.text ?? raw.message) as unknown;
  const channelType = (raw['channel-type'] ?? raw.channel_type ?? raw.channelType) as unknown;
  const platformId = (raw['platform-id'] ?? raw.platform_id ?? raw.platformId) as unknown;

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
  };
}

register({
  name: 'messages-send',
  description:
    'Send a verbatim, host-authored message to a group folder’s channel. Resolves folder → agent group → wired messaging group and delivers the text as-is (NOT through the agent). Args: --folder <group-folder> --text <message> [--channel-type <type> --platform-id <id> to disambiguate when a folder is wired to multiple channels].',
  access: 'open',
  resource: 'messages',
  parseArgs: parseSendArgs,
  handler: async (args: SendArgs) => {
    const { folder, text, channelType, platformId } = args;

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
    const sessionMode = (wiring?.session_mode ?? 'shared') as
      | 'shared'
      | 'per-thread'
      | 'agent-shared';
    const { session } = resolveSession(agentGroup.id, target.id, null, sessionMode);

    const messageId = `host-send-${Date.now()}-${randomUUID().slice(0, 8)}`;
    writeOutboundDirect(agentGroup.id, session.id, {
      id: messageId,
      kind: 'agent',
      platformId: target.platform_id,
      channelType: target.channel_type,
      threadId: null,
      content: JSON.stringify({ text }),
    });

    return {
      delivered: true,
      folder,
      agentGroupId: agentGroup.id,
      messagingGroupId: target.id,
      channelType: target.channel_type,
      platformId: target.platform_id,
      sessionId: session.id,
      messageId,
    };
  },
});
