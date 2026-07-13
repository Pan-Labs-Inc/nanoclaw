/**
 * activation-single-path.test.ts — a structural guard that keeps born-suppressed
 * DM activation on ONE path.
 *
 * The ruling (#1018/#1419): activation is a core control-plane task, and every
 * channel must reach it through the SAME channel-agnostic start-token core
 * (`tryActivateStartToken` in start-token.ts). The only thing a channel may
 * differ on is TRANSPORT — how the token arrives (a Telegram deep-link tap, a cli
 * line, an SMS `START <token>`). #1419 was exactly what happens when this drifts:
 * SMS grew a bespoke activation path that flipped state in its own store and
 * never stamped `activatedAt`, so the host-sweep wake gate — which reads
 * `activatedAt` — skipped the session forever and onboarding never fired.
 *
 * These guards make a future divergence a DELIBERATE decision (you must edit this
 * file), never a silent drift. If you are intentionally adding a new activation
 * mechanism, change the guard in the same PR and say why.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative, sep } from 'node:path';

import { describe, it, expect } from 'vitest';

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Every non-test .ts source file under src/, as repo-relative POSIX paths. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = resolve(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) {
        out.push(relative(SRC_ROOT, full).split(sep).join('/'));
      }
    }
  };
  walk(SRC_ROOT);
  return out;
}

// The channels that own an inbound interceptor and can therefore activate a
// born-suppressed registration. A new inbound channel added here (or a new file
// that stamps activation) trips a guard until it is wired to the shared core.
const INBOUND_CHANNELS = ['channels/sms.ts', 'channels/telegram.ts', 'channels/cli.ts'];

describe('activation is a single path (#1018/#1419)', () => {
  it('activation state (`activatedAt`) is STAMPED in exactly one file — the start-token core', () => {
    // A write is `activatedAt: <value>` (object-literal assignment). Reads
    // (`reg.activatedAt`) and the type declaration (`activatedAt?:`) do not match
    // — only the core may mint the activation stamp every reader trusts.
    const writeForm = /\bactivatedAt\s*:/;
    const stampers = sourceFiles().filter((f) => {
      const body = readFileSync(resolve(SRC_ROOT, f), 'utf8');
      return body.split('\n').some((line) => {
        const trimmed = line.trimStart();
        if (trimmed.startsWith('*') || trimmed.startsWith('//')) return false; // skip comments
        return writeForm.test(line);
      });
    });
    expect(
      stampers.sort(),
      'Only start-token.ts may stamp `activatedAt`. A second stamper is the #1419 divergence — ' +
        'route the new channel through tryActivateStartToken instead, or edit this guard deliberately.',
    ).toEqual(['channels/start-token.ts']);
  });

  it('every inbound channel reaches activation through tryActivateStartToken', () => {
    for (const ch of INBOUND_CHANNELS) {
      const body = readFileSync(resolve(SRC_ROOT, ch), 'utf8');
      expect(
        body.includes('tryActivateStartToken'),
        `${ch} must activate born-suppressed registrations through the shared start-token core, ` +
          `not a bespoke path (#1419). If this channel genuinely cannot activate, drop it from INBOUND_CHANNELS.`,
      ).toBe(true);
    }
  });

  it('the writers of dm-registrations are only the registrar (dm_register) and the activation core', () => {
    // dm-registrations.json is the activation source of truth. Constrain who may
    // WRITE it: admin-mcp registers (registeredAt), start-token activates
    // (activatedAt). Any other writer is a new control-plane path that must be a
    // deliberate, reviewed addition — not a silent third source of activation.
    const writers = sourceFiles().filter((f) => {
      if (f === 'dm-registrations.ts') return false; // the store module itself defines the writer
      const body = readFileSync(resolve(SRC_ROOT, f), 'utf8');
      return /\bwriteDmRegistrations\s*\(/.test(body);
    });
    expect(writers.sort()).toEqual(['admin-mcp.ts', 'channels/start-token.ts']);
  });
});
