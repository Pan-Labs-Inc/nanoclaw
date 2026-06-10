import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DIR } = vi.hoisted(() => ({
  TEST_DIR: '/tmp/nanoclaw-admin-mcp-test',
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    DATA_DIR: `${TEST_DIR}/data`,
    GROUPS_DIR: `${TEST_DIR}/groups`,
  };
});

import { closeDb, initTestDb, runMigrations } from './db/index.js';
import { getContainerConfig } from './db/container-configs.js';
import { getAgentGroupByFolder } from './db/agent-groups.js';
import { materializeContainerJson } from './container-config.js';
import { createAdminMcpHandler } from './admin-mcp.js';

const TOKEN = 'admin-mcp-token-1234567890abcdef1234';

type McpBody = {
  result?: { content: Array<{ text: string }> };
  error?: { message: string };
};

async function callTool(
  handler: ReturnType<typeof createAdminMcpHandler>,
  name: string,
  args: Record<string, unknown>,
): Promise<Response> {
  return handler(
    new Request('http://localhost/webhook/admin-mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    }),
  );
}

async function toolResult(res: Response): Promise<Record<string, unknown>> {
  const body = (await res.json()) as McpBody;
  if (body.error) throw new Error(body.error.message);
  return JSON.parse(body.result!.content[0].text) as Record<string, unknown>;
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  runMigrations(initTestDb());
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('Admin MCP endpoint', () => {
  it('is disabled when no token is configured', async () => {
    const handler = createAdminMcpHandler({ token: '' });
    const res = await handler(
      new Request('http://localhost/webhook/admin-mcp', {
        method: 'POST',
        body: '{}',
      }),
    );

    expect(res.status).toBe(404);
  });

  it('rejects requests without the bearer token', async () => {
    const handler = createAdminMcpHandler({ token: TOKEN });
    const res = await handler(
      new Request('http://localhost/webhook/admin-mcp', {
        method: 'POST',
        body: '{}',
      }),
    );

    expect(res.status).toBe(403);
  });

  it('lists exactly the 7 generic tools via tools/list', async () => {
    const handler = createAdminMcpHandler({ token: TOKEN });
    const res = await handler(
      new Request('http://localhost/webhook/admin-mcp', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      }),
    );

    expect(res.status).toBe(200);
    const frame = (await res.json()) as { result: { tools: Array<{ name: string }> } };
    const names = frame.result.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'dm_register',
      'dm_status',
      'group_file_get',
      'group_file_put',
      'group_mount_set',
      'group_put',
      'shared_base_write',
    ]);
  });

  describe('group_put', () => {
    it('creates a group directory with files', async () => {
      const handler = createAdminMcpHandler({ token: TOKEN });
      const res = await callTool(handler, 'group_put', {
        groupName: 'testgroup',
        files: [{ path: 'CLAUDE.md', contentBase64: Buffer.from('hello').toString('base64'), mode: 0o644 }],
        force: false,
      });

      expect(res.status).toBe(200);
      const result = await toolResult(res);
      expect(result.groupName).toBe('testgroup');
      expect(result.files).toBe(1);
      expect(fs.existsSync(path.join(`${TEST_DIR}/groups`, 'testgroup', 'CLAUDE.md'))).toBe(true);
    });

    it('rejects path escape in files[].path', async () => {
      const handler = createAdminMcpHandler({ token: TOKEN });
      const res = await callTool(handler, 'group_put', {
        groupName: 'testgroup',
        files: [{ path: '../../etc/passwd', contentBase64: Buffer.from('x').toString('base64') }],
        force: false,
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as McpBody;
      expect(body.error).toBeDefined();
      expect(body.error!.message).toMatch(/escape/i);
    });

    it('force: false rejects existing group; force: true replaces it', async () => {
      const handler = createAdminMcpHandler({ token: TOKEN });
      // pre-create the directory so the group already exists
      const groupDir = path.join(`${TEST_DIR}/groups`, 'forcedgroup');
      fs.mkdirSync(groupDir, { recursive: true });

      const rejectRes = await callTool(handler, 'group_put', {
        groupName: 'forcedgroup',
        files: [],
        force: false,
      });
      expect(rejectRes.status).toBe(200);
      const rejectBody = (await rejectRes.json()) as McpBody;
      expect(rejectBody.error).toBeDefined();
      expect(rejectBody.error!.message).toMatch(/already exists/i);

      const forceRes = await callTool(handler, 'group_put', {
        groupName: 'forcedgroup',
        files: [{ path: 'CLAUDE.md', contentBase64: Buffer.from('replaced').toString('base64') }],
        force: true,
      });
      expect(forceRes.status).toBe(200);
      const forceResult = await toolResult(forceRes);
      expect(forceResult.groupName).toBe('forcedgroup');
      expect(forceResult.files).toBe(1);
    });
  });

  describe('group_file_get', () => {
    it('reads back a file written by group_put', async () => {
      const handler = createAdminMcpHandler({ token: TOKEN });
      const content = 'file content here';
      await callTool(handler, 'group_put', {
        groupName: 'testgroup',
        files: [{ path: 'notes.txt', contentBase64: Buffer.from(content).toString('base64') }],
        force: false,
      });

      const res = await callTool(handler, 'group_file_get', { groupName: 'testgroup', path: 'notes.txt' });

      expect(res.status).toBe(200);
      const result = await toolResult(res);
      expect(Buffer.from(result.contentBase64 as string, 'base64').toString()).toBe(content);
      expect(result.path).toBe('notes.txt');
    });
  });

  describe('group_file_put', () => {
    it('writes a file into an existing group', async () => {
      const handler = createAdminMcpHandler({ token: TOKEN });
      await callTool(handler, 'group_put', { groupName: 'testgroup', files: [], force: false });

      const content = 'new content';
      const res = await callTool(handler, 'group_file_put', {
        groupName: 'testgroup',
        path: 'added.txt',
        contentBase64: Buffer.from(content).toString('base64'),
      });

      expect(res.status).toBe(200);
      const result = await toolResult(res);
      expect(result.bytes).toBe(content.length);
      expect(result.path).toBe('added.txt');
      expect(fs.readFileSync(path.join(`${TEST_DIR}/groups`, 'testgroup', 'added.txt'), 'utf8')).toBe(content);
    });

    it('rejects path escape in path argument', async () => {
      const handler = createAdminMcpHandler({ token: TOKEN });
      await callTool(handler, 'group_put', { groupName: 'testgroup', files: [], force: false });

      const res = await callTool(handler, 'group_file_put', {
        groupName: 'testgroup',
        path: '../other/escape.txt',
        contentBase64: Buffer.from('x').toString('base64'),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as McpBody;
      expect(body.error).toBeDefined();
      expect(body.error!.message).toMatch(/escape/i);
    });
  });

  describe('group_mount_set', () => {
    it('writes additional_mounts to container_configs DB row', async () => {
      const handler = createAdminMcpHandler({ token: TOKEN });
      await callTool(handler, 'group_put', { groupName: 'destgroup', files: [], force: false });
      await callTool(handler, 'group_put', { groupName: 'srcgroup', files: [], force: false });

      const res = await callTool(handler, 'group_mount_set', {
        groupName: 'destgroup',
        mounts: [{ sourceGroup: 'srcgroup', containerPath: '/workspace/shared', readonly: true }],
      });

      expect(res.status).toBe(200);
      const result = await toolResult(res);
      expect(result.mounts).toBe(1);

      const agentGroup = getAgentGroupByFolder('destgroup');
      expect(agentGroup).toBeDefined();
      const row = getContainerConfig(agentGroup!.id);
      expect(row).toBeDefined();
      const mounts = JSON.parse(row!.additional_mounts) as Array<{
        containerPath: string;
        readonly: boolean;
      }>;
      expect(mounts[0].containerPath).toBe('/workspace/shared');
      expect(mounts[0].readonly).toBe(true);
    });

    it('mount written by group_mount_set appears in materializeContainerJson output', async () => {
      const handler = createAdminMcpHandler({ token: TOKEN });
      await callTool(handler, 'group_put', { groupName: 'mountdest', files: [], force: false });
      await callTool(handler, 'group_put', { groupName: 'mountsrc', files: [], force: false });

      const res = await callTool(handler, 'group_mount_set', {
        groupName: 'mountdest',
        mounts: [{ sourceGroup: 'mountsrc', containerPath: '/workspace/shared', readonly: true }],
      });
      expect(res.status).toBe(200);

      const agentGroup = getAgentGroupByFolder('mountdest');
      expect(agentGroup).toBeDefined();

      const config = materializeContainerJson(agentGroup!.id);
      const found = config.additionalMounts.find((m) => m.containerPath === '/workspace/shared');
      expect(found).toBeDefined();
      expect(found!.readonly).toBe(true);
      expect(found!.hostPath).toContain('mountsrc');
    });
  });

  describe('dm_register', () => {
    it('creates agent/messaging groups and returns registration fields', async () => {
      const handler = createAdminMcpHandler({ token: TOKEN });
      const res = await callTool(handler, 'dm_register', {
        channel: 'sms',
        address: '+15551234567',
        groupName: 'smsgroup',
        require_opt_in: false,
      });

      expect(res.status).toBe(200);
      const result = await toolResult(res);
      expect(result.channel).toBe('sms');
      expect(result.address).toBe('+15551234567');
      expect(result.groupName).toBe('smsgroup');
      expect(result.newlyWired).toBe(true);
      expect(result.requireOptIn).toBe(false);
      expect(typeof result.agentGroupId).toBe('string');
      expect(typeof result.messagingGroupId).toBe('string');
    });
  });

  describe('shared_base_write', () => {
    it('writes content to container/CLAUDE.md at the marker', async () => {
      const marker = '<!-- admin-mcp-test-marker-N3.2 -->';
      const testContent = 'test shared base content N3.2';
      const dst = path.join(process.cwd(), 'container', 'CLAUDE.md');
      const before = fs.existsSync(dst) ? fs.readFileSync(dst, 'utf8') : null;

      const handler = createAdminMcpHandler({ token: TOKEN });
      try {
        const res = await callTool(handler, 'shared_base_write', { marker, content: testContent });

        expect(res.status).toBe(200);
        const result = await toolResult(res);
        expect(result.path).toBe('container/CLAUDE.md');
        expect(typeof result.bytes).toBe('number');
        expect((result.bytes as number) > 0).toBe(true);
        expect(fs.readFileSync(dst, 'utf8')).toContain(testContent);
      } finally {
        if (before === null) {
          fs.rmSync(dst, { force: true });
        } else {
          fs.writeFileSync(dst, before, 'utf8');
        }
      }
    });
  });

  describe('audit logging', () => {
    it('emits an audit line on successful tool call', async () => {
      const writes: string[] = [];
      const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString());
        return true;
      });
      try {
        const handler = createAdminMcpHandler({ token: TOKEN });
        await callTool(handler, 'group_put', {
          groupName: 'auditgroup',
          files: [],
          force: false,
        });
      } finally {
        spy.mockRestore();
      }
      const output = writes.join('');
      expect(output).toContain('admin-mcp audit');
      expect(output).toContain('"ok"');
    });

    it('emits an audit line on failed tool call', async () => {
      const writes: string[] = [];
      const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString());
        return true;
      });
      try {
        const handler = createAdminMcpHandler({ token: TOKEN });
        fs.mkdirSync(path.join(`${TEST_DIR}/groups`, 'auditfailgroup'), { recursive: true });
        await callTool(handler, 'group_put', {
          groupName: 'auditfailgroup',
          files: [],
          force: false,
        });
      } finally {
        spy.mockRestore();
      }
      const output = writes.join('');
      expect(output).toContain('admin-mcp audit');
      expect(output).toContain('error:');
    });

    it('redacts E.164 phone numbers in audit log output', async () => {
      const writes: string[] = [];
      const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString());
        return true;
      });
      try {
        const handler = createAdminMcpHandler({ token: TOKEN });
        await callTool(handler, 'dm_register', {
          channel: 'sms',
          address: '+15551234567',
          groupName: 'auditredact',
          require_opt_in: false,
        });
      } finally {
        spy.mockRestore();
      }
      const output = writes.join('');
      expect(output).not.toContain('+15551234567');
      expect(output).toContain('+15...4567');
    });
  });

  describe('group prefix scoping', () => {
    it('rejects group-targeting verb when groupName does not match any prefix', async () => {
      const handler = createAdminMcpHandler({ token: TOKEN, groupPrefixes: 'allowed-,prod-' });
      const res = await callTool(handler, 'group_put', {
        groupName: 'notallowed',
        files: [],
        force: false,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as McpBody;
      expect(body.error).toBeDefined();
      expect(body.error!.message).toMatch(/prefix/i);
    });

    it('allows group-targeting verb when groupName matches a prefix', async () => {
      const handler = createAdminMcpHandler({ token: TOKEN, groupPrefixes: 'allowed-,prod-' });
      const res = await callTool(handler, 'group_put', {
        groupName: 'allowed-agent',
        files: [],
        force: false,
      });
      expect(res.status).toBe(200);
      const result = await toolResult(res);
      expect(result.groupName).toBe('allowed-agent');
    });

    it('allows all groups when groupPrefixes is empty (no restriction)', async () => {
      const handler = createAdminMcpHandler({ token: TOKEN, groupPrefixes: '' });
      const res = await callTool(handler, 'group_put', {
        groupName: 'anygroup',
        files: [],
        force: false,
      });
      expect(res.status).toBe(200);
      const result = await toolResult(res);
      expect(result.groupName).toBe('anygroup');
    });
  });

  describe('dm_status', () => {
    it('returns registered:true and activationState after dm_register', async () => {
      const handler = createAdminMcpHandler({ token: TOKEN });
      await callTool(handler, 'dm_register', {
        channel: 'sms',
        address: '+15551234567',
        groupName: 'statusgroup',
        require_opt_in: false,
      });

      const res = await callTool(handler, 'dm_status', {
        channel: 'sms',
        address: '+15551234567',
      });

      expect(res.status).toBe(200);
      const result = await toolResult(res);
      expect(result.registered).toBe(true);
      expect(result.activationState).toBe('active');
    });

    it('returns registered:false for unknown address', async () => {
      const handler = createAdminMcpHandler({ token: TOKEN });
      const res = await callTool(handler, 'dm_status', {
        channel: 'sms',
        address: '+19999999999',
      });

      expect(res.status).toBe(200);
      const result = await toolResult(res);
      expect(result.registered).toBe(false);
    });

    it('returns lastControlEvent {keyword, at} when a control event is stored', async () => {
      const handler = createAdminMcpHandler({ token: TOKEN });
      const regRes = await callTool(handler, 'dm_register', {
        channel: 'sms',
        address: '+15551234567',
        groupName: 'tseventgroup',
        require_opt_in: false,
      });
      const reg = await toolResult(regRes);
      const registeredAt = reg.registeredAt as string;

      const eventAt = new Date(Date.parse(registeredAt) + 1000).toISOString();
      const storeDir = path.join(TEST_DIR, 'data');
      fs.mkdirSync(storeDir, { recursive: true });
      fs.writeFileSync(
        path.join(storeDir, 'sms-opt-outs.json'),
        JSON.stringify({
          optedOut: {},
          controlEvents: { '+15551234567': { action: 'start', keyword: 'START', receivedAt: eventAt, at: eventAt } },
        }),
        'utf8',
      );

      const res = await callTool(handler, 'dm_status', { channel: 'sms', address: '+15551234567' });
      expect(res.status).toBe(200);
      const result = await toolResult(res);
      expect(result.lastControlEvent).toEqual({ keyword: 'START', at: eventAt });
    });

    it('returns activationState pending when require_opt_in=true and no START event', async () => {
      const handler = createAdminMcpHandler({ token: TOKEN });
      await callTool(handler, 'dm_register', {
        channel: 'sms',
        address: '+15552222222',
        groupName: 'pendinggroup',
        require_opt_in: true,
      });

      const res = await callTool(handler, 'dm_status', { channel: 'sms', address: '+15552222222' });
      expect(res.status).toBe(200);
      const result = await toolResult(res);
      expect(result.activationState).toBe('pending');
      expect(result.lastControlEvent).toBeNull();
    });

    it('returns activationState active after START event with at strictly > registeredAt', async () => {
      const handler = createAdminMcpHandler({ token: TOKEN });
      const regRes = await callTool(handler, 'dm_register', {
        channel: 'sms',
        address: '+15553333333',
        groupName: 'activategroup',
        require_opt_in: true,
      });
      const reg = await toolResult(regRes);
      const registeredAt = reg.registeredAt as string;

      const startAt = new Date(Date.parse(registeredAt) + 1000).toISOString();
      const storeDir = path.join(TEST_DIR, 'data');
      fs.mkdirSync(storeDir, { recursive: true });
      fs.writeFileSync(
        path.join(storeDir, 'sms-opt-outs.json'),
        JSON.stringify({
          optedOut: {},
          controlEvents: { '+15553333333': { action: 'start', keyword: 'START', receivedAt: startAt, at: startAt } },
        }),
        'utf8',
      );

      const res = await callTool(handler, 'dm_status', { channel: 'sms', address: '+15553333333' });
      expect(res.status).toBe(200);
      const result = await toolResult(res);
      expect(result.activationState).toBe('active');
      expect((result.lastControlEvent as Record<string, string>).keyword).toBe('START');
    });

    it('backward compat: lastControlEvent.at falls back to receivedAt when at field absent', async () => {
      const handler = createAdminMcpHandler({ token: TOKEN });
      await callTool(handler, 'dm_register', {
        channel: 'sms',
        address: '+15554444444',
        groupName: 'backcompatgroup',
        require_opt_in: false,
      });

      const legacyAt = '2025-01-01T00:00:00.000Z';
      const storeDir = path.join(TEST_DIR, 'data');
      fs.mkdirSync(storeDir, { recursive: true });
      fs.writeFileSync(
        path.join(storeDir, 'sms-opt-outs.json'),
        JSON.stringify({
          optedOut: {},
          controlEvents: { '+15554444444': { action: 'stop', keyword: 'STOP', receivedAt: legacyAt } },
        }),
        'utf8',
      );

      const res = await callTool(handler, 'dm_status', { channel: 'sms', address: '+15554444444' });
      expect(res.status).toBe(200);
      const result = await toolResult(res);
      expect((result.lastControlEvent as Record<string, string>).at).toBe(legacyAt);
      expect((result.lastControlEvent as Record<string, string>).keyword).toBe('STOP');
    });

    it('stale START event (at === registeredAt) leaves activationState pending', async () => {
      const handler = createAdminMcpHandler({ token: TOKEN });
      const regRes = await callTool(handler, 'dm_register', {
        channel: 'sms',
        address: '+15555555555',
        groupName: 'stalegroup',
        require_opt_in: true,
      });
      const reg = await toolResult(regRes);
      const registeredAt = reg.registeredAt as string;

      // Event at === registeredAt is NOT strictly greater — must leave pending
      const storeDir = path.join(TEST_DIR, 'data');
      fs.mkdirSync(storeDir, { recursive: true });
      fs.writeFileSync(
        path.join(storeDir, 'sms-opt-outs.json'),
        JSON.stringify({
          optedOut: {},
          controlEvents: {
            '+15555555555': { action: 'start', keyword: 'START', receivedAt: registeredAt, at: registeredAt },
          },
        }),
        'utf8',
      );

      const res = await callTool(handler, 'dm_status', { channel: 'sms', address: '+15555555555' });
      expect(res.status).toBe(200);
      const result = await toolResult(res);
      expect(result.activationState).toBe('pending');
    });

    it('stale START event (at < registeredAt) leaves activationState pending', async () => {
      const handler = createAdminMcpHandler({ token: TOKEN });
      const regRes = await callTool(handler, 'dm_register', {
        channel: 'sms',
        address: '+15556666666',
        groupName: 'oldkeywordgroup',
        require_opt_in: true,
      });
      const reg = await toolResult(regRes);
      const registeredAt = reg.registeredAt as string;

      // Event at < registeredAt (previous consent episode) — must leave pending
      const oldAt = new Date(Date.parse(registeredAt) - 5000).toISOString();
      const storeDir = path.join(TEST_DIR, 'data');
      fs.mkdirSync(storeDir, { recursive: true });
      fs.writeFileSync(
        path.join(storeDir, 'sms-opt-outs.json'),
        JSON.stringify({
          optedOut: {},
          controlEvents: {
            '+15556666666': { action: 'start', keyword: 'START', receivedAt: oldAt, at: oldAt },
          },
        }),
        'utf8',
      );

      const res = await callTool(handler, 'dm_status', { channel: 'sms', address: '+15556666666' });
      expect(res.status).toBe(200);
      const result = await toolResult(res);
      expect(result.activationState).toBe('pending');
    });
  });
});
