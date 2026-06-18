/**
 * Unit tests for buildPosthogContainerEnv.
 *
 * Pins the host-side contract for Pan #961: nothing is forwarded unless a
 * PostHog API key is present; when it is, the container receives exactly the raw
 * credentials the in-container drain + posthog-ship transport read
 * (POSTHOG_API_KEY / POSTHOG_HOST / POSTHOG_ENVIRONMENT_LABEL). Before this
 * module existed, claude.ts forwarded none of these, so the drain's
 * `POSTHOG_API_KEY` gate never fired and the telemetry leg was dark fleet-wide.
 */
import { describe, it, expect } from 'vitest';

import { buildPosthogContainerEnv } from './posthog-env.js';

const KEYS = {
  POSTHOG_API_KEY: 'phc_test',
  POSTHOG_HOST: 'https://us.i.posthog.com',
  POSTHOG_ENVIRONMENT_LABEL: 'staging',
};

describe('buildPosthogContainerEnv — gating', () => {
  it('is a no-op when POSTHOG_API_KEY is unset', () => {
    expect(buildPosthogContainerEnv({ ...KEYS, POSTHOG_API_KEY: undefined })).toEqual({});
  });

  it('is a no-op when POSTHOG_API_KEY is blank/whitespace', () => {
    expect(buildPosthogContainerEnv({ ...KEYS, POSTHOG_API_KEY: '' })).toEqual({});
    expect(buildPosthogContainerEnv({ ...KEYS, POSTHOG_API_KEY: '   ' })).toEqual({});
  });

  it('forwards the key alone when host/label are absent', () => {
    expect(buildPosthogContainerEnv({ POSTHOG_API_KEY: 'phc_test' })).toEqual({
      POSTHOG_API_KEY: 'phc_test',
    });
  });
});

describe('buildPosthogContainerEnv — credential passthrough', () => {
  it('forwards exactly the vars the in-container drain reads', () => {
    expect(buildPosthogContainerEnv(KEYS)).toEqual({
      POSTHOG_API_KEY: 'phc_test',
      POSTHOG_HOST: 'https://us.i.posthog.com',
      POSTHOG_ENVIRONMENT_LABEL: 'staging',
    });
  });

  it('trims surrounding whitespace and a trailing slash on the host', () => {
    const env = buildPosthogContainerEnv({
      POSTHOG_API_KEY: '  phc_test  ',
      POSTHOG_HOST: '  https://us.i.posthog.com/  ',
      POSTHOG_ENVIRONMENT_LABEL: '  production  ',
    });
    expect(env.POSTHOG_API_KEY).toBe('phc_test');
    expect(env.POSTHOG_HOST).toBe('https://us.i.posthog.com');
    expect(env.POSTHOG_ENVIRONMENT_LABEL).toBe('production');
  });

  it('drops POSTHOG_ENVIRONMENT_LABEL when blank (drain falls back to "local")', () => {
    const env = buildPosthogContainerEnv({ POSTHOG_API_KEY: 'phc_test', POSTHOG_ENVIRONMENT_LABEL: '' });
    expect(env).not.toHaveProperty('POSTHOG_ENVIRONMENT_LABEL');
  });

  it('emits NO other vars (no surprise passthrough)', () => {
    const env = buildPosthogContainerEnv({ ...KEYS, POSTHOG_PROJECT_ID: 'leak', SECRET: 'no' } as Record<string, string>);
    expect(Object.keys(env).sort()).toEqual([
      'POSTHOG_API_KEY',
      'POSTHOG_ENVIRONMENT_LABEL',
      'POSTHOG_HOST',
    ]);
  });
});
