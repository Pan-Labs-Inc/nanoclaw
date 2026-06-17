/**
 * Authenticated admin control MCP endpoint.
 *
 * Exposes generic NanoClaw operations — group management, channel registration,
 * mount config, shared base — as MCP tools over POST /webhook/admin-mcp.
 * Clients supply all domain knowledge; this endpoint is free of client-specific
 * semantics.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { createAgentGroup, getAgentGroupByFolder } from './db/agent-groups.js';
import { ensureContainerConfig, updateContainerConfigJson } from './db/container-configs.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from './db/messaging-groups.js';
import { isValidGroupFolder } from './group-folder.js';
import { initGroupFilesystem } from './group-init.js';
import { log } from './log.js';
import { namespacedPlatformId } from './platform-id.js';
import { redactPlatformId } from './platform-redaction.js';
import { resolveSession, writeSessionMessage } from './session-manager.js';
import { registerWebhookHandler } from './webhook-server.js';
import { readDmRegistrations, writeDmRegistrations } from './dm-registrations.js';

const ENDPOINT_NAME = 'admin-mcp';
const SMS_OPT_OUT_STORE_FILE = 'sms-opt-outs.json';

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

type ToolHandler = (args: Record<string, unknown>) => unknown | Promise<unknown>;

const toolHandlers: Record<string, ToolHandler> = {
  group_put: groupPutTool,
  group_file_get: groupFileGetTool,
  group_file_put: groupFilePutTool,
  group_mount_set: groupMountSetTool,
  dm_register: dmRegisterTool,
  shared_base_write: sharedBaseWriteTool,
  dm_status: dmStatusTool,
};

const toolDescriptions: Record<string, string> = {
  group_put: 'Atomically create or replace a NanoClaw group directory.',
  group_file_get: 'Read a file from a NanoClaw group directory, returning base64-encoded content.',
  group_file_put: 'Atomically write a file into a NanoClaw group directory.',
  group_mount_set:
    'Write the additional-mounts container config for a group. Each mount entry may set sourcePath (relative, no traversal) to mount a subdirectory of the source group instead of the whole group dir.',
  dm_register: 'Wire a channel address as a NanoClaw direct-message group.',
  shared_base_write: 'Compose content into container/CLAUDE.md at a marker point.',
  dm_status: 'Read the activation state and last control event for a registered DM address.',
};

const GROUP_SCOPED_VERBS = new Set(['group_put', 'group_file_get', 'group_file_put', 'group_mount_set', 'dm_register']);

function assertGroupPrefixAllowed(
  name: string,
  args: Record<string, unknown>,
  groupPrefixes: string | undefined,
): void {
  if (!groupPrefixes || !GROUP_SCOPED_VERBS.has(name)) return;
  const prefixes = groupPrefixes
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (prefixes.length === 0) return;
  const groupName = typeof args.groupName === 'string' ? args.groupName : '';
  if (!prefixes.some((p) => groupName.startsWith(p))) {
    throw new Error(`Group '${groupName}' is not in the allowed prefix scope`);
  }
}

export function createAdminMcpHandler({
  token = process.env.NANOCLAW_ADMIN_MCP_TOKEN,
  groupPrefixes = process.env.NANOCLAW_ADMIN_MCP_GROUP_PREFIXES,
} = {}) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'POST') return textResponse('Not found', 404);
    if (!token) return textResponse('Admin MCP endpoint is disabled', 404);
    if (!authorized(request, token)) return textResponse('Forbidden', 403);

    let rpc: JsonRpcRequest;
    try {
      rpc = (await request.json()) as JsonRpcRequest;
    } catch {
      return jsonRpc(null, null, { code: -32700, message: 'Parse error' });
    }

    try {
      if (rpc.method === 'initialize') {
        return jsonRpc(rpc.id, {
          protocolVersion: '2024-11-05',
          serverInfo: { name: 'nanoclaw-admin-mcp', version: '1.0.0' },
          capabilities: { tools: {} },
        });
      }
      if (rpc.method === 'notifications/initialized') {
        return new Response(null, { status: 202 });
      }
      if (rpc.method === 'tools/list') {
        return jsonRpc(rpc.id, {
          tools: Object.keys(toolHandlers).map((name) => ({
            name,
            description: toolDescriptions[name],
            inputSchema: { type: 'object' },
          })),
        });
      }
      if (rpc.method === 'tools/call') {
        const params = rpc.params ?? {};
        const name = stringArg(params, 'name');
        const args = objectArg(params, 'arguments', {});
        const handler = toolHandlers[name];
        if (!handler) throw new Error(`Unknown admin MCP tool: ${name}`);
        const target = auditTarget(name, args);
        let payload: unknown;
        try {
          assertGroupPrefixAllowed(name, args, groupPrefixes);
          payload = await handler(args);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.info('admin-mcp audit', { tool: name, target, outcome: `error: ${msg}` });
          throw err;
        }
        log.info('admin-mcp audit', { tool: name, target, outcome: 'ok' });
        return jsonRpc(rpc.id, {
          content: [{ type: 'text', text: JSON.stringify(payload) }],
          structuredContent: payload,
        });
      }
      return jsonRpc(rpc.id, null, { code: -32601, message: `Method not found: ${rpc.method || ''}` });
    } catch (err) {
      return jsonRpc(rpc.id, null, {
        code: -32000,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };
}

function groupPutTool(args: Record<string, unknown>) {
  const groupName = stringArg(args, 'groupName');
  if (!isValidGroupFolder(groupName)) throw new Error(`Invalid group folder name: ${groupName}`);
  const files = arrayArg(args, 'files');
  const force = booleanArg(args, 'force', false);
  const target = path.join(GROUPS_DIR, groupName);

  if (fs.existsSync(target) && !force) {
    throw new Error(`Group '${groupName}' already exists. Use force to replace it.`);
  }

  fs.mkdirSync(GROUPS_DIR, { recursive: true });
  const staging = path.join(GROUPS_DIR, `.admin-staging-${groupName}-${Date.now()}`);
  try {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    for (const entry of files) {
      if (!entry || typeof entry !== 'object') throw new Error('group_put files entries must be objects');
      const relPath = safeRelativePath(stringArg(entry as Record<string, unknown>, 'path'));
      const contentBase64 = stringArg(entry as Record<string, unknown>, 'contentBase64');
      const mode = numberArg(entry as Record<string, unknown>, 'mode', 0o644);
      const dst = path.join(staging, relPath);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, Buffer.from(contentBase64, 'base64'), { mode });
      fs.chmodSync(dst, mode);
    }
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(staging, target);
    return { groupName, path: target, files: files.length };
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw err;
  }
}

function groupFileGetTool(args: Record<string, unknown>) {
  const groupName = stringArg(args, 'groupName');
  if (!isValidGroupFolder(groupName)) throw new Error(`Invalid group folder name: ${groupName}`);
  const relPath = safeRelativePath(stringArg(args, 'path'));
  const file = path.join(GROUPS_DIR, groupName, relPath);
  if (!fs.existsSync(file)) throw new Error(`File not found: ${relPath} in group ${groupName}`);
  const content = fs.readFileSync(file);
  return {
    groupName,
    path: relPath,
    contentBase64: content.toString('base64'),
    size: content.length,
  };
}

function groupFilePutTool(args: Record<string, unknown>) {
  const groupName = stringArg(args, 'groupName');
  if (!isValidGroupFolder(groupName)) throw new Error(`Invalid group folder name: ${groupName}`);
  const relPath = safeRelativePath(stringArg(args, 'path'));
  const contentBase64 = stringArg(args, 'contentBase64');
  const mode = numberArg(args, 'mode', 0o644);
  const file = path.join(GROUPS_DIR, groupName, relPath);
  const content = Buffer.from(contentBase64, 'base64');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
  fs.chmodSync(file, mode);
  return { groupName, path: relPath, bytes: content.length };
}

function groupMountSetTool(args: Record<string, unknown>) {
  const groupName = stringArg(args, 'groupName');
  if (!isValidGroupFolder(groupName)) throw new Error(`Invalid group folder name: ${groupName}`);
  const mounts = arrayArg(args, 'mounts');
  const groupDir = path.join(GROUPS_DIR, groupName);
  if (!fs.existsSync(groupDir)) throw new Error(`Group '${groupName}' does not exist`);

  let agentGroup = getAgentGroupByFolder(groupName);
  if (!agentGroup) {
    createAgentGroup({
      id: generateId('ag'),
      name: groupName,
      folder: groupName,
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    agentGroup = getAgentGroupByFolder(groupName);
    if (!agentGroup) throw new Error(`Could not create agent group for '${groupName}'`);
  }

  const additionalMounts = mounts.map((m) => {
    if (!m || typeof m !== 'object') throw new Error('mounts entries must be objects');
    const mount = m as Record<string, unknown>;
    const sourceGroup = stringArg(mount, 'sourceGroup');
    if (!isValidGroupFolder(sourceGroup)) throw new Error(`Invalid source group folder: ${sourceGroup}`);
    const sourcePath = optionalStringArg(mount, 'sourcePath');
    const containerPath = stringArg(mount, 'containerPath');
    const readonly = booleanArg(mount, 'readonly', true);
    return {
      hostPath: sourcePath
        ? path.join(GROUPS_DIR, sourceGroup, safeRelativePath(sourcePath))
        : path.join(GROUPS_DIR, sourceGroup),
      containerPath,
      readonly,
    };
  });

  ensureContainerConfig(agentGroup.id);
  updateContainerConfigJson(agentGroup.id, 'additional_mounts', additionalMounts);
  return { groupName, mounts: mounts.length };
}

function dmRegisterTool(args: Record<string, unknown>) {
  const channel = stringArg(args, 'channel');
  const address = stringArg(args, 'address');
  const groupName = stringArg(args, 'groupName');
  if (!isValidGroupFolder(groupName)) throw new Error(`Invalid group folder name: ${groupName}`);
  const displayName = optionalStringArg(args, 'displayName');
  const requireOptIn = booleanArg(args, 'require_opt_in', false);

  const platformId = namespacedPlatformId(channel, address);
  const now = new Date().toISOString();

  let agentGroup = getAgentGroupByFolder(groupName);
  if (!agentGroup) {
    createAgentGroup({
      id: generateId('ag'),
      name: displayName || groupName,
      folder: groupName,
      agent_provider: null,
      created_at: now,
    });
    agentGroup = getAgentGroupByFolder(groupName);
    if (!agentGroup) throw new Error(`Could not create agent group for ${groupName}`);
  }
  // initGroupFilesystem ensures container_configs row exists (fixes ncl-groups-create gap)
  initGroupFilesystem(agentGroup);

  let messagingGroup = getMessagingGroupByPlatform(channel, platformId);
  if (!messagingGroup) {
    createMessagingGroup({
      id: generateId('mg'),
      channel_type: channel,
      platform_id: platformId,
      name: displayName || address,
      is_group: 0,
      // Born-suppressed DM/start-token registrations are 1:1 channels: the only
      // possible sender is the user who activates by tapping the deep link (or
      // texting the keyword). 'strict' would drop that user as not_member after
      // activation (activation rebinds platform_id but never grants membership),
      // so the channel goes silent after the welcome. 'public' matches Pan's
      // own register default and lets the activating user through.
      unknown_sender_policy: 'public',
      created_at: now,
    });
    messagingGroup = getMessagingGroupByPlatform(channel, platformId);
    if (!messagingGroup) throw new Error(`Could not create messaging group for ${channel}:${address}`);
  }

  let newlyWired = false;
  if (!getMessagingGroupAgentByPair(messagingGroup.id, agentGroup.id)) {
    newlyWired = true;
    createMessagingGroupAgent({
      id: generateId('mga'),
      messaging_group_id: messagingGroup.id,
      agent_group_id: agentGroup.id,
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now,
    });
  }

  // Persist registration metadata for dm_status and the N6 freshness state machine
  const regs = readDmRegistrations();
  regs[platformId] = { groupName, channel, address, registeredAt: now, requireOptIn };
  writeDmRegistrations(regs);

  if (newlyWired) {
    const { session } = resolveSession(agentGroup.id, messagingGroup.id, null, 'shared');
    writeSessionMessage(agentGroup.id, session.id, {
      id: generateId('onboard'),
      kind: 'task',
      timestamp: now,
      platformId,
      channelType: channel,
      content: JSON.stringify({
        prompt: 'A new channel has been connected. Run /welcome to introduce yourself to the user.',
      }),
    });
  }

  return {
    channel,
    address,
    platformId,
    groupName,
    agentGroupId: agentGroup.id,
    messagingGroupId: messagingGroup.id,
    newlyWired,
    requireOptIn,
    registeredAt: now,
  };
}

function sharedBaseWriteTool(args: Record<string, unknown>) {
  const marker = stringArg(args, 'marker');
  const content = stringArg(args, 'content');
  const dst = path.join(process.cwd(), 'container', 'CLAUDE.md');
  const current = fs.existsSync(dst) ? fs.readFileSync(dst, 'utf8') : '';
  const markerAt = current.indexOf(marker);
  const upstreamBase = markerAt === -1 ? current : current.slice(0, markerAt);
  const next = `${upstreamBase.trimEnd()}\n\n${marker}\n\n${content.trimEnd()}\n`;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, next, 'utf8');
  return { path: 'container/CLAUDE.md', bytes: Buffer.byteLength(next) };
}

function dmStatusTool(args: Record<string, unknown>) {
  const channel = stringArg(args, 'channel');
  const address = stringArg(args, 'address');
  const platformId = namespacedPlatformId(channel, address);

  const regs = readDmRegistrations();
  const reg = regs[platformId];

  // Born-suppressed Telegram registrations rebind the messaging group from the
  // start-token placeholder to the real chat platformId at activation — follow
  // the binding so status-by-token keeps working after the rebind.
  const mgPlatformId = reg?.boundPlatformId ?? platformId;
  const messagingGroup = getMessagingGroupByPlatform(channel, mgPlatformId);
  if (!messagingGroup) return { registered: false, activationState: null, lastControlEvent: null };

  let lastControlEvent: { keyword: string; at: string } | null = null;
  let activationState: 'pending' | 'active' | 'suppressed' = 'active';

  if (channel === 'sms') {
    const store = readSmsOptOutStore();
    const key = address.trim();
    const event = store.controlEvents?.[key];
    if (event) {
      lastControlEvent = { keyword: event.keyword, at: event.at ?? event.receivedAt };
    }
    if (store.optedOut?.[key]) {
      activationState = 'suppressed';
    } else if (reg?.requireOptIn) {
      const hasActivatingEvent =
        event && event.action === 'start' && (event.at ?? event.receivedAt) > (reg.registeredAt ?? '');
      activationState = hasActivatingEvent ? 'active' : 'pending';
    }
  } else if (reg?.requireOptIn) {
    if (reg.activatedAt) {
      activationState = 'active';
      lastControlEvent = { keyword: 'start', at: reg.activatedAt };
    } else {
      activationState = 'pending';
    }
  }

  return { registered: true, activationState, lastControlEvent };
}

function readSmsOptOutStore(): {
  optedOut?: Record<string, { optedOutAt: string }>;
  controlEvents?: Record<string, { action: string; keyword: string; receivedAt: string; at?: string }>;
} {
  const storePath = path.join(DATA_DIR, SMS_OPT_OUT_STORE_FILE);
  if (!fs.existsSync(storePath)) return { optedOut: {}, controlEvents: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8')) as {
      optedOut?: Record<string, { optedOutAt: string }>;
      controlEvents?: Record<string, { action: string; keyword: string; receivedAt: string; at?: string }>;
    };
    if (!parsed || typeof parsed !== 'object') return { optedOut: {}, controlEvents: {} };
    return parsed;
  } catch {
    return { optedOut: {}, controlEvents: {} };
  }
}

function authorized(request: Request, expected: string): boolean {
  const header = request.headers.get('authorization') || '';
  const actual = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  if (!actual || actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

function jsonRpc(id: JsonRpcRequest['id'], result: unknown, error?: { code: number; message: string }): Response {
  return new Response(
    JSON.stringify(error ? { jsonrpc: '2.0', id: id ?? null, error } : { jsonrpc: '2.0', id: id ?? null, result }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain' } });
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} is required`);
  return value.trim();
}

function optionalStringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function objectArg(
  args: Record<string, unknown>,
  key: string,
  fallback: Record<string, unknown>,
): Record<string, unknown> {
  const value = args[key];
  if (value === undefined) return fallback;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${key} must be an object`);
  return value as Record<string, unknown>;
}

function arrayArg(args: Record<string, unknown>, key: string): unknown[] {
  const value = args[key];
  if (!Array.isArray(value)) throw new Error(`${key} must be an array`);
  return value;
}

function numberArg(args: Record<string, unknown>, key: string, fallback: number): number {
  const value = args[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0o777) {
    throw new Error(`${key} must be a file mode number`);
  }
  return value;
}

function booleanArg(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = args[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${key} must be boolean`);
  return value;
}

function safeRelativePath(relPath: string): string {
  if (path.isAbsolute(relPath) || relPath.includes('\0')) throw new Error('file path must be relative');
  const normalized = path.normalize(relPath);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) throw new Error('file path escapes group dir');
  return normalized;
}

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function auditTarget(name: string, args: Record<string, unknown>): string {
  if (name === 'dm_register' || name === 'dm_status') {
    const channel = typeof args.channel === 'string' ? args.channel : '';
    const address = typeof args.address === 'string' ? args.address : '';
    return `${channel}:${redactPlatformId(channel, address) ?? address}`;
  }
  if (typeof args.groupName === 'string' && args.groupName) return args.groupName;
  return name;
}

if (process.env.NANOCLAW_ADMIN_MCP_TOKEN) {
  registerWebhookHandler(ENDPOINT_NAME, createAdminMcpHandler());
}
