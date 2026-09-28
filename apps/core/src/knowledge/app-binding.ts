import type { AppId } from "@grasp-os/shared/ids";
import type {
  BacklinkPage,
  DocumentPage,
  DocumentRead,
  DocumentSummary,
  FollowResult,
  HistoryPage,
  KnowledgeRead,
  RecordRead,
  SearchResults,
} from "@grasp-os/shared/knowledge";
import type { Authority } from "@grasp-os/shared/permissions";
import { WorkerEntrypoint } from "cloudflare:workers";

import { callerOf } from "../app-bindings.ts";
import { forSandbox } from "../bindings.ts";
import { collectionReads, readAsDelegate } from "./binding.ts";
import type { CollectionGrant } from "./binding.ts";
import {
  getRecord,
  linkWorkflowAsDelegate,
  saveRecordAsDelegate,
  takeSnapshotAsDelegate,
} from "./playbook.ts";

/**
 * A collection, as an App's server code holds it:
 * `await this.env.HANDBOOK.getDocument(caller, id)`. Like the App's
 * connection stubs (app-bindings.ts), it acts for no one on its own: each
 * read passes the caller of the App method it runs in, and the App's host
 * says who that is. So a read gets the App's grant intersected with what
 * that person may read, never a personal collection (access.ts), and a
 * read of restricted data puts the App in restricted mode first, for
 * everyone using it.
 *
 * The Playbook's stub also writes records (`saveRecord`, `linkWorkflow`,
 * `takeSnapshot`), under a permission with `write`, for the caller and
 * with their rights (playbook.ts). Other collections have no writes: a
 * save through any other stub is refused by the permission check.
 */
export class AppCollectionBinding extends WorkerEntrypoint<
  Env,
  CollectionGrant & { app: AppId }
> {
  /** Who `caller` is, asked of the App's host when a read needs it. */
  #authorityOf(caller: unknown): () => Promise<Authority> {
    const { app } = this.ctx.props;
    return async () => {
      const resolved = await callerOf(this.env, app, caller);
      return resolved.authority;
    };
  }

  #reads(caller: unknown) {
    const { app: _app, ...grant } = this.ctx.props;
    return collectionReads(this.env, this.#authorityOf(caller), grant);
  }

  async listDocuments(
    caller: unknown,
    options?: unknown
  ): Promise<DocumentPage> {
    return await this.#reads(caller).listDocuments(options);
  }

  async getDocument(
    caller: unknown,
    documentId: unknown,
    version?: unknown
  ): Promise<DocumentRead> {
    return await this.#reads(caller).getDocument(documentId, version);
  }

  async history(
    caller: unknown,
    documentId: unknown,
    options?: unknown
  ): Promise<HistoryPage> {
    return await this.#reads(caller).history(documentId, options);
  }

  async backlinks(
    caller: unknown,
    documentId: unknown,
    options?: unknown
  ): Promise<BacklinkPage> {
    return await this.#reads(caller).backlinks(documentId, options);
  }

  async search(
    caller: unknown,
    query: unknown,
    options?: unknown
  ): Promise<SearchResults> {
    return await this.#reads(caller).search(query, options);
  }

  async read(
    caller: unknown,
    documentId: unknown,
    options?: unknown
  ): Promise<KnowledgeRead> {
    return await this.#reads(caller).read(documentId, options);
  }

  async follow(caller: unknown, documentId: unknown): Promise<FollowResult> {
    return await this.#reads(caller).follow(documentId);
  }

  /**
   * A document with its frontmatter as data (`record`) and its Markdown
   * (`body`), read as `getDocument` reads it: how App code, which has no
   * YAML parser, reads a Playbook record.
   */
  async getRecord(
    caller: unknown,
    documentId: unknown,
    version?: unknown
  ): Promise<RecordRead> {
    const { context, permissionId } = this.ctx.props;
    return await readAsDelegate(
      this.env,
      this.#authorityOf(caller),
      context,
      permissionId,
      async (reader) => await getRecord(this.env, reader, documentId, version)
    );
  }

  /**
   * Saves a Playbook record for `caller` (`saveRecord` in playbook.ts:
   * `{ path, ifVersion, record, body, message? }`), through the save
   * pipeline, with versions: only under a permission that writes the
   * Playbook, and only for someone who may change it themselves.
   */
  async saveRecord(caller: unknown, input: unknown): Promise<DocumentSummary> {
    return await this.#write(
      caller,
      async (authority, grant) =>
        await saveRecordAsDelegate(
          this.env,
          authority,
          grant.context,
          grant.permissionId,
          input
        )
    );
  }

  /**
   * Links a designed workflow record to the workflow of an App, for
   * `caller` (`linkWorkflow` in playbook.ts: `{ documentId, ifVersion,
   * appId, workflowId }`): as `saveRecord`, and only to an App `caller`
   * may use.
   */
  async linkWorkflow(
    caller: unknown,
    input: unknown
  ): Promise<DocumentSummary> {
    return await this.#write(
      caller,
      async (authority, grant) =>
        await linkWorkflowAsDelegate(
          this.env,
          authority,
          grant.context,
          grant.permissionId,
          input
        )
    );
  }

  /**
   * Takes a dated snapshot of the Playbook for `caller`
   * (`takeSnapshotAsDelegate` in playbook.ts: `{ maturity, title?,
   * decisionNeeded?, body? }`), freezing its workflows' hours, as drawn,
   * designed and observed in runs, and their improvement signals: as
   * `saveRecord`.
   */
  async takeSnapshot(
    caller: unknown,
    input: unknown
  ): Promise<DocumentSummary> {
    return await this.#write(
      caller,
      async (authority, grant) =>
        await takeSnapshotAsDelegate(
          this.env,
          authority,
          grant.context,
          grant.permissionId,
          input
        )
    );
  }

  /** Runs a write for `caller`, with errors as the sandbox sees them. */
  async #write<T>(
    caller: unknown,
    run: (authority: Authority, grant: CollectionGrant) => Promise<T>
  ): Promise<T> {
    const { app: _app, ...grant } = this.ctx.props;
    try {
      return await run(await this.#authorityOf(caller)(), grant);
    } catch (error) {
      throw forSandbox(error);
    }
  }
}
