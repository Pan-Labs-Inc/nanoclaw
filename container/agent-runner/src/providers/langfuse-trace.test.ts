/**
 * Tests for the Langfuse Stop-hook core (transcript JSONL → trace payloads).
 *
 * Pins the contract the integration depends on:
 *  - gating: no config unless enabled + both keys present;
 *  - privacy: message text + tool I/O are redacted by default, sent only when
 *    LANGFUSE_LOG_PROMPTS is opted in (the teen-privacy default);
 *  - turn/generation/tool-span structure, token-usage mapping, environment tag;
 *  - offset advances past whole lines only (partial last line is held back);
 *  - re-parsing from the advanced offset yields no duplicate turns;
 *  - malformed/meta/sidechain lines are skipped, never throw.
 */
import { describe, it, expect } from 'bun:test';

import {
  resolveLangfuseConfig,
  resolveLogLevel,
  resolveTraceUserId,
  redact,
  parseTranscriptTurns,
  buildTracePayloads,
  buildSystemPromptPayload,
  emitTracePayloads,
  type LangfuseLike,
  type TracePayload,
} from './langfuse-trace.js';

const KEYS = {
  LANGFUSE_ENABLED: '1',
  LANGFUSE_PUBLIC_KEY: 'pk-lf-public',
  LANGFUSE_SECRET_KEY: 'sk-lf-secret',
  LANGFUSE_HOST: 'https://us.cloud.langfuse.com',
};

// ── Transcript fixtures (real Claude Code JSONL shapes) ──

function userLine(text: string, uuid = 'u1', ts = '2026-05-30T00:00:00.000Z'): string {
  return JSON.stringify({ type: 'user', uuid, timestamp: ts, version: '2.1.157', message: { role: 'user', content: text } });
}
function assistantLine(opts: {
  uuid?: string;
  ts?: string;
  text?: string;
  thinking?: string;
  toolUse?: { id: string; name: string; input: unknown };
}): string {
  const content: unknown[] = [];
  if (opts.thinking) content.push({ type: 'thinking', thinking: opts.thinking });
  if (opts.text) content.push({ type: 'text', text: opts.text });
  if (opts.toolUse) content.push({ type: 'tool_use', id: opts.toolUse.id, name: opts.toolUse.name, input: opts.toolUse.input });
  return JSON.stringify({
    type: 'assistant',
    uuid: opts.uuid || 'a1',
    timestamp: opts.ts || '2026-05-30T00:00:01.000Z',
    message: {
      role: 'assistant',
      model: 'claude-opus-4-8',
      content,
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 30 },
    },
  });
}
function toolResultLine(toolUseId: string, output: string, uuid = 'tr1'): string {
  return JSON.stringify({
    type: 'user',
    uuid,
    timestamp: '2026-05-30T00:00:02.000Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: output }] },
  });
}

// A full turn: prompt → assistant(tool_use) → tool_result → assistant(text).
function fullTurn(): string {
  return (
    [
      userLine('what is the weather'),
      assistantLine({ uuid: 'a1', text: '', toolUse: { id: 't1', name: 'Bash', input: { command: 'curl wttr.in' } } }),
      toolResultLine('t1', 'sunny, 72F'),
      assistantLine({ uuid: 'a2', ts: '2026-05-30T00:00:03.000Z', text: "It's sunny and 72F." }),
    ].join('\n') + '\n'
  );
}

