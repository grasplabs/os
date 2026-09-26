import type { CollectionId, PermissionId } from "@grasp-os/shared/ids";
import type {
  BacklinkPage,
  CollectionReader,
  DocumentPage,
  DocumentRead,
  HistoryPage,
} from "@grasp-os/shared/knowledge";
import type { Authority } from "@grasp-os/shared/permissions";
import { WorkerEntrypoint } from "cloudflare:workers";

import { forSandbox } from "../bindings.ts";
import type { WorkContext } from "../restricted.ts";
import type { Reader } from "./access.ts";
import { backlinks, getDocument, history, listDocuments } from "./documents.ts";

interface CollectionBindingProps {
  authority: Authority;
  context: WorkContext;
  /** The permission the stub was built from: only it counts on each call. */
  permissionId: PermissionId;
  collectionId: CollectionId;
}

/**
 * A collection, as an agent or a workflow run holds it:
 * `await env.HANDBOOK.getDocument(id)`. Like a connection stub, it is a
 * loopback entrypoint whose props core sets, and each call reads the
 * permission records again: it reads only while its own permission allows
 * reading, only its own collection, and only what the person it acts for
 * may read too (see access.ts).
 */
export class CollectionBinding
  extends WorkerEntrypoint<Env, CollectionBindingProps>
  implements CollectionReader
{
  async #read<T>(run: (reader: Reader) => Promise<T>): Promise<T> {
    const { authority, context, permissionId } = this.ctx.props;
    try {
      return await run({ type: "delegate", authority, context, permissionId });
    } catch (error) {
      throw forSandbox(error);
    }
  }

  async listDocuments(options?: unknown): Promise<DocumentPage> {
    return await this.#read(
      async (reader) =>
        await listDocuments(
          this.env,
          reader,
          this.ctx.props.collectionId,
          options
        )
    );
  }

  async getDocument(
    documentId: unknown,
    version?: unknown
  ): Promise<DocumentRead> {
    return await this.#read(
      async (reader) => await getDocument(this.env, reader, documentId, version)
    );
  }

  async history(documentId: unknown, options?: unknown): Promise<HistoryPage> {
    return await this.#read(
      async (reader) => await history(this.env, reader, documentId, options)
    );
  }

  async backlinks(
    documentId: unknown,
    options?: unknown
  ): Promise<BacklinkPage> {
    return await this.#read(
      async (reader) => await backlinks(this.env, reader, documentId, options)
    );
  }
}
