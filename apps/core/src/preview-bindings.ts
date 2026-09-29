// oxlint-disable max-classes-per-file -- one stub per kind of binding, each with exactly its real binding's methods
import { appErrors } from "@grasp-os/shared/apps";
import type { AppId, ChatId, WorkspaceId } from "@grasp-os/shared/ids";
import type {
  DocumentPage,
  RecordPage,
  SearchResults,
} from "@grasp-os/shared/knowledge";
import { knowledgeErrors } from "@grasp-os/shared/knowledge";
import type { StatisticAnswer } from "@grasp-os/shared/statistics";
import { WorkerEntrypoint, exports } from "cloudflare:workers";

import { collectionGrantOf, exportGrantOf, stubsOf } from "./bindings.ts";
import { workspace } from "./durable-objects.ts";
import { activePermissions } from "./permissions.ts";

// The env of a draft's preview (preview.ts): the binding names the App's
// active permissions give its server code, so the draft's code runs as it
// would, but every stub a preview's own, which can't cause a side effect
// or read real data. Each stub that refuses names its preview (the chat
// and the App), and before the draft's code hears of a refusal tells the
// preview which server call it refused, by the caller token that call
// passed it (`Previews.refused`, preview.ts): so core, not what the
// draft's code writes, says what a refusal caused (preview-reports.ts).
// What that means for each:
//
// - A connection (`OUTLOOK`): every call refused, reads too. A preview
//   reaches no outside system: a read would carry out what the draft
//   sends, and bring back what the person's mailbox holds.
// - A collection (`HANDBOOK`): an empty collection. A list, a search or a
//   page of records finds nothing, a document named isn't found, and
//   `canWrite` is false; a write (`saveRecord`) is refused. Nothing of
//   Knowledge is read, so nothing real reaches the preview's screens, or
//   what they report.
// - Another App's exports: every call refused. That App's code and data
//   are real, whatever its export says it does.
// - Statistics (`STATISTICS`, and the platform's under a grant): a point
//   is dropped, and a read answers no groups.
// - Its own storage: a SQLite database of the preview's own, empty at
//   first and dropped whenever the draft changes (preview.ts); never the
//   App's.
// - The network: none, as for any App code (sandbox.ts).
// - Workflows: App server code has no stub for them; a screen's calls on
//   its App's runs go through the page, which answers them itself in a
//   preview and starts none.

/** Whose preview a stub is: the chat's draft of `app`. */
export interface PreviewOf {
  workspaceId: WorkspaceId;
  chatId: ChatId;
  app: AppId;
}

/** The caller token App code passes a stub first, if it passed one. */
const tokenOf = (caller: unknown): unknown =>
  typeof caller === "object" && caller !== null && "token" in caller
    ? caller.token
    : undefined;

/**
 * Refuses what a preview doesn't do, as the draft's code sees it
 * (`app.preview_side_effect`): recorded first against the server call
 * `caller` names, so what it causes counts as the preview's doing, not
 * the draft's (preview-reports.ts).
 */
const refuse = async (
  env: Env,
  { workspaceId, chatId, app }: PreviewOf,
  caller: unknown
): Promise<never> => {
  await workspace(env, workspaceId).previewRefused(
    chatId,
    app,
    tokenOf(caller)
  );
  throw appErrors.create("app.preview_side_effect");
};

/** Nothing read from Knowledge: the provenance of an empty answer. */
const nothingRead = { collectionIds: [], sensitive: false, restricted: false };

/** A document of the preview's empty collection: never there. */
const notFound = (): Error => knowledgeErrors.create("knowledge.not_found");

// Each stub has exactly the methods of the binding it stands in for, so a
// call the real one doesn't have fails in a preview as it would live: the
// runtime refuses a method its receiver doesn't implement.

/** A connection, in a preview (`AppConnectionBinding`'s methods). */
export class PreviewConnection extends WorkerEntrypoint<Env, PreviewOf> {
  async call(caller: unknown): Promise<never> {
    return await refuse(this.env, this.ctx.props, caller);
  }
}

/** Another App's exports, in a preview (`AppExportBinding`'s methods). */
export class PreviewExports extends WorkerEntrypoint<Env, PreviewOf> {
  async call(caller: unknown): Promise<never> {
    return await refuse(this.env, this.ctx.props, caller);
  }
}

