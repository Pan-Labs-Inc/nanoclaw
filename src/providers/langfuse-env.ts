/**
 * Langfuse container env — host side.
 *
 * Langfuse observability is implemented as an in-process **Stop hook** in the
 * agent-runner (see container/agent-runner/src/providers/langfuse-trace.ts),
 * NOT via Claude Code's native OTEL. The OTEL route shipped a dark integration:
 * Claude Code exports logs/metrics, Langfuse's OTLP endpoint ingests only spans,
 * so traces never landed. The hook reads the transcript JSONL after each turn
 * and pushes structured traces through the Langfuse JS SDK instead.
 *
 * This helper therefore no longer derives OTEL_* vars. It simply forwards the
 * raw Langfuse credentials into the container so the hook can construct its SDK
 * client. Gating mirrors the old behaviour: return `{}` unless LANGFUSE_ENABLED
 * is truthy AND both keys are present, so a half-configured .env never produces
 * a live-but-broken exporter.
 *
 * Prompt/response *content* stays OFF by default (Pan's prompts carry teen
 * conversation data). The hook's three-tier dial, LANGFUSE_LOG_LEVEL
 * (redacted | system | full), and its legacy boolean alias LANGFUSE_LOG_PROMPTS
 * (truthy ⇒ full) are both forwarded so the operator controls exposure from
 * .env. Anything the hook wouldn't recognise is dropped here, so the container
 * always falls back to `redacted`.
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
 * Build the Langfuse env vars to inject into the agent container.
 *
 * Returns `{}` (no-op) unless LANGFUSE_ENABLED is truthy *and* both keys are
 * present. Otherwise forwards the credentials the in-container Stop hook reads:
 * LANGFUSE_ENABLED, LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_HOST,
 * plus optional LANGFUSE_ENVIRONMENT (validated), LANGFUSE_LOG_LEVEL
 * (validated tier), and LANGFUSE_LOG_PROMPTS.
 */
export function buildLangfuseContainerEnv(env: Record<string, string | undefined>): Record<string, string> {
  if (!isTruthy(env.LANGFUSE_ENABLED)) return {};

  const publicKey = env.LANGFUSE_PUBLIC_KEY?.trim();
  const secretKey = env.LANGFUSE_SECRET_KEY?.trim();
  if (!publicKey || !secretKey) return {};

  const host = (env.LANGFUSE_HOST?.trim() || DEFAULT_LANGFUSE_HOST).replace(/\/+$/, '');

  const out: Record<string, string> = {
    LANGFUSE_ENABLED: '1',
    LANGFUSE_PUBLIC_KEY: publicKey,
    LANGFUSE_SECRET_KEY: secretKey,
    LANGFUSE_HOST: host,
  };

  const lfEnv = env.LANGFUSE_ENVIRONMENT?.trim().toLowerCase();
  if (lfEnv && LANGFUSE_ENV_RE.test(lfEnv)) {
    out.LANGFUSE_ENVIRONMENT = lfEnv;
  }

  if (isTruthy(env.LANGFUSE_LOG_PROMPTS)) {
    out.LANGFUSE_LOG_PROMPTS = '1';
  }

  // Forward the privacy-tier dial, normalised the same way the in-container
  // hook's resolveLogLevel reads it. Invalid values are dropped rather than
  // forwarded so the container's safe `redacted` default applies.
  const logLevel = env.LANGFUSE_LOG_LEVEL?.trim().toLowerCase();
  if (logLevel === 'redacted' || logLevel === 'system' || logLevel === 'full') {
    out.LANGFUSE_LOG_LEVEL = logLevel;
  }

  return out;
}
