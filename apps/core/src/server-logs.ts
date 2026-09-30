import type { AppId, ChatId, WorkspaceId } from "@grasp-os/shared/ids";
import type { ServerLog } from "@grasp-os/shared/screens";
import { WorkerEntrypoint } from "cloudflare:workers";

import { appHost, workspace } from "./durable-objects.ts";

// What an App's server code writes with `console`, which would otherwise
// be lost: its isolate runs with no network (sandbox.ts), and the
// platform's own logs never carry App-written text (app.ts). Each loader
// that starts App server code names this entrypoint as the isolate's tail
// (WorkerLoader `tails`, which workerd runs as Cloudflare does), so the
// runtime hands it what each call logged once the call ends:
//
// - a live App's lines go to its error log (app-error-log.ts), in the
//   App's own Durable Object, with its screens' problems;
// - a draft's preview's lines go to the chat's Workspace object, for the
//   agent's next check of the draft (preview-reports.ts).
//
// Bounded twice: the first lines of each call, each held to size, and the
// newest entries of each log. Only what the App's code wrote is kept, with
// the method and the time: never who called.

/** Most lines kept of one call. */
const maxLinesPerCall = 20;

/** Most characters of one line kept. */
const maxMessage = 2000;

/** Whose server code a tail listens to. */
export interface TailOf {
  app: AppId;
  /** The live version that runs; null for a draft's preview. */
  version: number | null;
  /** The chat's draft at `revision`, for a preview. */
  preview?: { workspaceId: WorkspaceId; chatId: ChatId; revision: number };
}

const levels = new Set<unknown>(["debug", "info", "log", "warn", "error"]);

const isLevel = (level: string): level is ServerLog["level"] =>
  levels.has(level);

const levelOf = (level: string): ServerLog["level"] =>
  isLevel(level) ? level : "log";

/** One argument of a `console` call as text. */
const partOf = (part: unknown): string => {
  if (typeof part === "string") {
    return part;
  }
  try {
    return JSON.stringify(part) ?? String(part);
  } catch {
    return String(part);
  }
};

/** A line's arguments as text, held to size. */
const textOf = (message: unknown): string =>
  (Array.isArray(message) ? message : [message])
    .map(partOf)
    .join(" ")
    .slice(0, maxMessage);

/** The first lines the calls in `events` wrote. */
export const serverLogsOf = (events: TraceItem[]): ServerLog[] =>
  events
    .flatMap(({ event, logs }) => {
      const method =
        event !== null && "rpcMethod" in event ? event.rpcMethod : null;
      return logs.slice(0, maxLinesPerCall).map((line) => ({
        at: new Date(line.timestamp).toISOString(),
        level: levelOf(line.level),
        message: textOf(line.message),
        method,
      }));
    })
    .slice(0, maxLinesPerCall);

/** The tail of an isolate running App server code. */
export class AppTail extends WorkerEntrypoint<Env, TailOf> {
  override async tail(events: TraceItem[]): Promise<void> {
    const logs = serverLogsOf(events);
    if (logs.length === 0) {
      return;
    }
    const { app, version, preview } = this.ctx.props;
    if (preview !== undefined) {
      await workspace(this.env, preview.workspaceId).previewLogs(
        preview.chatId,
        app,
        preview.revision,
        logs
      );
    } else if (version !== null) {
      await appHost(this.env, app).logServer(version, logs);
    }
  }
}
