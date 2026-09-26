import type {
  BacklinkPage,
  Collection,
  CollectionInput,
  DocumentPage,
  DocumentRead,
  DocumentSummary,
  HistoryOptions,
  HistoryPage,
  KnowledgeApi,
  ListDocumentsOptions,
  RestoreInput,
  SaveInput,
  SearchOptions,
  SearchResults,
} from "@grasp-os/shared/knowledge";
import type { Identity } from "@grasp-os/shared/rpc";
import { RpcTarget } from "capnweb";

import type { SessionCheck } from "../session-rpc.ts";
import type { Reader } from "./access.ts";
import { createCollection, listCollections } from "./collections.ts";
import {
  backlinks,
  getDocument,
  history,
  listDocuments,
  restoreVersion,
  saveDocument,
} from "./documents.ts";
import { search } from "./search.ts";

/**
 * Knowledge for a signed-in person over `/rpc`. Like the session API, it
 * holds no identity: every method checks the session first and acts as
 * the person that check returns. Each takes what the client sent as it is;
 * the Knowledge functions validate it and check access on every call.
 */
export class KnowledgeRpc extends RpcTarget implements KnowledgeApi {
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async #asPerson<T>(run: (person: Identity) => Promise<T>): Promise<T> {
    return await run(await this.#check());
  }

  async #asReader<T>(run: (reader: Reader) => Promise<T>): Promise<T> {
    return await this.#asPerson(
      async (person) => await run({ type: "person", person })
    );
  }

  async listCollections(): Promise<Collection[]> {
    return await this.#asReader(
      async (reader) => await listCollections(this.#env, reader)
    );
  }

  async createCollection(input: CollectionInput): Promise<Collection> {
    return await this.#asPerson(
      async (person) => await createCollection(this.#env, person, input)
    );
  }

  async listDocuments(
    collectionId: string,
    options?: ListDocumentsOptions
  ): Promise<DocumentPage> {
    return await this.#asReader(
      async (reader) =>
        await listDocuments(this.#env, reader, collectionId, options)
    );
  }

  async getDocument(
    documentId: string,
    version?: number
  ): Promise<DocumentRead> {
    return await this.#asReader(
      async (reader) =>
        await getDocument(this.#env, reader, documentId, version)
    );
  }

  async saveDocument(input: SaveInput): Promise<DocumentSummary> {
    return await this.#asPerson(
      async (person) => await saveDocument(this.#env, person, input)
    );
  }

  async history(
    documentId: string,
    options?: HistoryOptions
  ): Promise<HistoryPage> {
    return await this.#asReader(
      async (reader) => await history(this.#env, reader, documentId, options)
    );
  }

  async restoreVersion(input: RestoreInput): Promise<DocumentSummary> {
    return await this.#asPerson(
      async (person) => await restoreVersion(this.#env, person, input)
    );
  }

  async backlinks(
    documentId: string,
    options?: ListDocumentsOptions
  ): Promise<BacklinkPage> {
    return await this.#asReader(
      async (reader) => await backlinks(this.#env, reader, documentId, options)
    );
  }

  async search(query: string, options?: SearchOptions): Promise<SearchResults> {
    return await this.#asReader(
      async (reader) => await search(this.#env, reader, query, options)
    );
  }
}
