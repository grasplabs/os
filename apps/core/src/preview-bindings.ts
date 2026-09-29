import { appErrors } from "@grasp-os/shared/apps";
import type { AppId } from "@grasp-os/shared/ids";
import type {
  DocumentPage,
  RecordPage,
  SearchResults,
} from "@grasp-os/shared/knowledge";
import { knowledgeErrors } from "@grasp-os/shared/knowledge";
import type { StatisticAnswer } from "@grasp-os/shared/statistics";
import { WorkerEntrypoint, exports } from "cloudflare:workers";

import { collectionGrantOf, exportGrantOf, stubsOf } from "./bindings.ts";
import { activePermissions } from "./permissions.ts";

// The env of a draft's preview (preview.ts): the binding names the App's
// active permissions give its server code, so the draft's code runs as it
// would, but every stub a preview's own, which can't cause a side effect
// or read real data. What that means for each:
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

/** What a preview stub stands in for. */
type Stands = "connection" | "exports" | "collection" | "statistics";

/** Refuses what a preview doesn't do, as the draft's code sees it. */
const refused = (): Error => appErrors.create("app.preview_side_effect");

/** Nothing read from Knowledge: the provenance of an empty answer. */
const nothingRead = { collectionIds: [], sensitive: false, restricted: false };

/** A document of the preview's empty collection: never there. */
const notFound = (): Error => knowledgeErrors.create("knowledge.not_found");

/**
 * A binding, in a preview: every method of the stub it stands in for
 * (`stands`), answered as the list above says. A collection's `read` and
 * statistics' share a name, so the props tell them apart.
 */
export class PreviewBinding extends WorkerEntrypoint<Env, { stands: Stands }> {
  // oxlint-disable-next-line class-methods-use-this -- the same for all
  call(): never {
    throw refused();
  }

  // oxlint-disable-next-line class-methods-use-this -- the same for all
  listDocuments(): DocumentPage {
    return { documents: [], provenance: nothingRead };
  }

  // oxlint-disable-next-line class-methods-use-this -- the same for all
  search(): SearchResults {
    return { hits: [], provenance: nothingRead };
  }

  // oxlint-disable-next-line class-methods-use-this -- the same for all
  listRecords(): RecordPage {
    return { records: [], unreadable: [], next: null, provenance: nothingRead };
  }

  // oxlint-disable-next-line class-methods-use-this -- the same for all
  history(): never {
    throw notFound();
  }

  // oxlint-disable-next-line class-methods-use-this -- the same for all
  backlinks(): never {
    throw notFound();
  }

  // oxlint-disable-next-line class-methods-use-this -- the same for all
  getDocument(): never {
    throw notFound();
  }

  // oxlint-disable-next-line class-methods-use-this -- the same for all
  getRecord(): never {
    throw notFound();
  }

  // oxlint-disable-next-line class-methods-use-this -- the same for all
  follow(): never {
    throw notFound();
  }

  /** A collection's document, never there; or statistics, with no groups. */
  read(_caller: unknown, query: unknown): StatisticAnswer {
    if (this.ctx.props.stands !== "statistics") {
      throw notFound();
    }
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

  // oxlint-disable-next-line class-methods-use-this -- the same for all
  canWrite(): boolean {
    return false;
  }

  // oxlint-disable-next-line class-methods-use-this -- the same for all
  saveRecord(): never {
    throw refused();
  }

  // oxlint-disable-next-line class-methods-use-this -- the same for all
  record(): void {
    // Dropped: a preview records nothing.
  }
}

/** A preview stub standing in for `stands`. */
const standIn = (stands: Stands): Fetcher<PreviewBinding> =>
  exports.PreviewBinding({ props: { stands } });

/**
 * The env of a preview of App `app`'s draft: a preview stub under each
 * name its permissions give its server code now (app-bindings.ts), and
 * `STATISTICS`, which every App has.
 */
export const previewBindings = async (
  env: Env,
  app: AppId
): Promise<Record<string, Fetcher<PreviewBinding>>> => {
  const collectionOf = collectionGrantOf({ type: "app", appId: app });
  const granted = stubsOf(
    await activePermissions(env, { type: "app", appId: app }),
    (permission) => {
      if (permission.object.type === "connection") {
        return standIn("connection");
      }
      if (exportGrantOf(permission) !== undefined) {
        return standIn("exports");
      }
      if (permission.object.type === "platform") {
        return standIn("statistics");
      }
      return collectionOf(permission) === undefined
        ? undefined
        : standIn("collection");
    }
  );
  return { ...granted, STATISTICS: standIn("statistics") };
};
