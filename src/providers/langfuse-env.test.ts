/**
 * Unit tests for buildLangfuseContainerEnv.
 *
 * Pins the host-side contract: nothing is forwarded unless Langfuse is fully
 * configured; the container receives the raw credentials the in-process Stop
 * hook needs (NOT OTEL_* vars — that route shipped a dark integration); the
 * environment value is validated; and prompt content stays off unless explicitly
 * opted in (teen-privacy default).
 */
import { describe, it, expect } from 'vitest';

import { buildLangfuseContainerEnv } from './langfuse-env.js';

const KEYS = {
  LANGFUSE_ENABLED: '1',
  LANGFUSE_PUBLIC_KEY: 'pk-lf-public',
  LANGFUSE_SECRET_KEY: 'sk-lf-secret',
  LANGFUSE_HOST: 'https://us.cloud.langfuse.com',
};

describe('buildLangfuseContainerEnv — gating', () => {
  it('is a no-op when LANGFUSE_ENABLED is unset', () => {
    expect(buildLangfuseContainerEnv({ ...KEYS, LANGFUSE_ENABLED: undefined })).toEqual({});
  });

  it('is a no-op when LANGFUSE_ENABLED is falsy', () => {
    expect(buildLangfuseContainerEnv({ ...KEYS, LANGFUSE_ENABLED: 'false' })).toEqual({});
    expect(buildLangfuseContainerEnv({ ...KEYS, LANGFUSE_ENABLED: '0' })).toEqual({});
  });

  it('is a no-op when enabled but a key is missing (no half-configured client)', () => {
    expect(buildLangfuseContainerEnv({ ...KEYS, LANGFUSE_PUBLIC_KEY: undefined })).toEqual({});
    expect(buildLangfuseContainerEnv({ ...KEYS, LANGFUSE_SECRET_KEY: '' })).toEqual({});
  });

  it('accepts assorted truthy spellings of LANGFUSE_ENABLED', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'on']) {
      expect(buildLangfuseContainerEnv({ ...KEYS, LANGFUSE_ENABLED: v }).LANGFUSE_ENABLED).toBe('1');
    }
  });
});

describe('buildLangfuseContainerEnv — credential passthrough (no OTEL)', () => {
  it('forwards the raw credentials the in-container hook reads', () => {
    const env = buildLangfuseContainerEnv(KEYS);
    expect(env).toEqual({
      LANGFUSE_ENABLED: '1',
      LANGFUSE_PUBLIC_KEY: 'pk-lf-public',
      LANGFUSE_SECRET_KEY: 'sk-lf-secret',
      LANGFUSE_HOST: 'https://us.cloud.langfuse.com',
    });
  });

  // Regression guard: the OTEL route (logs→/v1/logs 404) shipped no data. The
  // hook approach must NOT emit any OTEL_* / telemetry env.
  it('emits NO OTEL_* or CLAUDE_CODE telemetry vars', () => {
    const env = buildLangfuseContainerEnv(KEYS);
    for (const k of Object.keys(env)) {
      expect(k.startsWith('OTEL_')).toBe(false);
      expect(k.startsWith('CLAUDE_CODE_')).toBe(false);
    }
  });

  it('defaults the host to Langfuse Cloud when LANGFUSE_HOST is unset', () => {
    expect(buildLangfuseContainerEnv({ ...KEYS, LANGFUSE_HOST: undefined }).LANGFUSE_HOST).toBe(
      'https://cloud.langfuse.com',
    );
  });

  it('strips a trailing slash from LANGFUSE_HOST', () => {
    expect(buildLangfuseContainerEnv({ ...KEYS, LANGFUSE_HOST: 'https://us.cloud.langfuse.com/' }).LANGFUSE_HOST).toBe(
      'https://us.cloud.langfuse.com',
    );
  });
});

describe('buildLangfuseContainerEnv — environment', () => {
  it('omits LANGFUSE_ENVIRONMENT when unset', () => {
    expect(buildLangfuseContainerEnv(KEYS).LANGFUSE_ENVIRONMENT).toBeUndefined();
  });

  it('forwards a lowercased, validated environment', () => {
    expect(buildLangfuseContainerEnv({ ...KEYS, LANGFUSE_ENVIRONMENT: 'Production' }).LANGFUSE_ENVIRONMENT).toBe(
      'production',
    );
  });

  it('drops an environment that violates Langfuse naming', () => {
    expect(
      buildLangfuseContainerEnv({ ...KEYS, LANGFUSE_ENVIRONMENT: 'prod env' }).LANGFUSE_ENVIRONMENT,
    ).toBeUndefined();
    expect(
      buildLangfuseContainerEnv({ ...KEYS, LANGFUSE_ENVIRONMENT: 'langfuse-x' }).LANGFUSE_ENVIRONMENT,
    ).toBeUndefined();
    expect(
      buildLangfuseContainerEnv({ ...KEYS, LANGFUSE_ENVIRONMENT: 'x'.repeat(41) }).LANGFUSE_ENVIRONMENT,
    ).toBeUndefined();
  });
});

describe('buildLangfuseContainerEnv — prompt-content privacy', () => {
  it('does not forward LANGFUSE_LOG_PROMPTS by default', () => {
    expect(buildLangfuseContainerEnv(KEYS).LANGFUSE_LOG_PROMPTS).toBeUndefined();
  });

  it('forwards LANGFUSE_LOG_PROMPTS only when explicitly opted in', () => {
    expect(buildLangfuseContainerEnv({ ...KEYS, LANGFUSE_LOG_PROMPTS: '1' }).LANGFUSE_LOG_PROMPTS).toBe('1');
  });
});

// Regression guard for the dead-dial bug (Pan #712): the host .env carried
// LANGFUSE_LOG_LEVEL=full but the container hook's resolveLogLevel never saw it
// because this function silently dropped the var — every observation stayed
// `[redacted]` regardless of the operator's setting.
describe('buildLangfuseContainerEnv — LANGFUSE_LOG_LEVEL forwarding (Pan #712)', () => {
  it('omits LANGFUSE_LOG_LEVEL when unset', () => {
    expect(buildLangfuseContainerEnv(KEYS).LANGFUSE_LOG_LEVEL).toBeUndefined();
  });

  it('forwards each valid tier so the in-container hook sees the dial', () => {
    for (const tier of ['redacted', 'system', 'full']) {
      expect(buildLangfuseContainerEnv({ ...KEYS, LANGFUSE_LOG_LEVEL: tier }).LANGFUSE_LOG_LEVEL).toBe(tier);
    }
  });

  it('normalises case and whitespace to match resolveLogLevel', () => {
    expect(buildLangfuseContainerEnv({ ...KEYS, LANGFUSE_LOG_LEVEL: ' Full ' }).LANGFUSE_LOG_LEVEL).toBe('full');
  });

  it('drops an unrecognised tier (container falls back to redacted)', () => {
    expect(buildLangfuseContainerEnv({ ...KEYS, LANGFUSE_LOG_LEVEL: 'verbose' }).LANGFUSE_LOG_LEVEL).toBeUndefined();
    expect(buildLangfuseContainerEnv({ ...KEYS, LANGFUSE_LOG_LEVEL: '' }).LANGFUSE_LOG_LEVEL).toBeUndefined();
  });
});
