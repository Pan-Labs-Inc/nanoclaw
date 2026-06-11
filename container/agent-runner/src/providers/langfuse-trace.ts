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
 * Privacy is a three-tier dial, `LANGFUSE_LOG_LEVEL`:
 *   - `redacted` (default): teen conversation, tool I/O, injected scaffolding, and
 *     the composed system prompt are all withheld — only trace *structure* (turn
 *     shape, timings, token counts, tool names, model) ships.
 *   - `system`: also ship the composed system prompt (CLAUDE.md / CLAUDE.local.md /
 *     shared base) and the host-injected scaffolding lines (gate imperatives,
 *     cold-open, cross-agent deliveries). The teen↔agent *dialogue* and tool I/O
 *     stay redacted. This is the prod-safe "what's really in the prompt" tier.
 *   - `full`: everything, including dialogue and tool I/O. Intended for the test
 *     environment (synthetic teens), never teen prod.
 * Trace structure is always sent. Thinking blocks are NEVER sent at any tier.
 * `LANGFUSE_LOG_PROMPTS=1` is kept as a back-compat alias for `full`.
 */

import path from 'path';

const DEFAULT_LANGFUSE_HOST = 'https://cloud.langfuse.com';

// Langfuse environment names: lowercase letters/digits/-/_, ≤40 chars, must not
// start with the reserved `langfuse` prefix. Invalid values are dropped.
const LANGFUSE_ENV_RE = /^(?!langfuse)[a-z0-9_-]{1,40}$/;

function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/**
 * Privacy tier for what content (beyond trace structure) is exported. See the
 * module header for the full contract.
 */
export type LogLevel = 'redacted' | 'system' | 'full';

/**
 * Resolve the privacy tier from env. `LANGFUSE_LOG_LEVEL` wins when it names a
 * valid tier; otherwise the legacy `LANGFUSE_LOG_PROMPTS` boolean maps truthy →
 * `full`. Anything unrecognised falls back to the safe default, `redacted`.
 */
export function resolveLogLevel(env: Record<string, string | undefined>): LogLevel {
  const raw = env.LANGFUSE_LOG_LEVEL?.trim().toLowerCase();
  if (raw === 'redacted' || raw === 'system' || raw === 'full') return raw;
  if (isTruthy(env.LANGFUSE_LOG_PROMPTS)) return 'full';
  return 'redacted';
}

/**
 * Resolve the trace `userId`.
 *
 * An explicit `traceUserId` (container-config `trace_user_id` — e.g. Pan sets
 * `{family_id}-{dyad}`, matching its PostHog distinct_id) is operator-assigned,
 * pseudonymous *config*, not conversation content, so it ships at every tier:
 * without it the prod tiers have no per-user axis at all.
 *
 * Absent that, fall back to the implicit agent identity (assistantName, then
 * the workspace dir name). That can expose a per-tenant naming scheme the
 * operator never opted into, so it stays gated to the `full` tier (test env),
 * as before.
 */
export function resolveTraceUserId(opts: {
  traceUserId?: string;
  logLevel: LogLevel;
  assistantName?: string;
  cwd?: string;
}): string | undefined {
  const explicit = opts.traceUserId?.trim();
  if (explicit) return explicit;
  if (opts.logLevel !== 'full') return undefined;
  return opts.assistantName || (opts.cwd ? path.basename(opts.cwd) : undefined);
}

/** Resolved Langfuse configuration, derived once from the container env. */
export interface LangfuseConfig {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
  environment?: string;
  logLevel: LogLevel;
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

