/**
 * Integration test for the registered `claude` provider container config.
 *
 * The buildPosthogContainerEnv unit test (posthog-env.test.ts) pins the helper;
 * THIS pins the wiring in claude.ts — that POSTHOG_* host env actually reaches
 * the container `-e` env via the registered provider config. That wiring is the
 * regression surface for Pan #961: the helper can be perfectly correct while
 * claude.ts forwards nothing (the original defect — only ANTHROPIC_BASE_URL +
 * LANGFUSE_* were in the readEnvFile allowlist / Object.assign chain). Deleting
 * the POSTHOG passthrough turns this red.
 *
 * Importing the module registers the config as a side effect; we then resolve it
 * and invoke it with a crafted hostEnv (no .env in cwd → readEnvFile is a no-op,
 * so hostEnv is the sole source).
 */
import { describe, it, expect } from 'vitest';

import './claude.js'; // registers the 'claude' provider container config
import { getProviderContainerConfig } from './provider-container-registry.js';

const cfg = getProviderContainerConfig('claude');

function run(hostEnv: Record<string, string | undefined>) {
  if (!cfg) throw new Error('claude provider container config not registered');
  return cfg({
    sessionDir: '/tmp/v2-sessions/sess',
    agentGroupId: 'pan-teen-test',
    hostEnv: hostEnv as NodeJS.ProcessEnv,
  }).env ?? {};
}

describe('claude provider container config — PostHog passthrough wiring (#961)', () => {
  it('forwards POSTHOG_* from host env into the container env', () => {
    const env = run({
      POSTHOG_API_KEY: 'phc_host',
      POSTHOG_HOST: 'https://us.i.posthog.com',
      POSTHOG_ENVIRONMENT_LABEL: 'staging',
    });
    expect(env.POSTHOG_API_KEY).toBe('phc_host');
    expect(env.POSTHOG_HOST).toBe('https://us.i.posthog.com');
    expect(env.POSTHOG_ENVIRONMENT_LABEL).toBe('staging');
  });

  it('forwards nothing PostHog-shaped when POSTHOG_API_KEY is absent', () => {
    const env = run({ POSTHOG_HOST: 'https://us.i.posthog.com' });
    expect(Object.keys(env).filter((k) => k.startsWith('POSTHOG_'))).toEqual([]);
  });
});