describe('resolveLangfuseConfig — gating', () => {
  it('returns null when LANGFUSE_ENABLED is unset or falsy', () => {
    expect(resolveLangfuseConfig({ ...KEYS, LANGFUSE_ENABLED: undefined })).toBeNull();
    expect(resolveLangfuseConfig({ ...KEYS, LANGFUSE_ENABLED: 'false' })).toBeNull();
    expect(resolveLangfuseConfig({ ...KEYS, LANGFUSE_ENABLED: '0' })).toBeNull();
  });

  it('returns null when a key is missing (no half-configured client)', () => {
    expect(resolveLangfuseConfig({ ...KEYS, LANGFUSE_PUBLIC_KEY: undefined })).toBeNull();
    expect(resolveLangfuseConfig({ ...KEYS, LANGFUSE_SECRET_KEY: '' })).toBeNull();
  });

  it('resolves keys, strips trailing slash, defaults host, accepts truthy spellings', () => {
    const cfg = resolveLangfuseConfig({ ...KEYS, LANGFUSE_HOST: 'https://us.cloud.langfuse.com/' });
    expect(cfg).toMatchObject({ publicKey: 'pk-lf-public', secretKey: 'sk-lf-secret', baseUrl: 'https://us.cloud.langfuse.com', logLevel: 'redacted' });
    expect(resolveLangfuseConfig({ ...KEYS, LANGFUSE_HOST: undefined })!.baseUrl).toBe('https://cloud.langfuse.com');
    for (const v of ['1', 'true', 'TRUE', 'yes', 'on']) {
      expect(resolveLangfuseConfig({ ...KEYS, LANGFUSE_ENABLED: v })).not.toBeNull();
    }
  });

  it('validates/normalizes the environment and resolves the log tier', () => {
    expect(resolveLangfuseConfig({ ...KEYS, LANGFUSE_ENVIRONMENT: 'Production' })!.environment).toBe('production');
    expect(resolveLangfuseConfig({ ...KEYS, LANGFUSE_ENVIRONMENT: 'bad env' })!.environment).toBeUndefined();
    expect(resolveLangfuseConfig({ ...KEYS, LANGFUSE_ENVIRONMENT: 'langfuse-x' })!.environment).toBeUndefined();
    expect(resolveLangfuseConfig({ ...KEYS, LANGFUSE_LOG_LEVEL: 'system' })!.logLevel).toBe('system');
    expect(resolveLangfuseConfig({ ...KEYS, LANGFUSE_LOG_PROMPTS: '1' })!.logLevel).toBe('full');
  });
});

describe('resolveLogLevel — privacy tier', () => {
  it('defaults to redacted when nothing is set', () => {
    expect(resolveLogLevel({})).toBe('redacted');
    expect(resolveLogLevel({ LANGFUSE_LOG_LEVEL: 'bogus' })).toBe('redacted');
  });
  it('honours an explicit valid tier (case-insensitive, trimmed)', () => {
    expect(resolveLogLevel({ LANGFUSE_LOG_LEVEL: 'system' })).toBe('system');
    expect(resolveLogLevel({ LANGFUSE_LOG_LEVEL: ' FULL ' })).toBe('full');
    expect(resolveLogLevel({ LANGFUSE_LOG_LEVEL: 'Redacted' })).toBe('redacted');
  });
  it('maps the legacy LANGFUSE_LOG_PROMPTS boolean to full', () => {
    expect(resolveLogLevel({ LANGFUSE_LOG_PROMPTS: '1' })).toBe('full');
    expect(resolveLogLevel({ LANGFUSE_LOG_PROMPTS: 'true' })).toBe('full');
    expect(resolveLogLevel({ LANGFUSE_LOG_PROMPTS: '0' })).toBe('redacted');
  });
  it('lets an explicit LOG_LEVEL win over the legacy alias', () => {
    expect(resolveLogLevel({ LANGFUSE_LOG_LEVEL: 'system', LANGFUSE_LOG_PROMPTS: '1' })).toBe('system');
  });
});

describe('resolveTraceUserId — trace identity vs privacy tier', () => {
  it('ships an explicit traceUserId at EVERY tier (operator-assigned config, not content)', () => {
    for (const logLevel of ['redacted', 'system', 'full'] as const) {
      expect(resolveTraceUserId({ traceUserId: 'kind-flame-2623a3-teen', logLevel })).toBe('kind-flame-2623a3-teen');
    }
  });
  it('trims the explicit id and treats blank as absent', () => {
    expect(resolveTraceUserId({ traceUserId: '  fid-teen ', logLevel: 'system' })).toBe('fid-teen');
    expect(resolveTraceUserId({ traceUserId: '   ', logLevel: 'system', assistantName: 'pan-teen-x' })).toBeUndefined();
  });
  it('keeps the implicit agent-identity fallback gated to the full tier', () => {
    expect(resolveTraceUserId({ logLevel: 'redacted', assistantName: 'pan-teen-x' })).toBeUndefined();
    expect(resolveTraceUserId({ logLevel: 'system', assistantName: 'pan-teen-x' })).toBeUndefined();
    expect(resolveTraceUserId({ logLevel: 'full', assistantName: 'pan-teen-x' })).toBe('pan-teen-x');
  });
  it('falls back to the workspace dir name at full when assistantName is absent', () => {
    expect(resolveTraceUserId({ logLevel: 'full', cwd: '/workspace/group' })).toBe('group');
    expect(resolveTraceUserId({ logLevel: 'full' })).toBeUndefined();
  });
  it('prefers the explicit id over the implicit identity at full', () => {
    expect(
      resolveTraceUserId({ traceUserId: 'fid-teen', logLevel: 'full', assistantName: 'pan-teen-x', cwd: '/w/g' }),
    ).toBe('fid-teen');
  });
});