/** A collection, in a preview (`AppCollectionBinding`'s methods). */
export class PreviewCollection extends WorkerEntrypoint<Env, PreviewOf> {
  // oxlint-disable-next-line class-methods-use-this -- a preview's stubs answer the same, whoever holds them
  listDocuments(): DocumentPage {
    return { documents: [], provenance: nothingRead };
  }

  // oxlint-disable-next-line class-methods-use-this -- a preview's stubs answer the same, whoever holds them
  getDocument(): never {
    throw notFound();
  }

  // oxlint-disable-next-line class-methods-use-this -- a preview's stubs answer the same, whoever holds them
  history(): never {
    throw notFound();
  }

  // oxlint-disable-next-line class-methods-use-this -- a preview's stubs answer the same, whoever holds them
  backlinks(): never {
    throw notFound();
  }

  // oxlint-disable-next-line class-methods-use-this -- a preview's stubs answer the same, whoever holds them
  search(): SearchResults {
    return { hits: [], provenance: nothingRead };
  }

  // oxlint-disable-next-line class-methods-use-this -- a preview's stubs answer the same, whoever holds them
  read(): never {
    throw notFound();
  }

  // oxlint-disable-next-line class-methods-use-this -- a preview's stubs answer the same, whoever holds them
  follow(): never {
    throw notFound();
  }

  // oxlint-disable-next-line class-methods-use-this -- a preview's stubs answer the same, whoever holds them
  getRecord(): never {
    throw notFound();
  }

  // oxlint-disable-next-line class-methods-use-this -- a preview's stubs answer the same, whoever holds them
  listRecords(): RecordPage {
    return { records: [], unreadable: [], next: null, provenance: nothingRead };
  }

  // oxlint-disable-next-line class-methods-use-this -- a preview's stubs answer the same, whoever holds them
  canWrite(): boolean {
    return false;
  }

  async saveRecord(caller: unknown): Promise<never> {
    return await refuse(this.env, this.ctx.props, caller);
  }
}

/** Statistics, in a preview (`AppStatisticsBinding`'s methods). */
export class PreviewStatistics extends WorkerEntrypoint<Env> {
  // oxlint-disable-next-line class-methods-use-this -- a preview's stubs answer the same, whoever holds them
  record(): void {
    // Dropped: a preview records nothing.
  }

  // oxlint-disable-next-line class-methods-use-this -- a preview's stubs answer the same, whoever holds them
  read(_caller: unknown, query: unknown): StatisticAnswer {
    const measure =
      typeof query === "object" &&
      query !== null &&
      "measure" in query &&
      typeof query.measure === "string"
        ? query.measure
        : "";
    const today = new Date().toISOString().slice(0, 10);
    return { measure, from: today, to: today, groups: [], truncated: false };
  }
}

/** A stub a draft's previewed server code holds. */
type PreviewStub =
  | Fetcher<PreviewConnection>
  | Fetcher<PreviewExports>
  | Fetcher<PreviewCollection>
  | Fetcher<PreviewStatistics>;

/**
 * The env of `of`, a preview of App `app`'s draft: a preview stub under
 * each name its permissions give its server code now (app-bindings.ts),
 * and `STATISTICS`, which every App has.
 */
export const previewBindings = async (
  env: Env,
  of: PreviewOf
): Promise<Record<string, PreviewStub>> => {
  const { app } = of;
  const collectionOf = collectionGrantOf({ type: "app", appId: app });
  const granted = stubsOf<PreviewStub>(
    await activePermissions(env, { type: "app", appId: app }),
    (permission) => {
      if (permission.object.type === "connection") {
        return exports.PreviewConnection({ props: of });
      }
      if (exportGrantOf(permission) !== undefined) {
        return exports.PreviewExports({ props: of });
      }
      if (permission.object.type === "platform") {
        return exports.PreviewStatistics({});
      }
      return collectionOf(permission) === undefined
        ? undefined
        : exports.PreviewCollection({ props: of });
    }
  );
  return { ...granted, STATISTICS: exports.PreviewStatistics({}) };
};
