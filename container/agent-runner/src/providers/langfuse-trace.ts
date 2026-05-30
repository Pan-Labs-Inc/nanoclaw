/**
 * Langfuse observability via an in-process Claude Code **Stop hook**.
 *
 * Why a hook and not OTEL: Claude Code's native OTEL emits logs/metrics, and
 * Langfuse's OTLP endpoint ingests only spans — so the OTEL route shipped a dark
 * integration (logs 404). The official Langfuse integration is a Stop hook, but
 * it's Python (needs python3 in our node:22-slim image), leans on private SDK
 * internals, and ships zero redaction. Pan carries teen conversation data, so we
 * implement the hook in Node ourselves: it runs AFTER each turn in the long-lived
 * agent-runner process (it cannot hang the live request path), reads the same
 * Claude Code transcript JSONL, and pushes structured traces via the Langfuse JS
 * SDK — with content redaction on by default.
 *
 * This module is the pure, testable core: it turns transcript JSONL into plain
 * `TracePayload` objects and emits them through a minimal Langfuse-client
 * interface. The SDK construction, the offset sidecar, and the hook wiring live
 * in ./claude.ts so this file stays free of I/O and global state.
 *
 * Privacy: message text and tool input/output are replaced with
 * `[redacted: N chars]` unless LANGFUSE_LOG_PROMPTS is truthy. Trace *structure*
 * (turn shape, timings, token counts, tool names, model) is always sent.
 */

const DEFAULT_LANGFUSE_HOST = 'https://cloud.langfuse.com';

// Langfuse environment names: lowercase letters/digits/-/_, ≤40 chars, must not
// start with the reserved `langfuse` prefix. Invalid values are dropped.
const LANGFUSE_ENV_RE = /^(?!langfuse)[a-z0-9_-]{1,40}$/;

function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/** Resolved Langfuse configuration, derived once from the container env. */
export interface LangfuseConfig {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
  environment?: string;
  logPrompts: boolean;
}

/**
 * Resolve Langfuse config from env, or `null` when tracing is off. Mirrors the
 * host-side gating: enabled flag truthy AND both keys present, so a
 * half-configured .env never produces a broken client.
 */
export function resolveLangfuseConfig(env: Record<string, string | undefined>): LangfuseConfig | null {
  if (!isTruthy(env.LANGFUSE_ENABLED)) return null;
  const publicKey = env.LANGFUSE_PUBLIC_KEY?.trim();
  const secretKey = env.LANGFUSE_SECRET_KEY?.trim();
  if (!publicKey || !secretKey) return null;

  const baseUrl = (env.LANGFUSE_HOST?.trim() || DEFAULT_LANGFUSE_HOST).replace(/\/+$/, '');
  const rawEnv = env.LANGFUSE_ENVIRONMENT?.trim().toLowerCase();
  const environment = rawEnv && LANGFUSE_ENV_RE.test(rawEnv) ? rawEnv : undefined;

  return { publicKey, secretKey, baseUrl, environment, logPrompts: isTruthy(env.LANGFUSE_LOG_PROMPTS) };
}

// ── Transcript shapes (a subset of Claude Code's JSONL rows) ──

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  // tool_use
  id?: string;
  name?: string;
  input?: unknown;
  // tool_result
  tool_use_id?: string;
  content?: unknown;
}