  return { publicKey, secretKey, baseUrl, environment, logLevel: resolveLogLevel(env) };
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
 * Redact teen↔agent dialogue and tool I/O unless the tier is `full`. Keeps the
 * *shape* of the data (a length-tagged placeholder) so traces remain useful for
 * debugging structure/flow without exposing conversation text. Note `system` is
 * intentionally as strict as `redacted` here — system-tier exposure is limited to
 * scaffolding (system prompt + injected lines), not the conversation itself.
 */
export function redact(value: unknown, logLevel: LogLevel): unknown {
  if (logLevel === 'full') return value;
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
  /**
   * Host-injected scaffolding that preceded this turn — session-start gate
   * imperatives, the cold-open, cross-agent deliveries. These arrive as `isMeta`
   * user rows. Captured here (not dropped) so the `system` tier can surface what
   * the agent was actually told, which is central to debugging onboarding and
   * cross-agent messaging.
   */
  injected: string[];
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
      // Subagent sidechains are noise here; meta rows are kept — they carry the
      // host-injected scaffolding we want at the `system` tier.
      if (e.isSidechain) continue;
      if (e.type === 'user' || e.type === 'assistant') entries.push(e);
    } catch {
      /* skip unparseable lines */
    }
  }

  const newTurn = (user?: TranscriptEntry): Turn => ({ user, assistants: [], toolResults: new Map(), injected: [] });

  const turns: Turn[] = [];
  let current: Turn | null = null;
  // Injected lines that arrive before any turn this batch (e.g. the session-start
  // imperative) attach to the next real turn rather than spawning a phantom one.
  let pendingInjected: string[] = [];
  for (const e of entries) {
    if (isUserPrompt(e)) {
      current = newTurn(e);
      current.injected = pendingInjected;
      pendingInjected = [];
      turns.push(current);
      continue;
    }
    if (e.type === 'user' && e.isMeta) {
      const t = textOf(e);
      if (t) (current ? current.injected : pendingInjected).push(t);
      continue;
    }
    // Assistant output / tool results before any prompt in this batch belong to
    // a turn whose prompt was consumed earlier — anchor a userless turn so the
    // work is still traced rather than dropped.
    if (!current) {
      current = newTurn();
      current.injected = pendingInjected;
      pendingInjected = [];
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

  // Trailing injected lines with no following turn: attach to the last turn so
  // scaffolding is never silently lost (rare — meta normally precedes a turn).
  if (pendingInjected.length) {
    if (turns.length) turns[turns.length - 1].injected.push(...pendingInjected);
    else turns.push({ ...newTurn(), injected: pendingInjected });
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
  logLevel: LogLevel;
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
  // Scaffolding (the system prompt + injected lines) is exposed at `system` and
  // `full`; dialogue/tool I/O only at `full` (via redact).
  const showScaffold = ctx.logLevel !== 'redacted';

  for (const turn of turns) {
    if (turn.assistants.length === 0 && !turn.user && turn.injected.length === 0) continue;

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
          input: redact(b.input, ctx.logLevel),
          output: redact(turn.toolResults.get(b.id || ''), ctx.logLevel),
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
        output: redact(assistantText, ctx.logLevel),
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
      input: redact(userText, ctx.logLevel),
      output: redact(lastAssistantText, ctx.logLevel),
      metadata: {
        source: 'claude-code',
        assistant_message_count: turn.assistants.length,
        tool_count: generations.reduce((n, g) => n + g.tools.length, 0),
        cc_version: turn.user?.version || turn.assistants[0]?.version,
        injected_count: turn.injected.length,
        // Host-injected scaffolding text — exposed at `system`/`full`, length-tagged
        // otherwise so its presence is still visible without leaking content.
        injected_messages: turn.injected.length
          ? showScaffold
            ? turn.injected
            : `[redacted: ${turn.injected.length} message(s)]`
          : undefined,
      },
      generations,
    });
  }

  return out;
}

// ── System-prompt capture ──

/**
 * The composed system-prompt layers the container actually ran with. NanoClaw v2
 * composes the final `CLAUDE.md` at spawn from the shared base + `CLAUDE.local.md`
 * (the per-family persona Pan compiles). None of this is echoed into the
 * transcript, so it is read from disk by the hook and passed here verbatim.
 */
export interface SystemPromptFiles {
  /** Composed group CLAUDE.md (imports the shared base + the persona). */
  claudeMd?: string;
  /** Per-family persona Pan compiles (the `CLAUDE.local.md` that #611 silently dropped). */
  claudeLocalMd?: string;
  /** Cluster-wide shared base (`.claude-shared.md`, from prompts/pan/global.md). */
  sharedBase?: string;
}

/** Does the composed CLAUDE.md actually `@import` the cluster-wide shared base? */
function importsSharedBase(claudeMd?: string): boolean {
  return !!claudeMd && /@[^\s]*\.claude-shared\.md/.test(claudeMd);
}

/** Optional facts the hook knows but the files don't carry. */
export interface SystemPromptContext {
  /**
   * Whether the SDK's `settingSources` includes `'local'` — the mechanism that
   * loads CLAUDE.local.md. Its absence (not an `@import`) was the #611 root
   * cause, so this is the at-a-glance "persona actually wired in?" signal.
   */
  localSettingEnabled?: boolean;
}

/**
 * Build a once-per-session trace carrying the composed system prompt. Returns
 * `null` at the `redacted` tier (the system prompt is scaffolding, exposed only
 * at `system`/`full`). The id is derived from the session so re-emission upserts
 * rather than duplicates.
 *
 * The "persona never loaded" bug class (#611) shows up as
 * `has_claude_local: true` (the persona was compiled on disk) together with
 * `settings_local_enabled: false` (but the SDK was not told to load it). The
 * shared base loads via an `@import` in CLAUDE.md, so `shared_base_imported`
 * catches the analogous "shared base not wired" failure straight from the file.
 */
export function buildSystemPromptPayload(
  files: SystemPromptFiles,
  ctx: TraceContext,
  opts: SystemPromptContext = {},
): TracePayload | null {
  if (ctx.logLevel === 'redacted') return null;

  const bytes = (s?: string) => (typeof s === 'string' ? s.length : 0);
  const metadata: Record<string, unknown> = {
    source: 'claude-code',
    kind: 'system-prompt',
    has_claude_local: !!files.claudeLocalMd,
    settings_local_enabled: opts.localSettingEnabled ?? null,
    shared_base_imported: importsSharedBase(files.claudeMd),
    claude_md_bytes: bytes(files.claudeMd),
    claude_local_bytes: bytes(files.claudeLocalMd),
    shared_base_bytes: bytes(files.sharedBase),
  };

  return {
    id: `sysprompt-${ctx.sessionId}`,
    name: 'system-prompt',
    sessionId: ctx.sessionId,
    userId: ctx.userId,
    tags: ['claude-code', 'system-prompt', ctx.environment].filter((t): t is string => !!t),
    input: {
      claudeMd: files.claudeMd ?? null,
      claudeLocalMd: files.claudeLocalMd ?? null,
      sharedBase: files.sharedBase ?? null,
    },
    output: undefined,
    metadata,
    generations: [],
  };
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
