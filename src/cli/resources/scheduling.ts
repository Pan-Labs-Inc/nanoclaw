/**
 * `task` — host-applied scheduling verbs callable from an in-container HOOK via
 * `ncl` (the harness, not the agent's LLM). A thin CLI mirror of the
 * `schedule_task` / `cancel_task` MCP tools, exposed so a hook can arm and cancel
 * a one-shot task WITHOUT an agent turn.
 *
 *     ncl task schedule --id <task-id> --process-after <ISO-8601> [--script <bash>]
 *     ncl task delete   --id <task-id>
 *
 * Built for Pan's per-turn lease crash-net (#751 P5 S4): the lease task carries a
 * pre-task `script` that runs the recovery hook and emits `{"wakeAgent": false}`
 * as its last stdout line — so when it fires it wakes a fresh container that runs
 * host-side recovery work and then SKIPS the agent turn (the same pre-task-script
 * path the projector sweep uses). One-shot = no `--recurrence`. Cancel on the
 * normal turn close so it only ever fires on a genuinely dead turn.
 *
 * RESOURCE-LESS by design: these verbs write ONLY into the CALLER's own session
 * inbound DB (ctx.inDb, threaded by the cli_request transport), so they are
 * inherently group-scoped — they need no `cli_scope` resource-whitelist entry and
 * work under both 'group' and 'global' scope (blocked only when CLI is
 * 'disabled', the correct fail-closed). access:'open' → no approval gate.
 *
 * Registered as plain commands (not via registerResource) — there is no
 * task-owned table; tasks are `messages_in` rows with kind='task'.
 */
import type BetterSqlite3Database from 'better-sqlite3';

import { register } from '../registry.js';
import { insertTask, cancelTask } from '../../modules/scheduling/db.js';
import { log } from '../../log.js';
import type { CallerContext } from '../frame.js';

/** First non-empty string value among the accepted aliases for a flag. */
function strArg(raw: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = raw[k];
    if (typeof v === 'string' && v !== '') return v;
  }
  return null;
}

interface ScheduleArgs {
  id: string;
  processAfter: string;
  script: string | null;
  prompt: string | null;
  recurrence: string | null;
  platformId: string | null;
  channelType: string | null;
  threadId: string | null;
}

function parseScheduleArgs(raw: Record<string, unknown>): ScheduleArgs {
  const id = strArg(raw, 'id');
  const processAfter = strArg(raw, 'process-after', 'processAfter', 'process_after', 'at');
  if (!id) throw new Error('--id is required (the task id; reuse it with `task delete`)');
  if (!processAfter) throw new Error('--process-after is required (ISO-8601 fire time)');
  return {
    id,
    processAfter,
    script: strArg(raw, 'script'),
    prompt: strArg(raw, 'prompt'),
    recurrence: strArg(raw, 'recurrence'),
    platformId: strArg(raw, 'platform-id', 'platformId', 'platform_id'),
    channelType: strArg(raw, 'channel-type', 'channelType', 'channel_type'),
    threadId: strArg(raw, 'thread-id', 'threadId', 'thread_id'),
  };
}

/** A task verb writes into the caller's OWN session DB — reject any other caller. */
function requireSessionDb(ctx: CallerContext): BetterSqlite3Database.Database {
  if (ctx.caller !== 'agent' || !ctx.inDb) {
    throw new Error('task verbs are only callable in-container (they need the session DB transport)');
  }
  return ctx.inDb;
}

register({
  name: 'task-schedule',
  description:
    'Schedule a one-shot or recurring task in the CALLER’s own session (host-applied; mirrors the schedule_task MCP tool, callable from a hook via ncl). Args: --id <task-id> --process-after <ISO-8601> [--script <bash> pre-task script; emit {"wakeAgent":false} as the LAST stdout line to run host-side work WITHOUT an agent turn] [--prompt <text>] [--recurrence <cron>]. Writes into the caller session inbound DB only (group-scoped).',
  access: 'open',
  parseArgs: parseScheduleArgs,
  handler: async (args: ScheduleArgs, ctx: CallerContext) => {
    const inDb = requireSessionDb(ctx);
    insertTask(inDb, {
      id: args.id,
      processAfter: args.processAfter,
      recurrence: args.recurrence,
      platformId: args.platformId,
      channelType: args.channelType,
      threadId: args.threadId,
      content: JSON.stringify({ prompt: args.prompt ?? '', script: args.script }),
    });
    log.info('task-schedule (ncl): task created', {
      taskId: args.id,
      processAfter: args.processAfter,
      recurrence: args.recurrence,
      hasScript: args.script != null,
    });
    return { scheduled: true, id: args.id, processAfter: args.processAfter, recurrence: args.recurrence };
  },
});

interface DeleteArgs {
  id: string;
}

function parseDeleteArgs(raw: Record<string, unknown>): DeleteArgs {
  const id = strArg(raw, 'id');
  if (!id) throw new Error('--id is required (the task id to cancel)');
  return { id };
}

register({
  name: 'task-delete',
  description:
    'Cancel a pending/paused task by id in the CALLER’s own session (host-applied; mirrors cancel_task). Idempotent: succeeds whether or not a matching task exists. Args: --id <task-id>.',
  access: 'open',
  parseArgs: parseDeleteArgs,
  handler: async (args: DeleteArgs, ctx: CallerContext) => {
    const inDb = requireSessionDb(ctx);
    cancelTask(inDb, args.id);
    log.info('task-delete (ncl): task cancelled', { taskId: args.id });
    return { deleted: true, id: args.id };
  },
});
