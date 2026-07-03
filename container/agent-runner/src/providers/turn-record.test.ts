/**
 * Tests for the TurnRecord pure core (#1241): SDK stream message → turn-record
 * lines. Would-fail-pre-fix assertions:
 *  - content blocks (thinking/text/tool_use/redacted_thinking) copied verbatim,
 *    nothing dropped;
 *  - `turn_seq` increments on `init` and the file-truncation marker fires only
 *    there;
 *  - `tool_result` blocks in a `user` message pair via `tool_use_id`;
 *  - a malformed/unrecognized message never throws and never emits a line.
 */
import { describe, it, expect } from 'bun:test';

import {
  turnRecordLines,
  abortedLine,
  INITIAL_TURN_RECORD_STATE,
  type TurnRecordState,
} from './turn-record.js';

const TS = '2026-07-03T00:00:00.000Z';

const init = (sessionId: string) => ({ type: 'system', subtype: 'init', session_id: sessionId });
const assistant = (content: unknown[], usage?: object) => ({
  type: 'assistant',
  message: { model: 'claude-sonnet-5', content, usage },
});
const userToolResult = (toolUseId: string, content: unknown) => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] },
});
const result = () => ({ type: 'result', result: 'done' });

describe('turnRecordLines — init', () => {
  it('increments turn_seq, resets sequencing, and signals truncation', () => {
    const r1 = turnRecordLines(init('sess-1'), INITIAL_TURN_RECORD_STATE, TS);
    expect(r1.truncate).toBe(true);
    expect(r1.lines).toEqual([{ type: 'init', session_id: 'sess-1', turn_seq: 1, ts: TS }]);
    expect(r1.state).toEqual({ sessionId: 'sess-1', turnSeq: 1, assistantSeq: 0 });

    const r2 = turnRecordLines(init('sess-1'), r1.state, TS);
    expect(r2.lines[0].turn_seq).toBe(2);
    expect(r2.truncate).toBe(true);
  });
});

describe('turnRecordLines — assistant', () => {
  it('copies content blocks verbatim, including thinking + redacted_thinking + tool_use', () => {
    const state = turnRecordLines(init('sess-1'), INITIAL_TURN_RECORD_STATE, TS).state;
    const content = [
      { type: 'thinking', thinking: 'internal monologue' },
      { type: 'redacted_thinking' },
      { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/workspace/teen/self/profile.md' } },
      { type: 'text', text: 'hello there' },
    ];
    const r = turnRecordLines(assistant(content, { input_tokens: 10, output_tokens: 5 }), state, TS);
    expect(r.truncate).toBe(false);
    expect(r.lines).toHaveLength(1);
    const line = r.lines[0];
    expect(line.type).toBe('assistant');
    expect(line.session_id).toBe('sess-1');
    expect(line.turn_seq).toBe(1);
    expect(line.seq).toBe(0);
    expect(line.content).toEqual(content); // verbatim — nothing dropped or summarized
    expect(line.usage).toEqual({
      input_tokens: 10, output_tokens: 5,
      cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
    });
  });

  it('increments seq across consecutive assistant messages within one turn', () => {
    const s0 = turnRecordLines(init('sess-1'), INITIAL_TURN_RECORD_STATE, TS).state;
    const r1 = turnRecordLines(assistant([{ type: 'text', text: 'a' }]), s0, TS);
    const r2 = turnRecordLines(assistant([{ type: 'text', text: 'b' }]), r1.state, TS);
    expect(r1.lines[0].seq).toBe(0);
    expect(r2.lines[0].seq).toBe(1);
  });
});

describe('turnRecordLines — tool_result pairing', () => {
  it('emits one tool_result line per block, keyed by tool_use_id', () => {
    const state = turnRecordLines(init('sess-1'), INITIAL_TURN_RECORD_STATE, TS).state;
    const r = turnRecordLines(userToolResult('toolu_1', 'file contents'), state, TS);
    expect(r.lines).toEqual([{
      type: 'tool_result', session_id: 'sess-1', turn_seq: 1, tool_use_id: 'toolu_1', content: 'file contents', ts: TS,
    }]);
  });

  it('a plain user message (no tool_result blocks) yields no lines', () => {
    const state = turnRecordLines(init('sess-1'), INITIAL_TURN_RECORD_STATE, TS).state;
    const r = turnRecordLines({ type: 'user', message: { content: 'plain string content' } }, state, TS);
    expect(r.lines).toEqual([]);
    expect(r.state).toEqual(state);
  });
});

describe('turnRecordLines — result', () => {
  it('emits a result line carrying the current turn_seq, state unchanged', () => {
    const state = turnRecordLines(init('sess-1'), INITIAL_TURN_RECORD_STATE, TS).state;
    const r = turnRecordLines(result(), state, TS);
    expect(r.lines).toEqual([{ type: 'result', session_id: 'sess-1', turn_seq: 1, ts: TS }]);
    expect(r.state).toEqual(state);
  });
});

describe('turnRecordLines — malformed / unrecognized messages never throw', () => {
  for (const bad of [null, undefined, {}, { type: 'assistant' }, { type: 'assistant', message: {} }, 'a string', 42, { type: 'system', subtype: 'compact_boundary' }]) {
    it(`handles ${JSON.stringify(bad)} with no lines and no throw`, () => {
      const state: TurnRecordState = { sessionId: 'sess-1', turnSeq: 3, assistantSeq: 2 };
      expect(() => turnRecordLines(bad, state, TS)).not.toThrow();
      const r = turnRecordLines(bad, state, TS);
      expect(r.lines).toEqual([]);
      expect(r.state).toEqual(state);
      expect(r.truncate).toBe(false);
    });
  }
});

describe('abortedLine', () => {
  it('carries the current session/turn_seq at abort time', () => {
    const state: TurnRecordState = { sessionId: 'sess-9', turnSeq: 4, assistantSeq: 1 };
    expect(abortedLine(state, TS)).toEqual({ type: 'aborted', session_id: 'sess-9', turn_seq: 4, ts: TS });
  });
});
