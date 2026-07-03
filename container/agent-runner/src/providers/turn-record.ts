/**
 * TurnRecord (#1241) — the agent-runner as the single producer of a canonical
 * per-turn record, written incrementally at the SDK-stream seam so downstream
 * consumers (Pan's response-reasoning capture; later, the Langfuse tracer) never
 * again depend on the Claude Code transcript's flush timing relative to hooks.
 *
 * `turn-records.jsonl` lives at the group-dir root (`path.join(cwd, 'turn-records.jsonl')`
 * — the same constant Pan's consumer uses, no env, no negotiation). It holds ONE
 * turn: truncated at every `init`, appended to as the stream produces messages,
 * closed by a `result` (or an `aborted` line if the turn dies mid-stream). Content
 * blocks are copied VERBATIM — no summarization, no redaction. The file never
 * leaves the group dir / trust boundary, so redaction is not this module's job.
 *
 * This module is the pure, testable core (mirrors the langfuse-trace.ts split):
 * `turnRecordLines` maps one SDK stream message to zero-or-more record lines +
 * the next state, with no I/O and no global state. `truncateOnInit` and
 * `appendTurnRecordLines` are the two thin fs wrappers; the stream loop and the
 * abort() wiring live in claude.ts.
 */

import fs from 'fs';

export const TURN_RECORD_FILENAME = 'turn-records.jsonl';

export interface TurnRecordState {
  sessionId: string | null;
  turnSeq: number;
  assistantSeq: number;
}

export const INITIAL_TURN_RECORD_STATE: TurnRecordState = {
  sessionId: null,
  turnSeq: 0,
  assistantSeq: 0,
};

export interface TurnRecordResult {
  /** Record lines to append, in order. Empty when the message maps to nothing. */
  lines: Record<string, unknown>[];
  /** Next state — always returned, even when `lines` is empty. */
  state: TurnRecordState;
  /** True when the file must be truncated BEFORE these lines are appended. */
  truncate: boolean;
}

function unchanged(state: TurnRecordState): TurnRecordResult {
  return { lines: [], state, truncate: false };
}

/**
 * Map one SDK stream message to turn-record lines. Pure — no fs, no Date.now()
 * caller-side timestamping avoided by taking `ts` as a parameter so callers (and
 * tests) control it explicitly.
 *
 * Handles: `system`/`init` (truncation marker + turn_seq increment), `assistant`
 * (content blocks copied verbatim + usage), `user` messages carrying `tool_result`
 * blocks (one line per tool_result, for Langfuse pairing later), and `result`
 * (turn end). Anything else — including a malformed/partial message — maps to no
 * lines and the state is passed through unchanged; this function must never throw.
 */
export function turnRecordLines(message: unknown, state: TurnRecordState, ts: string): TurnRecordResult {
  try {
    return turnRecordLinesUnsafe(message, state, ts);
  } catch {
    return unchanged(state);
  }
}

function turnRecordLinesUnsafe(message: unknown, state: TurnRecordState, ts: string): TurnRecordResult {
  const m = message as { type?: string; subtype?: string; session_id?: string; message?: { content?: unknown; model?: string; usage?: unknown } };

  if (m?.type === 'system' && m.subtype === 'init') {
    const sessionId = typeof m.session_id === 'string' ? m.session_id : null;
    const nextState: TurnRecordState = { sessionId, turnSeq: state.turnSeq + 1, assistantSeq: 0 };
    return {
      lines: [{ type: 'init', session_id: sessionId, turn_seq: nextState.turnSeq, ts }],
      state: nextState,
      truncate: true,
    };
  }

  if (m?.type === 'assistant') {
    const content = m.message?.content;
    if (!Array.isArray(content)) return unchanged(state);
    const nextState: TurnRecordState = { ...state, assistantSeq: state.assistantSeq + 1 };
    const line: Record<string, unknown> = {
      type: 'assistant',
      session_id: state.sessionId,
      turn_seq: state.turnSeq,
      seq: state.assistantSeq,
      ts,
      model: m.message?.model,
      content, // verbatim: thinking | text | tool_use | redacted_thinking, presence never dropped
      usage: usageOf(m.message?.usage),
    };
    return { lines: [line], state: nextState, truncate: false };
  }

  if (m?.type === 'user') {
    const content = m.message?.content;
    if (!Array.isArray(content)) return unchanged(state);
    const lines = content
      .filter((b): b is { type: string; tool_use_id?: string; content?: unknown } => (b as { type?: string })?.type === 'tool_result')
      .map((b) => ({
        type: 'tool_result',
        session_id: state.sessionId,
        turn_seq: state.turnSeq,
        tool_use_id: b.tool_use_id,
        content: b.content,
        ts,
      }));
    return { lines, state, truncate: false };
  }

  if (m?.type === 'result') {
    return {
      lines: [{ type: 'result', session_id: state.sessionId, turn_seq: state.turnSeq, ts }],
      state,
      truncate: false,
    };
  }

  return unchanged(state);
}

function usageOf(u: unknown): Record<string, number> {
  const usage = (u ?? {}) as Record<string, unknown>;
  return {
    input_tokens: numberOr0(usage.input_tokens),
    output_tokens: numberOr0(usage.output_tokens),
    cache_creation_input_tokens: numberOr0(usage.cache_creation_input_tokens),
    cache_read_input_tokens: numberOr0(usage.cache_read_input_tokens),
  };
}

function numberOr0(v: unknown): number {
  return typeof v === 'number' ? v : 0;
}

/** The line appended by `abort()` when a turn dies mid-stream (best-effort). */
export function abortedLine(state: TurnRecordState, ts: string): Record<string, unknown> {
  return { type: 'aborted', session_id: state.sessionId, turn_seq: state.turnSeq, ts };
}

/** Truncate the record file to start a new turn. Caller wraps in try/catch. */
export function truncateOnInit(filePath: string): void {
  fs.writeFileSync(filePath, '');
}

/** Append record lines. Caller wraps in try/catch — never allowed to throw out. */
export function appendTurnRecordLines(filePath: string, lines: Record<string, unknown>[]): void {
  if (lines.length === 0) return;
  const text = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  fs.appendFileSync(filePath, text);
}