describe('redact', () => {
  it('replaces strings with a length-tagged placeholder at redacted/system', () => {
    expect(redact('hello', 'redacted')).toBe('[redacted: 5 chars]');
    expect(redact('hello', 'system')).toBe('[redacted: 5 chars]'); // system hides DIALOGUE too
    expect(redact({ command: 'rm -rf' }, 'redacted')).toMatch(/^\[redacted: \d+ chars\]$/);
  });
  it('passes content through only at the full tier', () => {
    expect(redact('hello', 'full')).toBe('hello');
    expect(redact({ a: 1 }, 'full')).toEqual({ a: 1 });
  });
  it('leaves null/undefined untouched', () => {
    expect(redact(undefined, 'redacted')).toBeUndefined();
    expect(redact(null, 'redacted')).toBeNull();
  });
});

describe('parseTranscriptTurns — offset + grouping', () => {
  it('groups a prompt + assistant work into one turn', () => {
    const { turns, newOffset } = parseTranscriptTurns(fullTurn(), 0);
    expect(turns).toHaveLength(1);
    expect(turns[0].assistants).toHaveLength(2);
    expect(turns[0].toolResults.get('t1')).toBe('sunny, 72F');
    expect(newOffset).toBe(Buffer.byteLength(fullTurn(), 'utf8'));
  });

  it('does not consume a trailing partial line (no newline yet)', () => {
    const content = userLine('hi') + '\n' + '{"type":"assist'; // partial second line
    const { turns, newOffset } = parseTranscriptTurns(content, 0);
    expect(turns).toHaveLength(1);
    expect(newOffset).toBe(Buffer.byteLength(userLine('hi') + '\n', 'utf8'));
  });

  it('re-parsing from the advanced offset yields no duplicate turns', () => {
    const first = parseTranscriptTurns(fullTurn(), 0);
    const again = parseTranscriptTurns(fullTurn(), first.newOffset);
    expect(again.turns).toHaveLength(0);
    expect(again.newOffset).toBe(first.newOffset);
  });

  it('appended turns after the offset are picked up on the next call', () => {
    const turn1 = fullTurn();
    const turn2 = userLine('again', 'u2') + '\n' + assistantLine({ uuid: 'a3', text: 'sure' }) + '\n';
    const first = parseTranscriptTurns(turn1, 0);
    const second = parseTranscriptTurns(turn1 + turn2, first.newOffset);
    expect(second.turns).toHaveLength(1);
    expect(second.turns[0].user?.uuid).toBe('u2');
  });

  it('drops sidechain/unparseable lines, and folds a leading meta line into the next turn', () => {
    const content =
      [
        JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: 'caveat' } }),
        '{not json',
        JSON.stringify({ type: 'assistant', isSidechain: true, uuid: 'sx', message: { role: 'assistant', content: [{ type: 'text', text: 'subagent' }] } }),
        userLine('real prompt', 'u9'),
        assistantLine({ uuid: 'a9', text: 'real reply' }),
      ].join('\n') + '\n';
    const { turns } = parseTranscriptTurns(content, 0);
    expect(turns).toHaveLength(1); // the meta line does NOT spawn a phantom turn
    expect(turns[0].user?.uuid).toBe('u9');
    expect(turns[0].injected).toEqual(['caveat']); // captured as scaffolding, not dropped
  });

  it('captures injected meta lines that precede the assistant in a userless turn', () => {
    const content =
      [
        JSON.stringify({ type: 'user', isMeta: true, uuid: 'm1', message: { role: 'user', content: '<gate>complete onboarding</gate>' } }),
        assistantLine({ uuid: 'a1', text: 'hi there' }),
      ].join('\n') + '\n';
    const { turns } = parseTranscriptTurns(content, 0);
    expect(turns).toHaveLength(1);
    expect(turns[0].user).toBeUndefined();
    expect(turns[0].injected).toEqual(['<gate>complete onboarding</gate>']);
  });
});

