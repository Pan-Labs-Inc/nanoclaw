/**
 * PostHog container env — host side.
 *
 * Pan's product analytics (onboarding/gate funnels, gate metrics, alpha-tester
 * nudges) are shipped by an **in-container drain** on the slow projection lane
 * (Pan's scripts/hooks/container/sweep-dispatch.js, ADR 030 — the host
 * posthog-forwarder daemon is decommissioned). That drain is gated on
 * `POSTHOG_API_KEY` being present *inside the agent container*, so unless the
 * host forwards the credential, the drain silently no-ops on every sweep and the
 * entire telemetry leg goes dark (Pan #961).
 *
 * Like ./langfuse-env.ts, this helper just forwards the raw credentials the
 * in-container code reads — there is no NanoClaw-side PostHog client. It mirrors
 * the Langfuse gating shape: return `{}` unless the credential is present, so a
 * keyless install (local / lima / a dev box with no PostHog) never carries a
 * half-configured env. Container egress runs through the OneCLI gateway, so the
 * PostHog host must be reachable through that proxy with its Authorization header
 * left intact.
 *
 * Vars forwarded (the exact set the drain + posthog-ship transport read):
 *   - POSTHOG_API_KEY          (required — the drain's gate and the client key)
 *   - POSTHOG_HOST             (optional — the client defaults to us.i.posthog.com)
 *   - POSTHOG_ENVIRONMENT_LABEL (optional — the event `environment` bucket; without
 *                               it every event mis-buckets to "local" even on
 *                               staging/production)
 *   - POSTHOG_DEBUG_EVENTS     (optional — Pan's ops-noise dial, Pan #1447: truthy
 *                               ships the debug-class plumbing events; absent, the
 *                               in-container gates ship only the production set)
 */

/**
 * Build the PostHog env vars to inject into the agent container.
 *
 * Returns `{}` (no-op) unless POSTHOG_API_KEY is present and non-blank. Otherwise
 * forwards the key plus POSTHOG_HOST / POSTHOG_ENVIRONMENT_LABEL when set.
 */
export function buildPosthogContainerEnv(env: Record<string, string | undefined>): Record<string, string> {
  const apiKey = env.POSTHOG_API_KEY?.trim();
  if (!apiKey) return {};

  const out: Record<string, string> = {
    POSTHOG_API_KEY: apiKey,
  };

  const host = env.POSTHOG_HOST?.trim();
  if (host) out.POSTHOG_HOST = host.replace(/\/+$/, '');

  const label = env.POSTHOG_ENVIRONMENT_LABEL?.trim();
  if (label) out.POSTHOG_ENVIRONMENT_LABEL = label;

  const debugEvents = env.POSTHOG_DEBUG_EVENTS?.trim();
  if (debugEvents) out.POSTHOG_DEBUG_EVENTS = debugEvents;

  return out;
}
