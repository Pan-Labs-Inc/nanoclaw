import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../db/index.js';
import { getContainerConfig } from '../db/container-configs.js';
import { getAgentGroupByFolder } from '../db/agent-groups.js';
import { lookup } from './registry.js';
// Side-effect import: registers the `groups-*` CLI commands (genericCreate
// with the real `afterCreate` container_configs seed wired in groups.ts).
import './resources/groups.js';

const HOST_CTX = { caller: 'host' } as const;

/** Drive the real `groups-create` command the way dispatch would. */
async function createGroup(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
  const cmd = lookup('groups-create');
  if (!cmd) throw new Error('groups-create command not registered');
  return (await cmd.handler(cmd.parseArgs(raw), HOST_CTX)) as Record<string, unknown>;
}

beforeEach(() => {
  runMigrations(initTestDb());
});

afterEach(() => {
  closeDb();
});

describe('genericCreate — caller-supplied id (ncl-groups-create defect a)', () => {
  it('accepts a letter-leading caller-supplied id and uses it verbatim', async () => {
    const id = 'ag-1700000000-abc123';
    await createGroup({ id, name: 'Teen', folder: 'pan-teen-test-aa11bb' });

    const row = getAgentGroupByFolder('pan-teen-test-aa11bb');
    expect(row).toBeDefined();
    expect(row!.id).toBe(id);
  });

  it('rejects a digit-leading id (OneCLI gateway would 400 it at spawn)', async () => {
    await expect(
      createGroup({ id: '1bad-id', name: 'Teen', folder: 'pan-teen-test-cc22dd' }),
    ).rejects.toThrow(/start with a lowercase letter/i);
    expect(getAgentGroupByFolder('pan-teen-test-cc22dd')).toBeUndefined();
  });

  it('rejects an id with uppercase / illegal characters', async () => {
    await expect(
      createGroup({ id: 'AG_Bad', name: 'Teen', folder: 'pan-teen-test-ee33ff' }),
    ).rejects.toThrow(/lowercase letters, digits, and hyphens/i);
  });

  it('auto-mints an id when none is supplied (unchanged default path)', async () => {
    await createGroup({ name: 'Teen', folder: 'pan-teen-test-gg44hh' });
    const row = getAgentGroupByFolder('pan-teen-test-gg44hh');
    expect(row).toBeDefined();
    expect(typeof row!.id).toBe('string');
    expect(row!.id.length).toBeGreaterThan(0);
  });
});

describe('genericCreate afterCreate — seeds container_configs (ncl-groups-create defect b)', () => {
  it('seeds a container_configs row at create time (caller-supplied id)', async () => {
    const id = 'ag-1700000001-def456';
    await createGroup({ id, name: 'Parent', folder: 'pan-parent-test-aa11bb' });
    expect(getContainerConfig(id)).toBeDefined();
  });

  it('seeds a container_configs row at create time (auto-minted id)', async () => {
    await createGroup({ name: 'Parent', folder: 'pan-parent-test-cc22dd' });
    const row = getAgentGroupByFolder('pan-parent-test-cc22dd');
    expect(row).toBeDefined();
    expect(getContainerConfig(row!.id)).toBeDefined();
  });
});
