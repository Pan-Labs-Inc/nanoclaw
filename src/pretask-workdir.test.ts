import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// Repo root, resolved from this file (src/) so the test is cwd-independent.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Guards the container working-directory invariant behind the slow-lane sweep bug
 * (Pan #849 follow-up): a NanoClaw scheduled task's pre-task `script` is spawned by
 * task-script.ts with NO `cwd`, so it inherits the image WORKDIR. The agent itself
 * runs at index.ts `CWD`. Pan hooks (and the projector sweep) resolve their group/dyad
 * from `process.cwd()` via `.pan-group-name`, so the pre-task script ONLY sees the
 * right context when WORKDIR === CWD. They drifted (WORKDIR was the stale, unmounted
 * `/workspace/group`), which made the sweep abort with `no-group-ctx` and silently
 * skip all slow-lane memory synthesis. These assertions go red if they drift again.
 */
describe('container WORKDIR matches the agent CWD (pre-task script context)', () => {
  const dockerfile = readFileSync(resolve(REPO_ROOT, 'container/Dockerfile'), 'utf8');
  const indexTs = readFileSync(resolve(REPO_ROOT, 'container/agent-runner/src/index.ts'), 'utf8');

  const workdir = /^WORKDIR\s+(\S+)\s*$/m.exec(
    // last WORKDIR in the file wins at build time
    dockerfile
      .split('\n')
      .filter((l) => /^WORKDIR\s/.test(l))
      .pop() ?? '',
  )?.[1];
  const cwd = /const\s+CWD\s*=\s*['"]([^'"]+)['"]/.exec(indexTs)?.[1];

  it('Dockerfile final WORKDIR is /workspace/agent (the bind-mounted group dir)', () => {
    expect(workdir).toBe('/workspace/agent');
  });

  it('agent-runner CWD is /workspace/agent', () => {
    expect(cwd).toBe('/workspace/agent');
  });

  it('WORKDIR === CWD so pre-task scripts inherit the same cwd as the agent', () => {
    expect(workdir).toBe(cwd);
  });

  it('does not regress to the stale /workspace/group WORKDIR', () => {
    expect(workdir).not.toBe('/workspace/group');
  });
});
