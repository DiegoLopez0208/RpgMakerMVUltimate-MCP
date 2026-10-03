import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { commitStore, CommitContext } from '../../src/parity/utils/commit.js';
import {
  getCommonEvents,
  createCommonEvent,
  updateCommonEvent,
  callCommonEvent,
  defaultCommonEvent,
  commonEventToolDefinitions,
} from '../../src/parity/tools/commonEventTools.js';
import { listNames } from '../../src/parity/tools/listTools.js';
import { CommonEvent, EventCommand } from '../../src/parity/utils/types.js';

/** Scaffold a minimal project with a seeded CommonEvents.json. */
async function scaffoldProject(commonEvents: (CommonEvent | null)[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rpgmv-ce-'));
  await writeFile(join(dir, 'Game.rpgproject'), 'RPGMV 1.6.1');
  await mkdir(join(dir, 'data'));
  await writeFile(join(dir, 'data', 'System.json'), '{}');
  await writeFile(join(dir, 'data', 'CommonEvents.json'), JSON.stringify(commonEvents));
  return dir;
}

const heal: CommonEvent = { ...defaultCommonEvent(), id: 1, name: 'Heal Party' };

describe('common event tools (integration)', () => {
  let dir: string;

  beforeEach(async () => {
    // 1-indexed array whose slot 0 is null.
    dir = await scaffoldProject([null, heal]);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('createCommonEvent assigns the next id, applies defaults, and persists compactly', async () => {
    const created = await createCommonEvent(dir, { name: 'Save Point' });
    expect(created.id).toBe(2);
    expect(created.trigger).toBe(0);
    expect(created.switchId).toBe(1);
    expect(created.list).toEqual([{ code: 0, indent: 0, parameters: [] }]);

    const events = await getCommonEvents(dir);
    expect(events.find((ce) => ce?.id === 2)?.name).toBe('Save Point');

    const raw = await readFile(join(dir, 'data', 'CommonEvents.json'), 'utf-8');
    expect(raw).not.toContain('\n');
  });

  it('createCommonEvent honors overrides but never lets a caller set the id', async () => {
    const created = await createCommonEvent(dir, {
      name: 'Parallel Weather',
      trigger: 2,
      switchId: 10,
      id: 99,
    } as { name: string } & Partial<Omit<CommonEvent, 'id' | 'name'>> & { id: number });
    expect(created.id).toBe(2);
    expect(created.trigger).toBe(2);
    expect(created.switchId).toBe(10);
  });

  it('createCommonEvent ignores undefined optional fields, keeping template defaults', async () => {
    const created = await createCommonEvent(dir, { name: 'Ghost', trigger: undefined });
    expect(created.trigger).toBe(0);
    expect(created.switchId).toBe(1);
  });

  it('updateCommonEvent merges, re-pins the id, and refuses an unknown id', async () => {
    const updated = await updateCommonEvent(dir, 1, { name: 'Full Heal', trigger: 1 });
    expect(updated.name).toBe('Full Heal');
    expect(updated.trigger).toBe(1);
    expect(updated.id).toBe(1);
    await expect(updateCommonEvent(dir, 99, { name: 'X' })).rejects.toThrow(/not found/);
  });

  it('callCommonEvent builds a code-117 command and validates the target exists', async () => {
    const command = await callCommonEvent(dir, 1);
    expect(command).toEqual({ code: 117, indent: 0, parameters: [1] });
    const indented = await callCommonEvent(dir, 1, 2);
    expect(indented.indent).toBe(2);
    await expect(callCommonEvent(dir, 99)).rejects.toThrow(/does not exist/);
  });

  it('the call_common_event tool handler wraps the command in { command } (P2-8)', async () => {
    const def = commonEventToolDefinitions.find((t) => t.name === 'call_common_event')!;
    const result = (await def.handler({ projectPath: dir }, { commonEventId: 1 })) as {
      command: EventCommand;
    };
    expect(result.command).toEqual({ code: 117, indent: 0, parameters: [1] });
  });

  it('list_names indexes common events', async () => {
    const result = await listNames(dir, 'common_events');
    expect(result.entries).toEqual([{ id: 1, name: 'Heal Party' }]);
  });

  it('the create_common_event handler refuses a structurally bad command list', async () => {
    const def = commonEventToolDefinitions.find((t) => t.name === 'create_common_event')!;
    expect(def.mutates).toBe(true);
    expect(def.forceable).toBe(true);
    // A list not terminated by the code-0 end marker is structural.
    await expect(
      def.handler({ projectPath: dir }, { name: 'Refused', list: [{ code: 101, parameters: [] }] }),
    ).rejects.toThrow(/Refusing to write/);

    const commonEvents = await getCommonEvents(dir);
    expect(commonEvents.every((ce) => ce == null || ce.name !== 'Refused')).toBe(true);
  });

  it('the create_common_event handler writes a bad command list when forced, still warning', async () => {
    const def = commonEventToolDefinitions.find((t) => t.name === 'create_common_event')!;
    const result = (await def.handler(
      { projectPath: dir },
      { name: 'Forced', list: [{ code: 101, indent: 0, parameters: [] }], force: true },
    )) as { commonEvent: CommonEvent; warnings?: unknown[] };
    expect(result.commonEvent.name).toBe('Forced');
    expect(result.warnings && result.warnings.length).toBeGreaterThan(0);
    // `force` is a dispatcher argument and must not leak into the record.
    expect('force' in result.commonEvent).toBe(false);
  });

  it('the call_common_event tool is read-only and returns the command', async () => {
    const def = commonEventToolDefinitions.find((t) => t.name === 'call_common_event')!;
    expect(def.mutates).toBeUndefined();
    const result = (await def.handler({ projectPath: dir }, { commonEventId: 1 })) as {
      command: EventCommand;
    };
    expect(result.command.code).toBe(117);
  });

  it('dry-run previews the write without touching disk', async () => {
    const context: CommitContext = { dryRun: true, commits: [] };
    await commitStore.run(context, async () => {
      await createCommonEvent(dir, { name: 'Preview' });
    });
    expect(context.commits.some((c) => c.path.endsWith('CommonEvents.json'))).toBe(true);
    const events = await getCommonEvents(dir);
    expect(events.every((ce) => ce == null || ce.name !== 'Preview')).toBe(true);
  });
});

describe('common event template', () => {
  it('defaultCommonEvent is call-only with a code-0-terminated list', () => {
    const ce = defaultCommonEvent();
    expect(ce.trigger).toBe(0);
    expect(ce.list[ce.list.length - 1].code).toBe(0);
  });
});
