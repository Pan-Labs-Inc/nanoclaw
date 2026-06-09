import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks for the DB / session seams (mirrors dispatch.test.ts style) ---

const mockGetAgentGroupByFolder = vi.fn();
vi.mock('../../db/agent-groups.js', () => ({
  getAgentGroupByFolder: (...args: unknown[]) => mockGetAgentGroupByFolder(...args),
}));

const mockGetMessagingGroupsByAgentGroup = vi.fn();
const mockGetMessagingGroupAgentByPair = vi.fn();
vi.mock('../../db/messaging-groups.js', () => ({
  getMessagingGroupsByAgentGroup: (...args: unknown[]) => mockGetMessagingGroupsByAgentGroup(...args),
  getMessagingGroupAgentByPair: (...args: unknown[]) => mockGetMessagingGroupAgentByPair(...args),
}));

const mockResolveSession = vi.fn();
const mockWriteOutboundDirect = vi.fn();
const mockWriteSessionMessage = vi.fn();
vi.mock('../../session-manager.js', () => ({
  resolveSession: (...args: unknown[]) => mockResolveSession(...args),
  writeOutboundDirect: (...args: unknown[]) => mockWriteOutboundDirect(...args),
  writeSessionMessage: (...args: unknown[]) => mockWriteSessionMessage(...args),
}));

// Importing the module registers `messages-send` in the registry as a side effect.
import './messages.js';
import { lookup } from '../registry.js';
import { dispatch } from '../dispatch.js';

