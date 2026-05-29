/**
 * Unit tests for buildLangfuseOtelEnv.
 *
 * Pins the contract the Langfuse wiring depends on: the exporter stays off
 * unless fully configured; it exports TRACES (spans) via Claude Code's
 * enhanced-telemetry beta — NOT logs (Langfuse has no /v1/logs route, the
 * regression that shipped no data) and NOT metrics; the OTLP endpoint and Basic
 * auth resolve correctly; the environment resource attribute is set/validated;
 * and prompt content stays off unless explicitly opted in (teen-privacy default).
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

describe('buildLangfuseOtelEnv — TRACE exporter (not logs/metrics)', () => {
  it('enables the enhanced-telemetry beta and the OTLP TRACE exporter', () => {
    const env = buildLangfuseOtelEnv(KEYS);
    expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1');
    expect(env.CLAUDE_CODE_ENHANCED_TELEMETRY_BETA).toBe('1');
    expect(env.OTEL_TRACES_EXPORTER).toBe('otlp');
  });

  // Regression guard: a logs exporter POSTs to /v1/logs, which Langfuse 404s —
  // the exact defect that shipped a fully dark integration. Logs MUST be off.
  it('does NOT export logs — Langfuse has no /v1/logs route', () => {
    const env = buildLangfuseOtelEnv(KEYS);
    expect(env.OTEL_LOGS_EXPORTER).toBe('none');
    expect(env.OTEL_LOGS_EXPORTER).not.toBe('otlp');
  });

  it('does NOT export metrics — that is the cost/throughput signal (PostHog)', () => {
    const env = buildLangfuseOtelEnv(KEYS);
    expect(env.OTEL_METRICS_EXPORTER).toBe('none');
  });

  it('forces HTTP/protobuf — Langfuse rejects gRPC (the OTEL trace default)', () => {
    expect(buildLangfuseOtelEnv(KEYS).OTEL_EXPORTER_OTLP_PROTOCOL).toBe('http/protobuf');
  });
});

describe('buildLangfuseOtelEnv — OTLP endpoint + auth', () => {
  it('points the exporter base at Langfuse and authenticates with Basic base64(pk:sk)', () => {
    const env = buildLangfuseOtelEnv(KEYS);
    const expectedAuth = Buffer.from('pk-lf-public:sk-lf-secret').toString('base64');
    // Base endpoint; the SDK appends /v1/traces for the trace signal.
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
});

describe('buildLangfuseOtelEnv — environment resource attribute', () => {
  it('omits OTEL_RESOURCE_ATTRIBUTES when LANGFUSE_ENVIRONMENT is unset', () => {
    expect(buildLangfuseOtelEnv(KEYS).OTEL_RESOURCE_ATTRIBUTES).toBeUndefined();
  });

  it('sets langfuse.environment from LANGFUSE_ENVIRONMENT', () => {
    const env = buildLangfuseOtelEnv({ ...KEYS, LANGFUSE_ENVIRONMENT: 'production' });
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toBe('langfuse.environment=production');
  });

  it('lowercases the environment value', () => {
    const env = buildLangfuseOtelEnv({ ...KEYS, LANGFUSE_ENVIRONMENT: 'UAT' });
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toBe('langfuse.environment=uat');
  });

  it('drops an environment that violates Langfuse naming (spaces, reserved prefix, too long)', () => {
    expect(buildLangfuseOtelEnv({ ...KEYS, LANGFUSE_ENVIRONMENT: 'prod env' }).OTEL_RESOURCE_ATTRIBUTES).toBeUndefined();
    expect(buildLangfuseOtelEnv({ ...KEYS, LANGFUSE_ENVIRONMENT: 'langfuse-x' }).OTEL_RESOURCE_ATTRIBUTES).toBeUndefined();
    expect(buildLangfuseOtelEnv({ ...KEYS, LANGFUSE_ENVIRONMENT: 'x'.repeat(41) }).OTEL_RESOURCE_ATTRIBUTES).toBeUndefined();
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