describe('buildTracePayloads — mapping + privacy', () => {
  const ctx = { sessionId: 'sess-abc', userId: 'Pan', environment: 'production', logLevel: 'redacted' as const };
  const build = (logLevel: 'redacted' | 'system' | 'full' = 'redacted') =>
    buildTracePayloads(parseTranscriptTurns(fullTurn(), 0).turns, { ...ctx, logLevel });

  it('builds one trace per turn with session, user, env tag, and metadata', () => {
    const [trace] = build();
    expect(trace.sessionId).toBe('sess-abc');
    expect(trace.userId).toBe('Pan');
    expect(trace.tags).toContain('claude-code');
    expect(trace.tags).toContain('production');
    expect(trace.metadata.source).toBe('claude-code');
    expect(trace.metadata.assistant_message_count).toBe(2);
    expect(trace.metadata.tool_count).toBe(1);
    expect(trace.timestamp).toBeInstanceOf(Date);
  });

  it('maps assistant messages to generations with model + token usage', () => {
    const [trace] = build();
    expect(trace.generations).toHaveLength(2);
    const gen = trace.generations[0];
    expect(gen.model).toBe('claude-opus-4-8');
    expect(gen.usage).toEqual({ input: 100, output: 20, total: 120, unit: 'TOKENS' });
    expect(gen.metadata.cache_read_input_tokens).toBe(5);
  });

  it('maps tool_use to a span with its matched tool_result', () => {
    const [trace] = build('full'); // full tier so we can see the real values
    const toolGen = trace.generations.find((g) => g.tools.length > 0)!;
    expect(toolGen.tools[0].name).toBe('Bash');
    expect(toolGen.tools[0].input).toEqual({ command: 'curl wttr.in' });
    expect(toolGen.tools[0].output).toBe('sunny, 72F');
  });

  it('REDACTS prompt, response, and tool I/O by default (teen-privacy gate)', () => {
    const [trace] = build('redacted');
    expect(String(trace.input)).toMatch(/^\[redacted: \d+ chars\]$/); // length-tagged, not raw
    expect(String(trace.input)).not.toContain('weather');
    expect(String(trace.output)).not.toContain('sunny');
    const tool = trace.generations.find((g) => g.tools.length > 0)!.tools[0];
    expect(String(tool.input)).toMatch(/^\[redacted:/);
    expect(String(tool.output)).toMatch(/^\[redacted:/);
  });

  it('the system tier STILL redacts dialogue and tool I/O (only scaffolding is exposed)', () => {
    const [trace] = build('system');
    expect(String(trace.input)).toMatch(/^\[redacted: \d+ chars\]$/);
    expect(String(trace.input)).not.toContain('weather');
    expect(String(trace.output)).not.toContain('sunny');
    const tool = trace.generations.find((g) => g.tools.length > 0)!.tools[0];
    expect(String(tool.input)).toMatch(/^\[redacted:/);
    expect(String(tool.output)).toMatch(/^\[redacted:/);
  });

  it('includes raw content only at the full tier', () => {
    const [trace] = build('full');
    expect(trace.input).toBe('what is the weather');
    expect(trace.output).toBe("It's sunny and 72F.");
  });

  it('exposes injected scaffolding text at system/full, length-tags it at redacted', () => {
    const content =
      [
        JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: '<gate>finish onboarding</gate>' } }),
        userLine('hey', 'u1'),
        assistantLine({ uuid: 'a1', text: 'hi' }),
      ].join('\n') + '\n';
    const turns = parseTranscriptTurns(content, 0).turns;
    const sys = buildTracePayloads(turns, { ...ctx, logLevel: 'system' })[0];
    expect(sys.metadata.injected_count).toBe(1);
    expect(sys.metadata.injected_messages).toEqual(['<gate>finish onboarding</gate>']);

    const red = buildTracePayloads(turns, { ...ctx, logLevel: 'redacted' })[0];
    expect(red.metadata.injected_count).toBe(1);
    expect(String(red.metadata.injected_messages)).toMatch(/^\[redacted: 1 message\(s\)\]$/);
    expect(String(red.metadata.injected_messages)).not.toContain('onboarding');
  });

  it('NEVER includes thinking-block text — even with logPrompts on', () => {
    const content =
      userLine('hi', 'u1') + '\n' +
      assistantLine({ uuid: 'a1', thinking: 'SECRET internal reasoning about the teen', text: 'hello there' }) + '\n';
    const turns = parseTranscriptTurns(content, 0).turns;
    const blob = JSON.stringify(buildTracePayloads(turns, { sessionId: 's', logLevel: 'full' }));
    expect(blob).not.toContain('SECRET');
    expect(blob).toContain('hello there'); // assistant text still flows at the full tier
  });

  it('omits userId when the caller does not supply one (privacy default)', () => {
    const [trace] = buildTracePayloads(parseTranscriptTurns(fullTurn(), 0).turns, {
      sessionId: 's', logLevel: 'redacted',
    });
    expect(trace.userId).toBeUndefined();
    // Identity must not leak into tags either.
    expect(trace.tags).toEqual(['claude-code']);
  });
});

describe('emitTracePayloads', () => {
  function mockClient() {
    const calls = { traces: [] as any[], generations: [] as any[], spans: [] as any[] };
    const span = (b: any) => { calls.spans.push(b); return {}; };
    const generation = (b: any) => { calls.generations.push(b); return { span }; };
    const trace = (b: any) => { calls.traces.push(b); return { generation, span }; };
    return { client: { trace } as unknown as LangfuseLike, calls };
  }

  it('emits a trace, a generation per assistant message, and a span per tool', () => {
    const payloads = buildTracePayloads(parseTranscriptTurns(fullTurn(), 0).turns, {
      sessionId: 's', logLevel: 'redacted',
    });
    const { client, calls } = mockClient();
    const n = emitTracePayloads(client, payloads);
    expect(n).toBe(1);
    expect(calls.traces).toHaveLength(1);
    expect(calls.generations).toHaveLength(2);
    expect(calls.spans).toHaveLength(1);
    expect(calls.traces[0].id).toBe('u1'); // anchored on the user-prompt uuid → idempotent
  });

  it('emits nothing for an empty payload set', () => {
    const { client, calls } = mockClient();
    expect(emitTracePayloads(client, [] as TracePayload[])).toBe(0);
    expect(calls.traces).toHaveLength(0);
  });
});

describe('buildSystemPromptPayload — composed system prompt capture', () => {
  // Mirrors the real composition: CLAUDE.md @imports the shared base but NOT the
  // persona — the persona loads via settingSources 'local', not an @import.
  const files = {
    claudeMd: '@./.claude-shared.md\n# Group\n',
    claudeLocalMd: 'You are Pan for the Smith family.\n',
    sharedBase: '# Shared base\n',
  };
  const ctx = (logLevel: 'redacted' | 'system' | 'full') => ({ sessionId: 'sess-xyz', environment: 'test', logLevel });

  it('returns null at the redacted tier (system prompt is scaffolding, withheld)', () => {
    expect(buildSystemPromptPayload(files, ctx('redacted'), { localSettingEnabled: true })).toBeNull();
  });

  it('builds a session-keyed, idempotent trace at system/full with the file contents', () => {
    const p = buildSystemPromptPayload(files, ctx('system'), { localSettingEnabled: true })!;
    expect(p.id).toBe('sysprompt-sess-xyz'); // derived from session → upsert, once per session
    expect(p.name).toBe('system-prompt');
    expect(p.sessionId).toBe('sess-xyz');
    expect(p.tags).toEqual(['claude-code', 'system-prompt', 'test']);
    expect(p.generations).toHaveLength(0);
    expect((p.input as any).claudeLocalMd).toContain('Smith family');
    expect((p.input as any).sharedBase).toContain('Shared base');
  });

  it('reports the load wiring: persona present + settingSources local enabled (healthy)', () => {
    const p = buildSystemPromptPayload(files, ctx('system'), { localSettingEnabled: true })!;
    expect(p.metadata.has_claude_local).toBe(true);          // the persona WAS compiled
    expect(p.metadata.settings_local_enabled).toBe(true);    // ...and the SDK is told to load it
    expect(p.metadata.shared_base_imported).toBe(true);      // CLAUDE.md @imports the shared base
    expect(p.metadata.claude_local_bytes).toBe(files.claudeLocalMd.length);
  });

  it('surfaces the #611 signature: persona on disk but settingSources local OFF', () => {
    const p = buildSystemPromptPayload(files, ctx('system'), { localSettingEnabled: false })!;
    expect(p.metadata.has_claude_local).toBe(true);          // persona compiled...
    expect(p.metadata.settings_local_enabled).toBe(false);   // ...but never wired in → the bug
  });

  it('flags a shared base that is not @imported (analogous composition failure)', () => {
    const broken = { claudeMd: '# Group only, no import\n', claudeLocalMd: 'persona', sharedBase: '# base' };
    const p = buildSystemPromptPayload(broken, ctx('system'), { localSettingEnabled: true })!;
    expect(p.metadata.shared_base_imported).toBe(false);
  });

  it('tolerates missing layers + unknown wiring (best-effort)', () => {
    const p = buildSystemPromptPayload({ claudeMd: '# only claude.md' }, ctx('full'))!;
    expect(p.metadata.has_claude_local).toBe(false);
    expect((p.input as any).claudeLocalMd).toBeNull();
    expect(p.metadata.settings_local_enabled).toBeNull(); // not supplied → unknown, not a false claim
  });
});
