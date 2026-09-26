import type { CollectionId, PermissionId } from "@grasp-os/shared/ids";
import type {
  BacklinkPage,
  CollectionReader,
  DocumentPage,
  DocumentRead,
  HistoryPage,
  SearchResults,
} from "@grasp-os/shared/knowledge";
import type { Authority } from "@grasp-os/shared/permissions";
import { WorkerEntrypoint } from "cloudflare:workers";

import { forSandbox } from "../bindings.ts";
import type { WorkContext } from "../restricted.ts";
import type { Reader } from "./access.ts";
import { backlinks, getDocument, history, listDocuments } from "./documents.ts";
import { search } from "./search.ts";

/** A collection permission, as a stub holds it, and where it works. */
export interface CollectionGrant {
  context: WorkContext;
  /** The permission the stub was built from: only it counts on each call. */
  permissionId: PermissionId;
  collectionId: CollectionId;
}

/** A collection's reads, as its stubs take them from sandbox code. */
interface CollectionReads {
  listDocuments: (options?: unknown) => Promise<DocumentPage>;
  getDocument: (
    documentId: unknown,
    version?: unknown
  ) => Promise<DocumentRead>;
  history: (documentId: unknown, options?: unknown) => Promise<HistoryPage>;
  backlinks: (documentId: unknown, options?: unknown) => Promise<BacklinkPage>;
  search: (query: unknown, options?: unknown) => Promise<SearchResults>;
}

/**
 * The reads of the collection `grant` is for, as `authority` (or as whoever
 * it resolves to on each read, which may refuse), with errors as the
 * sandbox sees them. Every read goes through `allowedCollections`
 * (access.ts) as a delegate: only while the permission allows reading,
 * only its own collection, and only what the person it acts for may read
 * too.
 */
export const collectionReads = (
  env: Env,
  authority: Authority | (() => Promise<Authority>),
  { context, permissionId, collectionId }: CollectionGrant
): CollectionReads => {
  const read = async <T>(run: (reader: Reader) => Promise<T>): Promise<T> => {
    try {
      return await run({
        type: "delegate",
        authority:
          typeof authority === "function" ? await authority() : authority,
        context,
        permissionId,
      });
    } catch (error) {
      throw forSandbox(error);
    }
  };
  return {
    listDocuments: async (options) =>
      await read(
        async (reader) =>
          await listDocuments(env, reader, collectionId, options)
      ),
    getDocument: async (documentId, version) =>
      await read(
        async (reader) => await getDocument(env, reader, documentId, version)
      ),
    history: async (documentId, options) =>
      await read(
        async (reader) => await history(env, reader, documentId, options)
      ),
    backlinks: async (documentId, options) =>
      await read(
        async (reader) => await backlinks(env, reader, documentId, options)
      ),
    search: async (query, options) =>
      await read(
        async (reader) =>
          await search(env, reader, query, options, collectionId)
      ),
  };
};

/**
 * A collection, as an agent or a workflow run holds it:
 * `await env.HANDBOOK.getDocument(id)`. Like a connection stub, it is a
 * loopback entrypoint whose props core sets, and each call reads the
 * permission records again (`collectionReads`). It acts for the one person
 * in its props; an App's stubs take the caller per call instead
 * (`AppCollectionBinding`).
 */
export class CollectionBinding
  extends WorkerEntrypoint<Env, CollectionGrant & { authority: Authority }>
  implements CollectionReader
{
  get #reads(): CollectionReads {
    const { authority, ...grant } = this.ctx.props;
    return collectionReads(this.env, authority, grant);
  }

  async listDocuments(options?: unknown): Promise<DocumentPage> {
    return await this.#reads.listDocuments(options);
  }

  async getDocument(
    documentId: unknown,
    version?: unknown
  ): Promise<DocumentRead> {
    return await this.#reads.getDocument(documentId, version);
  }

  async history(documentId: unknown, options?: unknown): Promise<HistoryPage> {
    return await this.#reads.history(documentId, options);
  }

  async backlinks(
    documentId: unknown,
    options?: unknown
  ): Promise<BacklinkPage> {
    return await this.#reads.backlinks(documentId, options);
  }

  async search(query: unknown, options?: unknown): Promise<SearchResults> {
    return await this.#reads.search(query, options);
  }
}
