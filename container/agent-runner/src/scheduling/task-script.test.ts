import { afterEach, describe, expect, it } from 'bun:test';

import { resolveScriptTimeoutMs } from './task-script.js';

const ORIGINAL = process.env.TASK_SCRIPT_TIMEOUT_MS;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.TASK_SCRIPT_TIMEOUT_MS;
  else process.env.TASK_SCRIPT_TIMEOUT_MS = ORIGINAL;
});

describe('resolveScriptTimeoutMs — pre-task script timeout', () => {
  it('defaults to 10 minutes when the env var is unset', () => {
    delete process.env.TASK_SCRIPT_TIMEOUT_MS;
    expect(resolveScriptTimeoutMs()).toBe(600_000);
  });

  it('honours a valid TASK_SCRIPT_TIMEOUT_MS override', () => {
    process.env.TASK_SCRIPT_TIMEOUT_MS = '30000';
    expect(resolveScriptTimeoutMs()).toBe(30_000);
  });

  it('falls back to the default on a non-numeric override', () => {
    process.env.TASK_SCRIPT_TIMEOUT_MS = 'not-a-number';
    expect(resolveScriptTimeoutMs()).toBe(600_000);
  });

  it('falls back to the default on a non-positive override', () => {
    process.env.TASK_SCRIPT_TIMEOUT_MS = '0';
    expect(resolveScriptTimeoutMs()).toBe(600_000);
    process.env.TASK_SCRIPT_TIMEOUT_MS = '-5';
    expect(resolveScriptTimeoutMs()).toBe(600_000);
  });
});