interface TranscriptEntry {
  type?: string;
  uuid?: string;
  timestamp?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  version?: string;
  message?: {
    role?: string;
    model?: string;
    content?: string | ContentBlock[];
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}

// ── Redaction ──

/**
 * Redact content unless prompt logging is opted in. Keeps the *shape* of the
 * data (a length-tagged placeholder) so traces remain useful for debugging
 * structure/flow without exposing teen conversation text.
 */
export function redact(value: unknown, logPrompts: boolean): unknown {
  if (logPrompts) return value;
  if (value == null) return value;
  const len = typeof value === 'string' ? value.length : JSON.stringify(value).length;
  return `[redacted: ${len} chars]`;
}

// ── Turn parsing ──

function blocks(entry: TranscriptEntry): ContentBlock[] {
  const c = entry.message?.content;
  if (typeof c === 'string') return c ? [{ type: 'text', text: c }] : [];
  return Array.isArray(c) ? c : [];
}

function textOf(entry: TranscriptEntry): string {
  return blocks(entry)
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}

function isToolResultMessage(entry: TranscriptEntry): boolean {
  return blocks(entry).some((b) => b.type === 'tool_result');
}

/** A real teen/user prompt — not a harness-injected meta line or a tool result. */
function isUserPrompt(entry: TranscriptEntry): boolean {
  return entry.type === 'user' && !entry.isMeta && !isToolResultMessage(entry);
}

interface Turn {
  user?: TranscriptEntry;
  assistants: TranscriptEntry[];
  /** tool_use_id → tool_result content, collected from follow-up user rows. */
  toolResults: Map<string, unknown>;
}

export interface ParseResult {
  turns: Turn[];
  /** Byte offset of the last fully-consumed line; persist to resume. */
  newOffset: number;
}

/**
 * Parse the transcript from `fromOffset` (bytes) into complete turns, advancing
 * the offset only past whole lines. A trailing partial line (no newline yet) is
 * left unconsumed for the next Stop. Unparseable lines, meta lines, and subagent
 * sidechains are skipped.
 */
export function parseTranscriptTurns(fullContent: string, fromOffset: number): ParseResult {
  const buf = Buffer.from(fullContent, 'utf8');
  const safeOffset = Math.min(Math.max(fromOffset, 0), buf.length);
  const fresh = buf.subarray(safeOffset).toString('utf8');

  const rawLines = fresh.split('\n');
  // Drop the trailing element: either the '' after a final newline, or a
  // partial line still being written. Both must not be consumed.
  rawLines.pop();
  const completeLines = rawLines;
  const consumedBytes = completeLines.length ? Buffer.byteLength(completeLines.join('\n') + '\n', 'utf8') : 0;

  const entries: TranscriptEntry[] = [];
  for (const line of completeLines) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as TranscriptEntry;
      if (e.isMeta || e.isSidechain) continue;
      if (e.type === 'user' || e.type === 'assistant') entries.push(e);
    } catch {
      /* skip unparseable lines */
    }
  }

  const turns: Turn[] = [];
  let current: Turn | null = null;
  for (const e of entries) {
    if (isUserPrompt(e)) {
      current = { user: e, assistants: [], toolResults: new Map() };
      turns.push(current);
      continue;
    }
    // Assistant output / tool results before any prompt in this batch belong to
    // a turn whose prompt was consumed earlier — anchor a userless turn so the
    // work is still traced rather than dropped.
    if (!current) {
      current = { assistants: [], toolResults: new Map() };
      turns.push(current);
    }
    if (e.type === 'assistant') {
      current.assistants.push(e);
    } else if (e.type === 'user') {
      for (const b of blocks(e)) {
        if (b.type === 'tool_result' && b.tool_use_id) current.toolResults.set(b.tool_use_id, b.content);
      }
    }
  }

  return { turns, newOffset: safeOffset + consumedBytes };
}

// ── Trace payloads (SDK-agnostic) ──

export interface ToolPayload {
  id: string;
  name: string;
  startTime: Date;
  input: unknown;
  output: unknown;
}

export interface GenerationPayload {
  id: string;
  name: string;
  model?: string;
  startTime: Date;
  usage?: { input?: number; output?: number; total?: number; unit: 'TOKENS' };
  output: unknown;
  metadata: Record<string, unknown>;
  tools: ToolPayload[];
}

export interface TracePayload {
  id: string;
  name: string;
  sessionId: string;
  userId?: string;
  tags: string[];
  timestamp?: Date;
  input: unknown;
  output: unknown;
  metadata: Record<string, unknown>;
  generations: GenerationPayload[];
}

export interface TraceContext {
  sessionId: string;
  userId?: string;
  environment?: string;
  logPrompts: boolean;
}

