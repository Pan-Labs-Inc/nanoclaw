/**
 * Unit tests for buildLangfuseOtelEnv.
 *
 * Pins the contract that the Langfuse-over-OTEL wiring depends on: the exporter
 * stays off unless fully configured (so a half-set .env never spams failed OTLP
 * posts), the OTLP endpoint resolves to Langfuse's ingest path, the auth header
 * is Basic base64(pk:sk), metrics are deliberately omitted, and prompt-content
 * logging is off unless explicitly opted in (teen-data privacy default).
 */
import { describe, it, expect } from 'vitest';

import { buildLangfuseOtelEnv } from './langfuse-otel.js';

const KEYS = {
  LANGFUSE_ENABLED: '1',
  LANGFUSE_PUBLIC_KEY: 'pk-lf-public',
  LANGFUSE_SECRET_KEY: 'sk-lf-secret',
  LANGFUSE_HOST: 'https://us.cloud.langfuse.com',
};

describe('buildLangfuseOtelEnv — gating', () => {
  it('is a no-op when LANGFUSE_ENABLED is unset', () => {
    expect(buildLangfuseOtelEnv({ ...KEYS, LANGFUSE_ENABLED: undefined })).toEqual({});
  });

  it('is a no-op when LANGFUSE_ENABLED is falsy', () => {
    expect(buildLangfuseOtelEnv({ ...KEYS, LANGFUSE_ENABLED: 'false' })).toEqual({});
    expect(buildLangfuseOtelEnv({ ...KEYS, LANGFUSE_ENABLED: '0' })).toEqual({});
  });

  it('is a no-op when enabled but a key is missing (no broken exporter)', () => {
    expect(buildLangfuseOtelEnv({ ...KEYS, LANGFUSE_PUBLIC_KEY: undefined })).toEqual({});
    expect(buildLangfuseOtelEnv({ ...KEYS, LANGFUSE_SECRET_KEY: '' })).toEqual({});
  });

  it('accepts assorted truthy spellings of LANGFUSE_ENABLED', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'on']) {
      expect(buildLangfuseOtelEnv({ ...KEYS, LANGFUSE_ENABLED: v }).CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1');
    }
  });
});

describe('buildLangfuseOtelEnv — OTLP wiring', () => {
  it('points the OTLP exporter at Langfuse and authenticates with Basic base64(pk:sk)', () => {
    const env = buildLangfuseOtelEnv(KEYS);
    const expectedAuth = Buffer.from('pk-lf-public:sk-lf-secret').toString('base64');

    expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1');
    expect(env.OTEL_LOGS_EXPORTER).toBe('otlp');
    expect(env.OTEL_EXPORTER_OTLP_PROTOCOL).toBe('http/protobuf');
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('https://us.cloud.langfuse.com/api/public/otel');
    expect(env.OTEL_EXPORTER_OTLP_HEADERS).toBe(`Authorization=Basic ${expectedAuth}`);
  });

  it('defaults the host to Langfuse Cloud when LANGFUSE_HOST is unset', () => {
    const env = buildLangfuseOtelEnv({ ...KEYS, LANGFUSE_HOST: undefined });
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('https://cloud.langfuse.com/api/public/otel');
  });

  it('strips a trailing slash from LANGFUSE_HOST so the path is not doubled', () => {
    const env = buildLangfuseOtelEnv({ ...KEYS, LANGFUSE_HOST: 'https://us.cloud.langfuse.com/' });
    expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('https://us.cloud.langfuse.com/api/public/otel');
  });

  it('does NOT export metrics — events only, not cost/throughput telemetry', () => {
    const env = buildLangfuseOtelEnv(KEYS);
    expect(env.OTEL_METRICS_EXPORTER).toBeUndefined();
  });
});

describe('buildLangfuseOtelEnv — prompt-content privacy', () => {
  it('does not log prompt content by default', () => {
    expect(buildLangfuseOtelEnv(KEYS).OTEL_LOG_USER_PROMPTS).toBeUndefined();
  });

  it('logs prompt content only when LANGFUSE_LOG_PROMPTS is explicitly opted in', () => {
    expect(buildLangfuseOtelEnv({ ...KEYS, LANGFUSE_LOG_PROMPTS: '1' }).OTEL_LOG_USER_PROMPTS).toBe('1');
  });
});
