import type { AppId } from "@grasp-os/shared/ids";
import type {
  BacklinkPage,
  DocumentPage,
  DocumentRead,
  HistoryPage,
  SearchResults,
} from "@grasp-os/shared/knowledge";
import type { Authority } from "@grasp-os/shared/permissions";
import { WorkerEntrypoint } from "cloudflare:workers";

import { callerOf } from "../app-bindings.ts";
import { collectionReads } from "./binding.ts";
import type { CollectionGrant } from "./binding.ts";

/**
 * A collection, as an App's server code holds it:
 * `await this.env.HANDBOOK.getDocument(caller, id)`. Like the App's
 * connection stubs (app-bindings.ts), it acts for no one on its own: each
 * read passes the caller of the App method it runs in, and the App's host
 * says who that is. So a read gets the App's grant intersected with what
 * that person may read, never a personal collection (access.ts), and a
 * read of restricted data puts the App in restricted mode first, for
 * everyone using it.
 */
export class AppCollectionBinding extends WorkerEntrypoint<
  Env,
  CollectionGrant & { app: AppId }
> {
  #reads(caller: unknown) {
    const { app, ...grant } = this.ctx.props;
    const authority = async (): Promise<Authority> => {
      const resolved = await callerOf(this.env, app, caller);
      return resolved.authority;
    };
    return collectionReads(this.env, authority, grant);
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
}
