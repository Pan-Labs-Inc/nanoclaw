import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DIR } = vi.hoisted(() => ({
  TEST_DIR: '/tmp/nanoclaw-pan-mcp-test',
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
import { getAgentGroupByFolder } from './db/agent-groups.js';
import { getMessagingGroupAgentByPair, getMessagingGroupByPlatform } from './db/messaging-groups.js';
import { createPanMcpHandler } from './pan-mcp.js';

const TOKEN = 'pan-mcp-token-1234567890abcdef1234567890';
const FID = 'calm-cedar-a3f291';

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  runMigrations(initTestDb());
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('Pan MCP endpoint', () => {
  it('is disabled when no token is configured', async () => {
    const handler = createPanMcpHandler({ token: '' });
    const res = await handler(
      new Request('http://localhost/webhook/pan-mcp', {
        method: 'POST',
        body: '{}',
      }),
    );

    expect(res.status).toBe(404);
  });

  it('rejects requests without the bearer token', async () => {
    const handler = createPanMcpHandler({ token: TOKEN });
    const res = await handler(
      new Request('http://localhost/webhook/pan-mcp', {
        method: 'POST',
        body: '{}',
      }),
    );

    expect(res.status).toBe(403);
  });

  it('lists Pan SMS control tools through MCP tools/list', async () => {
    const handler = createPanMcpHandler({ token: TOKEN });
    const res = await handler(
      new Request('http://localhost/webhook/pan-mcp', {
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
    expect(frame.result.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'pan_sms_read_enrollment',
        'pan_sms_record_opt_in',
        'pan_sms_get_control_event',
        'pan_sms_register',
        'pan_put_group',
        'pan_write_parent_mount',
      ]),
    );
  });

  it('resolves enrollment phones and writes opt-in records through tools/call', async () => {
    writeEnrollment(FID);
    const handler = createPanMcpHandler({ token: TOKEN });

    const resolved = await callTool(handler, 'pan_sms_resolve_phone', { fid: FID, persona: 'teen' });
    expect(resolved).toMatchObject({ fid: FID, persona: 'teen', phone: '+15105551234' });

    const recorded = await callTool(handler, 'pan_sms_record_opt_in', {
      fid: FID,
      persona: 'teen',
      phone: '+15105551234',
      confirmedBy: 'unit-test',
    });
    expect(recorded.record).toMatchObject({
      TEEN_SMS_OPT_IN: 'confirmed',
      TEEN_SMS_PHONE: '+15105551234',
      TEEN_SMS_OPT_IN_BY: 'unit-test',
    });

    const optInPath = path.join(TEST_DIR, 'groups', `pan-parent-${FID}`, '.sms-opt-in');
    expect(fs.statSync(optInPath).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(optInPath, 'utf8')).toContain('TEEN_SMS_OPT_IN=confirmed');
  });

  it('registers an SMS phone as a wired direct messaging group', async () => {
    const handler = createPanMcpHandler({ token: TOKEN });

    const result = await callTool(handler, 'pan_sms_register', {
      fid: FID,
      persona: 'parent',
      phone: '+15105559876',
      name: `Pan Parent ${FID}`,
      assistantName: 'Pan',
    });

    const agentGroup = getAgentGroupByFolder(`pan-parent-${FID}`);
    const messagingGroup = getMessagingGroupByPlatform('sms', '+15105559876');
    expect(result).toMatchObject({
      fid: FID,
      persona: 'parent',
      folder: `pan-parent-${FID}`,
      phone: '+15105559876',
      platformId: '+15105559876',
      newlyWired: true,
    });
    expect(agentGroup).toBeDefined();
    expect(messagingGroup).toBeDefined();
    expect(messagingGroup?.is_group).toBe(0);
    expect(getMessagingGroupAgentByPair(messagingGroup!.id, agentGroup!.id)).toBeDefined();
  });
});

async function callTool(handler: (request: Request) => Promise<Response>, name: string, args: Record<string, unknown>) {
  const res = await handler(
    new Request('http://localhost/webhook/pan-mcp', {
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
  expect(res.status).toBe(200);
  const frame = (await res.json()) as {
    result?: { structuredContent?: Record<string, unknown> };
    error?: { message: string };
  };
  if (frame.error) throw new Error(frame.error.message);
  return frame.result?.structuredContent ?? {};
}

function writeEnrollment(fid: string) {
  const groupDir = path.join(TEST_DIR, 'groups', `pan-parent-${fid}`);
  fs.mkdirSync(groupDir, { recursive: true });
  fs.writeFileSync(
    path.join(groupDir, '.pan-enrollment'),
    [
      `FAMILY_ID=${fid}`,
      'TEEN_NAME=Alex',
      'TEEN_AGE=16',
      'PARENT_NAME=Sarah',
      'TIMEZONE=America/New_York',
      'CHANNEL_TYPE=sms',
      'TEEN_PHONE=+15105551234',
      'PARENT_PHONE=+15105559876',
      '',
    ].join('\n'),
    'utf8',
  );
}
