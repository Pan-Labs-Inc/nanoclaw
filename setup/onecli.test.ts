import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Regression: `curl … | sh` reports SH's exit status, not curl's.
 *
 * When the download fails, sh reads empty stdin and exits 0. The installer
 * therefore "succeeds" without ever placing a binary. The old code took that
 * exit code at face value, returned ok:true, and skipped the direct-download
 * fallback — so the step died later with a misleading `not_on_path` error.
 *
 * These tests pin the property that install success is judged by the BINARY,
 * never by the pipeline's exit code.
 */

const execSyncMock = vi.fn();
const execFileSyncMock = vi.fn();

vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => execSyncMock(...args),
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
}));

vi.mock('../src/log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const UPSTREAM_INSTALLER = 'curl -fsSL onecli.sh/cli/install | sh';

/** Commands passed to execSync, in call order. */
function issuedCommands(): string[] {
  return execSyncMock.mock.calls.map((call) => String(call[0]));
}

describe('installOnecliCliOnly — upstream installer false-ok', () => {
  beforeEach(() => {
    vi.resetModules();
    execSyncMock.mockReset();
    execFileSyncMock.mockReset();
  });

  it('falls back to direct download when the pipeline exits 0 but installs no binary', async () => {
    // Upstream pipeline "succeeds" (sh exits 0 on empty stdin) …
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd === UPSTREAM_INSTALLER) return '';
      // … and every fallback command (redirect probe, download) fails, so the
      // fallback cannot mask the assertion below.
      throw Object.assign(new Error('network down'), { stderr: 'network down' });
    });
    // … but no binary landed: `onecli version` cannot run.
    execFileSyncMock.mockImplementation(() => {
      throw new Error('onecli: command not found');
    });

    const { installOnecliCliOnly } = await import('./onecli.js');
    const res = installOnecliCliOnly();

    // Pre-fix this was `true` — a green exit code with nothing installed.
    expect(res.ok).toBe(false);
    // Pre-fix the fallback never ran, so no release URL was ever requested.
    expect(issuedCommands().some((c) => c.includes('onecli-cli/releases'))).toBe(true);
  });

  it('accepts the upstream install when it actually yields a binary', async () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd === UPSTREAM_INSTALLER) return 'onecli 2.5.0 installed';
      throw new Error(`unexpected command: ${cmd}`);
    });
    execFileSyncMock.mockReturnValue('onecli version 2.5.0\n');

    const { installOnecliCliOnly } = await import('./onecli.js');
    const res = installOnecliCliOnly();

    expect(res.ok).toBe(true);
    // Happy path must not pay for a redundant direct download.
    expect(issuedCommands()).toEqual([UPSTREAM_INSTALLER]);
  });
});
