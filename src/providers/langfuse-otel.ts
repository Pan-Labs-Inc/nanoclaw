/**
 * Langfuse observability via Claude Code's native OpenTelemetry — TRACES.
 *
 * Claude Code (spawned by the agent SDK) has built-in OTEL telemetry. We point
 * its OTLP *trace* exporter at Langfuse Cloud, which ingests OTLP spans and
 * reconstructs them as Langfuse traces/observations.
 *
 * IMPORTANT — why traces, not logs (this bit us once): Langfuse's OTLP endpoint
 * accepts ONLY spans (POST /api/public/otel/v1/traces). Claude Code's *default*
 * telemetry emits logs/events + metrics, NOT spans — and Langfuse has no
 * /v1/logs route, so a logs exporter just 404s and nothing ever lands (verified
 * in-container against Langfuse Cloud). Real spans require Claude Code's
 * enhanced-telemetry BETA (CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1 +
 * OTEL_TRACES_EXPORTER=otlp). We enable the beta trace exporter and explicitly
 * disable logs + metrics: logs would 404, and metrics are the
 * cost/throughput-at-scale signal that stays in the product's PostHog pipeline.
 *
 * Flow: host .env (LANGFUSE_*) → this helper → claude provider container
 * contribution → `-e` on the container → agent-runner process.env → SDK `env`
 * option → Claude Code subprocess.
 *
 * Environment: when LANGFUSE_ENVIRONMENT is set, it's emitted as an OTEL
 * *resource* attribute (langfuse.environment) — the one trace field Langfuse
 * promotes from the resource level — so traces are bucketed by deployment
 * (production / uat / …). User and Session are deliberately NOT set here:
 * Langfuse reads those only from per-span attributes, which Claude Code owns
 * and we cannot inject via env. Populating User/Session needs an OTel Collector
 * transform between the container and Langfuse (tracked separately).
 *
 * Prompt/response *content* stays OFF by default (Pan's prompts carry teen
 * conversation data). Opt in with LANGFUSE_LOG_PROMPTS → OTEL_LOG_USER_PROMPTS.
 */

const DEFAULT_LANGFUSE_HOST = 'https://cloud.langfuse.com';

// Langfuse environment names: lowercase letters/digits/-/_, ≤40 chars, and must
// not start with the reserved `langfuse` prefix. Invalid values are dropped
// (Langfuse rejects them and falls back to the "default" bucket anyway).
const LANGFUSE_ENV_RE = /^(?!langfuse)[a-z0-9_-]{1,40}$/;

function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/**
 * Build the OTEL env vars that point Claude Code's TRACE telemetry at Langfuse.
 *
 * Returns `{}` (no-op) unless LANGFUSE_ENABLED is truthy *and* both keys are
 * present — so a half-configured .env never produces a broken exporter.
 */
export function buildLangfuseOtelEnv(env: Record<string, string | undefined>): Record<string, string> {
  if (!isTruthy(env.LANGFUSE_ENABLED)) return {};

  const publicKey = env.LANGFUSE_PUBLIC_KEY?.trim();
  const secretKey = env.LANGFUSE_SECRET_KEY?.trim();
  if (!publicKey || !secretKey) return {};

  const host = (env.LANGFUSE_HOST?.trim() || DEFAULT_LANGFUSE_HOST).replace(/\/+$/, '');
  const auth = Buffer.from(`${publicKey}:${secretKey}`).toString('base64');

  const otel: Record<string, string> = {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    // Spans are emitted only under Claude Code's enhanced-telemetry beta.
    CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '1',
    OTEL_TRACES_EXPORTER: 'otlp',
    // Langfuse has no /v1/logs route (logs 404); metrics belong to PostHog.
    OTEL_LOGS_EXPORTER: 'none',
    OTEL_METRICS_EXPORTER: 'none',
    // HTTP only — Langfuse rejects gRPC, which is the OTEL SDK trace default.
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
    // SDK appends the signal path → {host}/api/public/otel/v1/traces.
    OTEL_EXPORTER_OTLP_ENDPOINT: `${host}/api/public/otel`,
    OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Basic ${auth}`,
  };

  // Environment is the one trace field Langfuse promotes from a *resource*
  // attribute, so it is settable purely through env (unlike user/session).
  const lfEnv = env.LANGFUSE_ENVIRONMENT?.trim().toLowerCase();
  if (lfEnv && LANGFUSE_ENV_RE.test(lfEnv)) {
    otel.OTEL_RESOURCE_ATTRIBUTES = `langfuse.environment=${lfEnv}`;
  }

  if (isTruthy(env.LANGFUSE_LOG_PROMPTS)) {
    otel.OTEL_LOG_USER_PROMPTS = '1';
  }

  return otel;
}