// dispatch's host path also touches these — keep them inert. (dispatch only
// consults them for agent callers / approval flows, neither of which apply to
// the host caller used here, but mocking keeps the unit isolated.)
vi.mock('../../db/container-configs.js', () => ({ getContainerConfig: vi.fn() }));
vi.mock('../../db/sessions.js', () => ({ getSession: vi.fn() }));
vi.mock('../crud.js', () => ({ getResource: vi.fn() }));
vi.mock('../../modules/approvals/index.js', () => ({
  registerApprovalHandler: vi.fn(),
  requestApproval: vi.fn(),
}));
vi.mock('../../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

beforeEach(() => {
  vi.clearAllMocks();
  // Default: resolveSession returns the real { session, created } shape.
  mockResolveSession.mockReturnValue({ session: { id: 'sess-default', agent_group_id: 'ag' }, created: false });
  // Default: no wiring row found → verb falls back to 'shared'.
  mockGetMessagingGroupAgentByPair.mockReturnValue(undefined);
});

describe('messages send — folder → channel resolution + outbound payload', () => {
  it('is registered as the `messages-send` command under the `messages` resource', () => {
    const cmd = lookup('messages-send');
    expect(cmd).toBeDefined();
    expect(cmd?.resource).toBe('messages');
  });

  it('resolves folder → agent group → wired channel and writes the verbatim outbound row', async () => {
    mockGetAgentGroupByFolder.mockReturnValue({ id: 'ag-1', folder: 'pan-parent-abc123' });
    mockGetMessagingGroupsByAgentGroup.mockReturnValue([
      { id: 'mg-1', channel_type: 'telegram', platform_id: '99887766' },
    ]);
    mockResolveSession.mockReturnValue({ session: { id: 'sess-xyz', agent_group_id: 'ag-1' }, created: false });

    const resp = await dispatch(
      {
        id: 'r1',
        command: 'messages-send',
        args: { folder: 'pan-parent-abc123', text: 'Pan flagged a safety concern' },
      },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(true);

    // Folder was resolved via the agent-group lookup.
    expect(mockGetAgentGroupByFolder).toHaveBeenCalledWith('pan-parent-abc123');
    // Session resolved against the wired messaging group in shared mode.
    expect(mockResolveSession).toHaveBeenCalledWith('ag-1', 'mg-1', null, 'shared');

    // The outbound payload must be verbatim: kind 'agent', JSON {text},
    // addressed to the wired channel's (platform_id, channel_type).
    expect(mockWriteOutboundDirect).toHaveBeenCalledTimes(1);
    const [agentGroupId, sessionId, message] = mockWriteOutboundDirect.mock.calls[0];
    expect(agentGroupId).toBe('ag-1');
    expect(sessionId).toBe('sess-xyz');
    expect(message).toMatchObject({
      kind: 'agent',
      platformId: '99887766',
      channelType: 'telegram',
      threadId: null,
      content: JSON.stringify({ text: 'Pan flagged a safety concern' }),
    });
    expect(typeof message.id).toBe('string');
    expect(message.id.length).toBeGreaterThan(0);
  });

  it('does NOT seed inbound history unless --record is passed (delivery-only default)', async () => {
    mockGetAgentGroupByFolder.mockReturnValue({ id: 'ag-1', folder: 'pan-parent-abc123' });
    mockGetMessagingGroupsByAgentGroup.mockReturnValue([
      { id: 'mg-1', channel_type: 'telegram', platform_id: '99887766' },
    ]);
    mockResolveSession.mockReturnValue({ session: { id: 'sess-xyz', agent_group_id: 'ag-1' }, created: false });

    const resp = await dispatch(
      { id: 'r1b', command: 'messages-send', args: { folder: 'pan-parent-abc123', text: 'hi' } },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(true);
    expect(mockWriteOutboundDirect).toHaveBeenCalledTimes(1);
    // No --record → the owning agent's inbound.db is untouched.
    expect(mockWriteSessionMessage).not.toHaveBeenCalled();
  });

  it('with --record, ALSO seeds the owning agent inbound.db as a kind:delivered, trigger:0 row', async () => {
    mockGetAgentGroupByFolder.mockReturnValue({ id: 'ag-1', folder: 'pan-teen-abc123' });
    mockGetMessagingGroupsByAgentGroup.mockReturnValue([
      { id: 'mg-1', channel_type: 'telegram', platform_id: '99887766' },
    ]);
    mockResolveSession.mockReturnValue({ session: { id: 'sess-xyz', agent_group_id: 'ag-1' }, created: false });

    const resp = await dispatch(
      {
        id: 'r1c',
        command: 'messages-send',
        // Bare `--record` parses to boolean true (client.ts).
        args: { folder: 'pan-teen-abc123', text: 'Hey 👋 I’m Pan', record: true },
      },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(true);
    // Delivery still happens (outbound), AND the inbound history row is written.
    expect(mockWriteOutboundDirect).toHaveBeenCalledTimes(1);
    expect(mockWriteSessionMessage).toHaveBeenCalledTimes(1);

    const [agentGroupId, sessionId, message] = mockWriteSessionMessage.mock.calls[0];
    expect(agentGroupId).toBe('ag-1');
    expect(sessionId).toBe('sess-xyz');
    expect(message).toMatchObject({
      kind: 'delivered',
      trigger: 0,
      platformId: '99887766',
      channelType: 'telegram',
      content: JSON.stringify({ text: 'Hey 👋 I’m Pan' }),
    });
    // The inbound (history) row content must match the outbound (delivered) text verbatim.
    const outbound = mockWriteOutboundDirect.mock.calls[0][2];
    expect(message.content).toBe(outbound.content);

    if (resp.ok) {
      expect(resp.data).toMatchObject({ delivered: true, recorded: true });
    }
  });

  it('CHANNEL-FIRST: a --record history-seed failure does NOT fail the command (no retry/double-send)', async () => {
    // Regression: delivery (writeOutboundDirect) already happened. If the inbound
    // history seed throws and we let it bubble, the command exits non-zero and a
    // retry-on-failure caller (the escalation-watcher) re-delivers an already-sent
    // alert — a double-alert on the safety path. The seed must degrade gracefully.
    mockGetAgentGroupByFolder.mockReturnValue({ id: 'ag-1', folder: 'pan-parent-abc123' });
    mockGetMessagingGroupsByAgentGroup.mockReturnValue([
      { id: 'mg-1', channel_type: 'telegram', platform_id: '99887766' },
    ]);
    mockResolveSession.mockReturnValue({ session: { id: 'sess-xyz', agent_group_id: 'ag-1' }, created: false });
    mockWriteSessionMessage.mockImplementation(() => {
      throw new Error('inbound.db locked');
    });

    const resp = await dispatch(
      {
        id: 'r1d',
        command: 'messages-send',
        args: { folder: 'pan-parent-abc123', text: 'Pan flagged a safety concern', record: true },
      },
      { caller: 'host' },
    );

    // Delivery succeeded → command succeeds (ok), so the caller does NOT retry.
    expect(resp.ok).toBe(true);
    expect(mockWriteOutboundDirect).toHaveBeenCalledTimes(1);
    if (resp.ok) {
      // But the seed is reported as not recorded, so the failure is visible.
      expect(resp.data).toMatchObject({ delivered: true, recorded: false });
    }
  });

  it('errors (non-zero / not ok) on an unknown folder and does NOT write outbound', async () => {
    mockGetAgentGroupByFolder.mockReturnValue(undefined);

    const resp = await dispatch(
      { id: 'r2', command: 'messages-send', args: { folder: 'nope', text: 'hi' } },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.message).toContain('no agent group for folder');
    }
    expect(mockWriteOutboundDirect).not.toHaveBeenCalled();
  });

  it('errors when the folder has no wired messaging group', async () => {
    mockGetAgentGroupByFolder.mockReturnValue({ id: 'ag-2', folder: 'pan-parent-empty' });
    mockGetMessagingGroupsByAgentGroup.mockReturnValue([]);

    const resp = await dispatch(
      { id: 'r3', command: 'messages-send', args: { folder: 'pan-parent-empty', text: 'hi' } },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.message).toContain('no wired messaging group');
    }
    expect(mockWriteOutboundDirect).not.toHaveBeenCalled();
  });

  it('requires --folder and --text (invalid-args)', async () => {
    const noText = await dispatch(
      { id: 'r4', command: 'messages-send', args: { folder: 'x' } },
      { caller: 'host' },
    );
    expect(noText.ok).toBe(false);
    if (!noText.ok) expect(noText.error.code).toBe('invalid-args');

    const noFolder = await dispatch(
      { id: 'r5', command: 'messages-send', args: { text: 'x' } },
      { caller: 'host' },
    );
    expect(noFolder.ok).toBe(false);
    if (!noFolder.ok) expect(noFolder.error.code).toBe('invalid-args');
  });

  it('requires disambiguation when a folder is wired to multiple channels', async () => {
    mockGetAgentGroupByFolder.mockReturnValue({ id: 'ag-3', folder: 'pan-parent-multi' });
    mockGetMessagingGroupsByAgentGroup.mockReturnValue([
      { id: 'mg-a', channel_type: 'telegram', platform_id: '111' },
      { id: 'mg-b', channel_type: 'whatsapp', platform_id: '222' },
    ]);

    const ambiguous = await dispatch(
      { id: 'r6', command: 'messages-send', args: { folder: 'pan-parent-multi', text: 'hi' } },
      { caller: 'host' },
    );
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) expect(ambiguous.error.message).toContain('multiple channels');
    expect(mockWriteOutboundDirect).not.toHaveBeenCalled();

    // With --channel-type + --platform-id it picks the right one.
    const picked = await dispatch(
      {
        id: 'r7',
        command: 'messages-send',
        args: {
          folder: 'pan-parent-multi',
          text: 'hi',
          'channel-type': 'whatsapp',
          'platform-id': '222',
        },
      },
      { caller: 'host' },
    );
    expect(picked.ok).toBe(true);
    expect(mockResolveSession).toHaveBeenCalledWith('ag-3', 'mg-b', null, 'shared');
    const [, , message] = mockWriteOutboundDirect.mock.calls[0];
    expect(message).toMatchObject({ platformId: '222', channelType: 'whatsapp' });
  });

  it('resolves using the wiring’s configured session_mode (agent-shared), reusing the existing session', async () => {
    // Pan wires family groups as session_mode='agent-shared'. The verb MUST
    // resolve in that mode so it lands on the existing agent-shared session
    // (findSessionByAgentGroup) instead of forcing 'shared', which would take
    // the findSessionForAgent(session_mode='shared') path, miss the live session,
    // and create a SECOND active session for the agent group.
    mockGetAgentGroupByFolder.mockReturnValue({ id: 'ag-as', folder: 'pan-parent-fam2' });
    mockGetMessagingGroupsByAgentGroup.mockReturnValue([
      { id: 'mg-as', channel_type: 'telegram', platform_id: '55443322' },
    ]);
    // Wiring row exists and is agent-shared (what Pan writes).
    mockGetMessagingGroupAgentByPair.mockReturnValue({
      id: 'mga-1',
      messaging_group_id: 'mg-as',
      agent_group_id: 'ag-as',
      session_mode: 'agent-shared',
    });
    // The existing agent-shared session that resolveSession would find/return.
    mockResolveSession.mockReturnValue({
      session: { id: 'sess-existing-agent-shared', agent_group_id: 'ag-as' },
      created: false,
    });

    const resp = await dispatch(
      {
        id: 'r8',
        command: 'messages-send',
        args: { folder: 'pan-parent-fam2', text: 'reuse me' },
      },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(true);
    // Looked up the wiring for THIS (messaging group, agent group) pair.
    expect(mockGetMessagingGroupAgentByPair).toHaveBeenCalledWith('mg-as', 'ag-as');
    // Resolved with the wiring's ACTUAL mode — 'agent-shared', NOT a forced 'shared'.
    expect(mockResolveSession).toHaveBeenCalledWith('ag-as', 'mg-as', null, 'agent-shared');
    // And the verb did NOT create/use a second session: it wrote to the one
    // resolveSession returned (the existing agent-shared session).
    expect(mockWriteOutboundDirect).toHaveBeenCalledTimes(1);
    const [agentGroupId, sessionId] = mockWriteOutboundDirect.mock.calls[0];
    expect(agentGroupId).toBe('ag-as');
    expect(sessionId).toBe('sess-existing-agent-shared');
  });
});
