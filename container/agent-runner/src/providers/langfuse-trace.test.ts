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
  redact,
  parseTranscriptTurns,
  buildTracePayloads,
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
    expect(cfg).toMatchObject({ publicKey: 'pk-lf-public', secretKey: 'sk-lf-secret', baseUrl: 'https://us.cloud.langfuse.com', logPrompts: false });
    expect(resolveLangfuseConfig({ ...KEYS, LANGFUSE_HOST: undefined })!.baseUrl).toBe('https://cloud.langfuse.com');
    for (const v of ['1', 'true', 'TRUE', 'yes', 'on']) {
      expect(resolveLangfuseConfig({ ...KEYS, LANGFUSE_ENABLED: v })).not.toBeNull();
    }
  });

  it('validates/normalizes the environment and reads logPrompts', () => {
    expect(resolveLangfuseConfig({ ...KEYS, LANGFUSE_ENVIRONMENT: 'Production' })!.environment).toBe('production');
    expect(resolveLangfuseConfig({ ...KEYS, LANGFUSE_ENVIRONMENT: 'bad env' })!.environment).toBeUndefined();
    expect(resolveLangfuseConfig({ ...KEYS, LANGFUSE_ENVIRONMENT: 'langfuse-x' })!.environment).toBeUndefined();
    expect(resolveLangfuseConfig({ ...KEYS, LANGFUSE_LOG_PROMPTS: '1' })!.logPrompts).toBe(true);
  });
});

describe('redact', () => {
  it('replaces strings with a length-tagged placeholder by default', () => {
    expect(redact('hello', false)).toBe('[redacted: 5 chars]');
    expect(redact({ command: 'rm -rf' }, false)).toMatch(/^\[redacted: \d+ chars\]$/);
  });
  it('passes content through when logPrompts is true', () => {
    expect(redact('hello', true)).toBe('hello');
    expect(redact({ a: 1 }, true)).toEqual({ a: 1 });
  });
  it('leaves null/undefined untouched', () => {
    expect(redact(undefined, false)).toBeUndefined();
    expect(redact(null, false)).toBeNull();
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

  it('skips meta, sidechain, and unparseable lines without throwing', () => {
    const content =
      [
        JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: 'caveat' } }),
        '{not json',
        JSON.stringify({ type: 'assistant', isSidechain: true, uuid: 'sx', message: { role: 'assistant', content: [{ type: 'text', text: 'subagent' }] } }),
        userLine('real prompt', 'u9'),
        assistantLine({ uuid: 'a9', text: 'real reply' }),
      ].join('\n') + '\n';
    const { turns } = parseTranscriptTurns(content, 0);
    expect(turns).toHaveLength(1);
    expect(turns[0].user?.uuid).toBe('u9');
  });
});

describe('buildTracePayloads — mapping + privacy', () => {
  const ctx = { sessionId: 'sess-abc', userId: 'Pan', environment: 'production', logPrompts: false };
  const build = (logPrompts = false) =>
    buildTracePayloads(parseTranscriptTurns(fullTurn(), 0).turns, { ...ctx, logPrompts });

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
    const [trace] = build(true); // logPrompts on so we can see the real values
    const toolGen = trace.generations.find((g) => g.tools.length > 0)!;
    expect(toolGen.tools[0].name).toBe('Bash');
    expect(toolGen.tools[0].input).toEqual({ command: 'curl wttr.in' });
    expect(toolGen.tools[0].output).toBe('sunny, 72F');
  });

  it('REDACTS prompt, response, and tool I/O by default (teen-privacy gate)', () => {
    const [trace] = build(false);
    expect(String(trace.input)).toMatch(/^\[redacted: \d+ chars\]$/); // length-tagged, not raw
    expect(String(trace.input)).not.toContain('weather');
    expect(String(trace.output)).not.toContain('sunny');
    const tool = trace.generations.find((g) => g.tools.length > 0)!.tools[0];
    expect(String(tool.input)).toMatch(/^\[redacted:/);
    expect(String(tool.output)).toMatch(/^\[redacted:/);
  });

  it('includes raw content only when logPrompts is opted in', () => {
    const [trace] = build(true);
    expect(trace.input).toBe('what is the weather');
    expect(trace.output).toBe("It's sunny and 72F.");
  });

  it('NEVER includes thinking-block text — even with logPrompts on', () => {
    const content =
      userLine('hi', 'u1') + '\n' +
      assistantLine({ uuid: 'a1', thinking: 'SECRET internal reasoning about the teen', text: 'hello there' }) + '\n';
    const turns = parseTranscriptTurns(content, 0).turns;
    const blob = JSON.stringify(buildTracePayloads(turns, { sessionId: 's', logPrompts: true }));
    expect(blob).not.toContain('SECRET');
    expect(blob).toContain('hello there'); // assistant text still flows when opted in
  });

  it('omits userId when the caller does not supply one (privacy default)', () => {
    const [trace] = buildTracePayloads(parseTranscriptTurns(fullTurn(), 0).turns, {
      sessionId: 's', logPrompts: false,
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
      sessionId: 's', logPrompts: false,
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