function parseDate(ts?: string): Date | undefined {
  if (!ts) return undefined;
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

let synthCounter = 0;

/** Map parsed turns to plain trace payloads. No SDK, no I/O — pure transform. */
export function buildTracePayloads(turns: Turn[], ctx: TraceContext): TracePayload[] {
  const out: TracePayload[] = [];

  for (const turn of turns) {
    if (turn.assistants.length === 0 && !turn.user) continue;

    const anchorId = turn.user?.uuid || turn.assistants[0]?.uuid || `synth-${ctx.sessionId}-${synthCounter++}`;
    const userText = turn.user ? textOf(turn.user) : '';
    let lastAssistantText = '';

    const generations: GenerationPayload[] = turn.assistants.map((a, i) => {
      const assistantText = textOf(a);
      if (assistantText) lastAssistantText = assistantText;

      const tools: ToolPayload[] = blocks(a)
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({
          id: b.id || `${a.uuid}-tool-${b.name}`,
          name: b.name || 'tool',
          startTime: parseDate(a.timestamp) || new Date(0),
          input: redact(b.input, ctx.logPrompts),
          output: redact(turn.toolResults.get(b.id || ''), ctx.logPrompts),
        }));

      const u = a.message?.usage;
      const usage = u
        ? {
            input: u.input_tokens,
            output: u.output_tokens,
            total: (u.input_tokens || 0) + (u.output_tokens || 0),
            unit: 'TOKENS' as const,
          }
        : undefined;

      return {
        id: a.uuid || `${anchorId}-gen-${i}`,
        name: 'assistant-message',
        model: a.message?.model,
        startTime: parseDate(a.timestamp) || new Date(0),
        usage,
        output: redact(assistantText, ctx.logPrompts),
        metadata: {
          cache_read_input_tokens: u?.cache_read_input_tokens,
          cache_creation_input_tokens: u?.cache_creation_input_tokens,
          tool_count: tools.length,
        },
        tools,
      };
    });

    out.push({
      id: anchorId,
      name: 'agent-turn',
      sessionId: ctx.sessionId,
      userId: ctx.userId,
      tags: ['claude-code', ctx.environment].filter((t): t is string => !!t),
      timestamp: parseDate(turn.user?.timestamp),
      input: redact(userText, ctx.logPrompts),
      output: redact(lastAssistantText, ctx.logPrompts),
      metadata: {
        source: 'claude-code',
        assistant_message_count: turn.assistants.length,
        tool_count: generations.reduce((n, g) => n + g.tools.length, 0),
        cc_version: turn.user?.version || turn.assistants[0]?.version,
      },
      generations,
    });
  }

  return out;
}

// ── Emission (minimal Langfuse-client interface, so the SDK stays in claude.ts) ──

interface ObservationClient {
  span(body: Record<string, unknown>): unknown;
}
interface TraceClient extends ObservationClient {
  generation(body: Record<string, unknown>): ObservationClient;
}
export interface LangfuseLike {
  trace(body: Record<string, unknown>): TraceClient;
}

/** Emit payloads through the Langfuse client. Idempotent: observation ids come
 *  from transcript uuids, so Langfuse upserts rather than duplicates. */
export function emitTracePayloads(client: LangfuseLike, payloads: TracePayload[]): number {
  let emitted = 0;
  for (const t of payloads) {
    const trace = client.trace({
      id: t.id,
      name: t.name,
      sessionId: t.sessionId,
      userId: t.userId,
      tags: t.tags,
      timestamp: t.timestamp,
      input: t.input,
      output: t.output,
      metadata: t.metadata,
    });
    for (const g of t.generations) {
      const gen = trace.generation({
        id: g.id,
        name: g.name,
        model: g.model,
        startTime: g.startTime,
        usage: g.usage,
        output: g.output,
        metadata: g.metadata,
      });
      for (const tool of g.tools) {
        gen.span({
          id: tool.id,
          name: tool.name,
          startTime: tool.startTime,
          input: tool.input,
          output: tool.output,
        });
      }
    }
    emitted++;
  }
  return emitted;
}
