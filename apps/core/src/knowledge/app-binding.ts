import type { AppId } from "@grasp-os/shared/ids";
import type {
  BacklinkPage,
  DocumentPage,
  DocumentRead,
  DocumentSummary,
  FollowResult,
  HistoryPage,
  KnowledgeRead,
  RecordPage,
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
  canWriteAsDelegate,
  getRecord,
  listRecords,
  saveRecordAsDelegate,
} from "./records.ts";
import type { Setter } from "./records.ts";

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
 * Each stub also reads and writes the collection's records, typed by the
 * record types Apps declare for it (records.ts, record-types.ts): a save
 * (`saveRecord`) only under a permission with `write`, for the caller and
 * with their rights, and says whether it would (`canWrite`), so App
 * screens offer only the changes core takes. A save through a stub whose
 * permission doesn't write is refused by the permission check, and
 * `canWrite` is `false` there.
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

  /** Who `caller` is, and the App method their call runs. */
  async #callerOf(
    caller: unknown
  ): Promise<{ authority: Authority; setter: Setter }> {
    const { app } = this.ctx.props;
    const resolved = await callerOf(this.env, app, caller);
    return {
      authority: resolved.authority,
      setter: { app, method: resolved.method },
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
   * YAML parser, reads a record.
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
   * A page of records (`{ after?, limit?, type? }`, at most 20), each read
   * as `getRecord` reads its current version, in one read with one audit
   * event: how App code reads many records without a read for each. Those
   * that don't fit their type any more are in `unreadable`.
   */
  async listRecords(caller: unknown, options?: unknown): Promise<RecordPage> {
    const { context, permissionId, collectionId } = this.ctx.props;
    return await readAsDelegate(
      this.env,
      this.#authorityOf(caller),
      context,
      permissionId,
      async (reader) =>
        await listRecords(this.env, reader, collectionId, options)
    );
  }

  /**
   * Whether `saveRecord` would write for `caller` now, by the checks it
   * makes (`canWriteAsDelegate` in records.ts): a permission to write the
   * collection, a caller who may change it themselves, and an App that
   * hasn't read restricted data. A hint for showing only what core takes:
   * each write is checked again.
   */
  async canWrite(caller: unknown): Promise<boolean> {
    const { collectionId } = this.ctx.props;
    return await this.#write(
      caller,
      async ({ authority }, grant) =>
        await canWriteAsDelegate(
          this.env,
          authority,
          grant.context,
          grant.permissionId,
          collectionId
        )
    );
  }

  /**
   * Saves a record for `caller` (`{ path, ifVersion, record, body,
   * message? }`, `recordSaveSchema`), through the save pipeline, with
   * versions: only under a permission that writes the collection, and only
   * for someone who may change it themselves. The record's type checks
   * it; the kept fields its declaration gives to the method this call
   * runs in are set as `record` has them, and every other one is kept
   * (records.ts, `writeRecord`).
   */
  async saveRecord(caller: unknown, input: unknown): Promise<DocumentSummary> {
    const { collectionId } = this.ctx.props;
    return await this.#write(
      caller,
      async ({ authority, setter }, grant) =>
        await saveRecordAsDelegate(
          this.env,
          authority,
          grant.context,
          grant.permissionId,
          collectionId,
          input,
          setter
        )
    );
  }

  /** Runs a write for `caller`, with errors as the sandbox sees them. */
  async #write<T>(
    caller: unknown,
    run: (
      resolved: { authority: Authority; setter: Setter },
      grant: CollectionGrant
    ) => Promise<T>
  ): Promise<T> {
    const { app: _app, ...grant } = this.ctx.props;
    try {
      return await run(await this.#callerOf(caller), grant);
    } catch (error) {
      throw forSandbox(error);
    }
  }
}
