/**
 * Claude provider container config.
 *
 * Two concerns live here, both opt-in via .env and both no-ops when unset:
 *
 * 1. Custom Anthropic-compatible endpoint. The real auth token never enters the
 *    container — setup creates an OneCLI generic secret (host-pattern = base URL
 *    hostname, header-name = Authorization, value-format = "Bearer {value}") so
 *    the proxy rewrites the Authorization header on the wire. The container only
 *    needs ANTHROPIC_BASE_URL (so the SDK knows where to call) and a placeholder
 *    ANTHROPIC_AUTH_TOKEN (so the SDK adds an Authorization header for OneCLI to
 *    overwrite). Standard installs hitting api.anthropic.com leave both unset.
 *
 * 2. Langfuse observability. When LANGFUSE_ENABLED is set, forward the Langfuse
 *    credentials into the container (see ./langfuse-env.ts). Tracing itself is an
 *    in-process Stop hook in the agent-runner that reads the transcript and pushes
 *    via the Langfuse JS SDK — NOT Claude Code's native OTEL (which exports
 *    logs/metrics that Langfuse's spans-only OTLP endpoint drops). Container
 *    egress runs through the OneCLI gateway, so the Langfuse host must be
 *    reachable through that proxy with its Authorization header left intact.
 *
 * 3. PostHog product analytics. When POSTHOG_API_KEY is set, forward the PostHog
 *    credentials into the container (see ./posthog-env.ts). The shipping itself
 *    is Pan's in-container drain on the slow projection lane (ADR 030) — without
 *    this passthrough the drain's `POSTHOG_API_KEY` gate is never satisfied and
 *    the whole telemetry leg silently goes dark (Pan #961).
 *
 * This module is imported unconditionally from providers/index.ts so the
 * observability path is available on every install; the endpoint path stays
 * dormant until ANTHROPIC_BASE_URL is configured.
 */
import { readEnvFile } from '../env.js';
import { buildLangfuseContainerEnv } from './langfuse-env.js';
import { buildPosthogContainerEnv } from './posthog-env.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

const LANGFUSE_KEYS = [
  'LANGFUSE_ENABLED',
  'LANGFUSE_PUBLIC_KEY',
  'LANGFUSE_SECRET_KEY',
  'LANGFUSE_HOST',
  'LANGFUSE_LOG_LEVEL',
  'LANGFUSE_LOG_PROMPTS',
  'LANGFUSE_ENVIRONMENT',
];

const POSTHOG_KEYS = ['POSTHOG_API_KEY', 'POSTHOG_HOST', 'POSTHOG_ENVIRONMENT_LABEL', 'POSTHOG_DEBUG_EVENTS'];

registerProviderContainerConfig('claude', (ctx) => {
  const dotenv = readEnvFile(['ANTHROPIC_BASE_URL', ...LANGFUSE_KEYS, ...POSTHOG_KEYS]);
  const env: Record<string, string> = {};

  if (dotenv.ANTHROPIC_BASE_URL) {
    env.ANTHROPIC_BASE_URL = dotenv.ANTHROPIC_BASE_URL;
    env.ANTHROPIC_AUTH_TOKEN = 'placeholder';
  }

  // .env is the configured source (host writes LANGFUSE_* / POSTHOG_* there);
  // fall back to the spawn-time process env so an operator can override ad hoc.
  Object.assign(env, buildLangfuseContainerEnv({ ...ctx.hostEnv, ...dotenv }));
  Object.assign(env, buildPosthogContainerEnv({ ...ctx.hostEnv, ...dotenv }));

  return { env };
});
