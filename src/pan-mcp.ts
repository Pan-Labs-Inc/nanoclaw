/**
 * Authenticated Pan control MCP endpoint.
 *
 * This is intentionally narrow: it exposes only the NanoClaw operations that
 * Pantalaimon needs for Pan-owned SMS enrollment. It speaks JSON-RPC-shaped MCP
 * `tools/list` and `tools/call` over POST /webhook/pan-mcp so operators do not
 * need SSH access to read/write SMS opt-in state or wire SMS phone DMs.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { getAgentGroupByFolder, createAgentGroup } from './db/agent-groups.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupByPlatform,
  getMessagingGroupAgentByPair,
} from './db/messaging-groups.js';
import { isValidGroupFolder } from './group-folder.js';
import { initGroupFilesystem } from './group-init.js';
import { namespacedPlatformId } from './platform-id.js';
import { resolveSession, writeSessionMessage } from './session-manager.js';
import { registerWebhookHandler } from './webhook-server.js';

const ENDPOINT_NAME = 'pan-mcp';
const CHANNEL_SMS = 'sms';
const SMS_OPT_IN_FILE = '.sms-opt-in';
const GROUP_ENROLLMENT_FILE = '.pan-enrollment';
const SMS_OPT_OUT_STORE_FILE = 'sms-opt-outs.json';
const OPT_IN_FILE_MODE = 0o600;
const E164_PHONE_RE = /^\+[1-9]\d{7,14}$/;
const FAMILY_ID_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
const GROUP_NAME_RE = /^pan-(teen|parent)-([a-z0-9][a-z0-9-]*[a-z0-9])$/;

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

type ToolHandler = (args: Record<string, unknown>) => unknown | Promise<unknown>;

const toolHandlers: Record<string, ToolHandler> = {
  pan_sms_read_enrollment: readEnrollmentTool,
  pan_sms_resolve_phone: resolvePhoneTool,
  pan_sms_read_opt_in: readOptInTool,
  pan_sms_record_opt_in: recordOptInTool,
  pan_sms_get_control_event: getControlEventTool,
  pan_sms_register: registerSmsTool,
  pan_put_group: putGroupTool,
  pan_write_parent_mount: writeParentMountTool,
  pan_write_shared_base: writeSharedBaseTool,
};

const toolDescriptions: Record<string, string> = {
  pan_sms_read_enrollment: 'Read a Pan family .pan-enrollment manifest from NanoClaw groups/.',
  pan_sms_resolve_phone: 'Resolve and validate a teen/parent SMS phone from enrollment or caller input.',
  pan_sms_read_opt_in: 'Read a Pan family .sms-opt-in confirmation record.',
  pan_sms_record_opt_in: 'Write a teen/parent START/YES SMS opt-in confirmation.',
  pan_sms_get_control_event: 'Read the latest NanoClaw SMS STOP/START/HELP control event for a phone.',
  pan_sms_register: 'Wire an SMS phone number as a NanoClaw DM for a Pan family group.',
  pan_put_group: 'Atomically create or replace one Pan-owned NanoClaw group directory.',
  pan_write_parent_mount: 'Write the parent group pan/ mount-point and container.json for a Pan family.',
  pan_write_shared_base: 'Compose Pan global prompt content into container/CLAUDE.md.',
};

export function createPanMcpHandler({ token = process.env.NANOCLAW_PAN_MCP_TOKEN } = {}) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'POST') return textResponse('Not found', 404);
    if (!token) return textResponse('Pan MCP endpoint is disabled', 404);
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
          serverInfo: { name: 'nanoclaw-pan-mcp', version: '1.0.0' },
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
        if (!handler) throw new Error(`Unknown Pan MCP tool: ${name}`);
        const payload = await handler(args);
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

function readEnrollmentTool(args: Record<string, unknown>) {
  const fid = familyIdArg(args);
  const { raw, enrollment } = readFamilyEnrollment(fid);
  return { fid, raw, enrollment };
}

function resolvePhoneTool(args: Record<string, unknown>) {
  const fid = familyIdArg(args);
  const persona = personaArg(args);
  const passedPhone = optionalStringArg(args, 'phone');
  const { enrollment } = readFamilyEnrollment(fid);
  const phone = passedPhone || String(enrollment[`${persona.toUpperCase()}_PHONE`] || '').trim();
  assertPhone(phone);
  return { fid, persona, phone, enrollment };
}

function readOptInTool(args: Record<string, unknown>) {
  const fid = familyIdArg(args);
  const raw = readOptInRaw(fid);
  return { fid, raw, record: parseKeyValue(raw) };
}

function recordOptInTool(args: Record<string, unknown>) {
  const fid = familyIdArg(args);
  const persona = personaArg(args);
  const phone = stringArg(args, 'phone');
  assertPhone(phone);
  const confirmedBy = optionalStringArg(args, 'confirmedBy') || 'operator';
  const raw = renderOptInRecord(readOptInRaw(fid), {
    persona,
    phone,
    confirmedBy,
  });
  const file = optInPath(fid);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, raw, OPT_IN_FILE_MODE);
  return { fid, persona, phone, raw, record: parseKeyValue(raw) };
}

function getControlEventTool(args: Record<string, unknown>) {
  const phone = stringArg(args, 'phone');
  assertPhone(phone);
  const store = readSmsControlStore();
  return { phone, event: store.controlEvents?.[phone] ?? null };
}

function registerSmsTool(args: Record<string, unknown>) {
  const fid = familyIdArg(args);
  const persona = personaArg(args);
  const phone = stringArg(args, 'phone');
  assertPhone(phone);
  const folder = `pan-${persona}-${fid}`;
  if (!isValidGroupFolder(folder)) throw new Error(`Invalid Pan group folder: ${folder}`);

  const assistantName = optionalStringArg(args, 'assistantName') || 'Pan';
  const name = optionalStringArg(args, 'name') || `Pan ${capitalize(persona)} ${fid}`;
  const platformId = namespacedPlatformId(CHANNEL_SMS, phone);
  const now = new Date().toISOString();

  let agentGroup = getAgentGroupByFolder(folder);
  if (!agentGroup) {
    createAgentGroup({
      id: generateId('ag'),
      name: assistantName,
      folder,
      agent_provider: null,
      created_at: now,
    });
    agentGroup = getAgentGroupByFolder(folder);
    if (!agentGroup) throw new Error(`Could not create agent group for ${folder}`);
  }
  initGroupFilesystem(agentGroup);

  let messagingGroup = getMessagingGroupByPlatform(CHANNEL_SMS, platformId);
  if (!messagingGroup) {
    createMessagingGroup({
      id: generateId('mg'),
      channel_type: CHANNEL_SMS,
      platform_id: platformId,
      name,
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: now,
    });
    messagingGroup = getMessagingGroupByPlatform(CHANNEL_SMS, platformId);
    if (!messagingGroup) throw new Error(`Could not create SMS messaging group for ${phone}`);
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

  if (newlyWired) {
    const { session } = resolveSession(agentGroup.id, messagingGroup.id, null, 'shared');
    writeSessionMessage(agentGroup.id, session.id, {
      id: generateId('onboard'),
      kind: 'task',
      timestamp: now,
      platformId,
      channelType: CHANNEL_SMS,
      content: JSON.stringify({
        prompt: 'A new sms channel has been connected. Run /welcome to introduce yourself to the user.',
      }),
    });
  }

  return {
    fid,
    persona,
    folder,
    phone,
    platformId,
    agentGroupId: agentGroup.id,
    messagingGroupId: messagingGroup.id,
    newlyWired,
  };
}

function putGroupTool(args: Record<string, unknown>) {
  const groupName = stringArg(args, 'groupName');
  assertGroupName(groupName);
  const files = arrayArg(args, 'files');
  const force = booleanArg(args, 'force', false);
  const target = path.join(GROUPS_DIR, groupName);

  if (fs.existsSync(target) && !force) {
    throw new Error(`Group '${groupName}' already exists. Use --force to replace it.`);
  }

  fs.mkdirSync(GROUPS_DIR, { recursive: true });
  const staging = path.join(GROUPS_DIR, `.pan-staging-${groupName}-${Date.now()}`);
  try {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    for (const entry of files) {
      if (!entry || typeof entry !== 'object') throw new Error('pan_put_group files entries must be objects');
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

function writeParentMountTool(args: Record<string, unknown>) {
  const fid = familyIdArg(args);
  const parentDir = groupPath(`pan-parent-${fid}`);
  const teenDir = groupPath(`pan-teen-${fid}`);
  if (!fs.existsSync(parentDir)) throw new Error(`Parent group for '${fid}' does not exist`);
  if (!fs.existsSync(teenDir)) throw new Error(`Teen group for '${fid}' does not exist`);
  fs.mkdirSync(path.join(parentDir, 'pan'), { recursive: true });
  const containerConfig = `${JSON.stringify(
    {
      additionalMounts: [
        {
          hostPath: path.join(teenDir, 'pan'),
          containerPath: 'pan',
          readonly: true,
        },
      ],
    },
    null,
    2,
  )}\n`;
  fs.writeFileSync(path.join(parentDir, 'container.json'), containerConfig, 'utf8');
  return { fid, parentGroup: `pan-parent-${fid}`, teenGroup: `pan-teen-${fid}` };
}

function writeSharedBaseTool(args: Record<string, unknown>) {
  const marker = stringArg(args, 'marker');
  const globalContent = stringArg(args, 'globalContent');
  const dst = path.join(process.cwd(), 'container', 'CLAUDE.md');
  const current = fs.existsSync(dst) ? fs.readFileSync(dst, 'utf8') : '';
  const markerAt = current.indexOf(marker);
  const upstreamBase = markerAt === -1 ? current : current.slice(0, markerAt);
  const next = `${upstreamBase.trimEnd()}\n\n${marker}\n\n${globalContent.trimEnd()}\n`;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, next, 'utf8');
  return { path: 'container/CLAUDE.md', bytes: Buffer.byteLength(next) };
}

function readFamilyEnrollment(fid: string) {
  const candidates = [
    path.join(groupPath(`pan-parent-${fid}`), GROUP_ENROLLMENT_FILE),
    path.join(groupPath(`pan-teen-${fid}`), GROUP_ENROLLMENT_FILE),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const raw = fs.readFileSync(file, 'utf8');
    if (raw.trim()) return { raw, enrollment: parseKeyValue(raw) };
  }
  throw new Error(`Family '${fid}' has no ${GROUP_ENROLLMENT_FILE} in NanoClaw groups/`);
}

function optInPath(fid: string): string {
  return path.join(groupPath(`pan-parent-${fid}`), SMS_OPT_IN_FILE);
}

function readOptInRaw(fid: string): string {
  const parent = optInPath(fid);
  const teen = path.join(groupPath(`pan-teen-${fid}`), SMS_OPT_IN_FILE);
  if (fs.existsSync(parent)) return fs.readFileSync(parent, 'utf8');
  if (fs.existsSync(teen)) return fs.readFileSync(teen, 'utf8');
  return '';
}

function readSmsControlStore(): { controlEvents?: Record<string, unknown> } {
  const storePath = path.join(DATA_DIR, SMS_OPT_OUT_STORE_FILE);
  if (!fs.existsSync(storePath)) return { controlEvents: {} };
  const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8')) as { controlEvents?: Record<string, unknown> };
  if (!parsed || typeof parsed !== 'object')
    throw new Error(`SMS control store ${storePath} did not contain an object`);
  return parsed;
}

function renderOptInRecord(
  existingRaw: string,
  { persona, phone, confirmedBy }: { persona: 'teen' | 'parent'; phone: string; confirmedBy: string },
): string {
  const prefix = persona.toUpperCase();
  const record = parseKeyValue(existingRaw);
  record[`${prefix}_SMS_OPT_IN`] = 'confirmed';
  record[`${prefix}_SMS_PHONE`] = phone.trim();
  record[`${prefix}_SMS_OPT_IN_AT`] = new Date().toISOString();
  record[`${prefix}_SMS_OPT_IN_BY`] = confirmedBy || 'operator';

  const orderedKeys = [
    'PARENT_SMS_OPT_IN',
    'PARENT_SMS_PHONE',
    'PARENT_SMS_OPT_IN_AT',
    'PARENT_SMS_OPT_IN_BY',
    'TEEN_SMS_OPT_IN',
    'TEEN_SMS_PHONE',
    'TEEN_SMS_OPT_IN_AT',
    'TEEN_SMS_OPT_IN_BY',
  ];
  const emitted = new Set<string>();
  const lines = ['# SMS opt-in confirmations. Generated by NanoClaw Pan MCP.'];
  for (const key of orderedKeys) {
    if (record[key]) {
      lines.push(`${key}=${record[key]}`);
      emitted.add(key);
    }
  }
  for (const key of Object.keys(record).sort()) {
    if (!emitted.has(key) && record[key]) lines.push(`${key}=${record[key]}`);
  }
  return `${lines.join('\n')}\n`;
}

function parseKeyValue(raw = ''): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    result[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return result;
}

function writeFileAtomic(file: string, content: string, mode: number): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content, { encoding: 'utf8', mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
  fs.chmodSync(file, mode);
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

function familyIdArg(args: Record<string, unknown>): string {
  const fid = stringArg(args, 'fid');
  if (!FAMILY_ID_RE.test(fid)) throw new Error('fid is invalid');
  return fid;
}

function personaArg(args: Record<string, unknown>): 'teen' | 'parent' {
  const persona = stringArg(args, 'persona').toLowerCase();
  if (persona !== 'teen' && persona !== 'parent') throw new Error('persona must be teen or parent');
  return persona;
}

function assertPhone(phone: string): void {
  if (!E164_PHONE_RE.test(phone.trim())) throw new Error('phone must be E.164, like +15105551234');
}

function assertGroupName(groupName: string): void {
  if (!GROUP_NAME_RE.test(groupName)) throw new Error('groupName must be pan-teen-<fid> or pan-parent-<fid>');
}

function groupPath(groupName: string): string {
  assertGroupName(groupName);
  return path.join(GROUPS_DIR, groupName);
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

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

if (process.env.NANOCLAW_PAN_MCP_TOKEN) {
  registerWebhookHandler(ENDPOINT_NAME, createPanMcpHandler());
}
