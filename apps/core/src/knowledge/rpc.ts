import type {
  Backlink,
  Collection,
  CollectionInput,
  DocumentRead,
  DocumentSummary,
  HistoryOptions,
  KnowledgeApi,
  ListDocumentsOptions,
  RestoreInput,
  SaveInput,
  VersionSummary,
} from "@grasp-os/shared/knowledge";
import type { Identity } from "@grasp-os/shared/rpc";
import { RpcTarget } from "capnweb";

import type { SessionCheck } from "../session-rpc.ts";
import { createCollection, listCollections } from "./collections.ts";
import {
  backlinks,
  getDocument,
  history,
  listDocuments,
  restoreVersion,
  saveDocument,
} from "./documents.ts";

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

  async listCollections(): Promise<Collection[]> {
    return await this.#asPerson(
      async (person) => await listCollections(this.#env, person)
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
  ): Promise<DocumentSummary[]> {
    return await this.#asPerson(
      async (person) =>
        await listDocuments(this.#env, person, collectionId, options)
    );
  }

  async getDocument(
    documentId: string,
    version?: number
  ): Promise<DocumentRead> {
    return await this.#asPerson(
      async (person) =>
        await getDocument(this.#env, person, documentId, version)
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
  ): Promise<VersionSummary[]> {
    return await this.#asPerson(
      async (person) => await history(this.#env, person, documentId, options)
    );
  }

  async restoreVersion(input: RestoreInput): Promise<DocumentSummary> {
    return await this.#asPerson(
      async (person) => await restoreVersion(this.#env, person, input)
    );
  }

  async backlinks(documentId: string): Promise<Backlink[]> {
    return await this.#asPerson(
      async (person) => await backlinks(this.#env, person, documentId)
    );
  }
}
