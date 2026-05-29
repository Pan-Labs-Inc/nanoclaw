/**
 * Langfuse observability via Claude Code's native OpenTelemetry.
 *
 * The claude-agent-sdk spawns the real Claude Code binary, which has built-in
 * OTEL telemetry. Rather than hand-instrument the provider's event stream
 * (which only surfaces init/result/error/compact and would produce a near-empty
 * trace), we point Claude Code's OTLP exporter straight at Langfuse Cloud's
 * ingest endpoint. Claude Code then emits its own per-session events (API
 * requests, tool calls, prompts) over OTLP and Langfuse reconstructs the
 * session — no tracing code on our side, just env wiring.
 *
 * The derived vars flow: host .env (LANGFUSE_*) → this helper → claude provider
 * container contribution → `-e` on the container → agent-runner process.env →
 * spread into the SDK's `env` option → Claude Code subprocess.
 *
 * Deliberately **logs/events only** — no metrics exporter. Metrics are the
 * cost/throughput-at-scale signal (that stays in the product's PostHog
 * pipeline); the events carry the per-session "what did the agent actually do"
 * detail this integration exists for.
 *
 * Prompt/response *content* is off by default: Claude Code only embeds it in
 * events when OTEL_LOG_USER_PROMPTS is set. Because Pan's prompts contain teen
 * conversation data, that is gated behind a separate, explicit opt-in
 * (LANGFUSE_LOG_PROMPTS) so turning tracing on never silently ships message
 * bodies to a third party.
 */

const DEFAULT_LANGFUSE_HOST = 'https://cloud.langfuse.com';

function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/**
 * Build the OTEL env vars that point Claude Code's telemetry at Langfuse.
 *
 * Returns `{}` (no-op) unless LANGFUSE_ENABLED is truthy *and* both keys are
 * present — so a half-configured .env never produces a broken exporter that
 * spams the container logs with failed OTLP posts.
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
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
    OTEL_EXPORTER_OTLP_ENDPOINT: `${host}/api/public/otel`,
    OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Basic ${auth}`,
  };

  if (isTruthy(env.LANGFUSE_LOG_PROMPTS)) {
    otel.OTEL_LOG_USER_PROMPTS = '1';
  }

  return otel;
}
