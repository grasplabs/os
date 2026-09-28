import type {
  FollowResult,
  KnowledgeCatalog,
  KnowledgeRead,
  KnowledgeTools,
  Provenance,
  SearchResults,
} from "@grasp-os/shared/knowledge";
import { WorkerEntrypoint, exports } from "cloudflare:workers";

import {
  auditAgentCall,
  chatAuthority,
  chatContext,
  recordSources,
  requireOpenRun,
} from "./agent-scope.ts";
import type { AgentApi, AgentScope } from "./agent-scope.ts";
import type { Reader } from "./knowledge/access.ts";
import { readAsDelegate } from "./knowledge/binding.ts";
import { search } from "./knowledge/search.ts";
import { catalog, follow, read } from "./knowledge/tools.ts";

// Knowledge for a chat's code: `await env.knowledge.search("leave policy")`.
// The agent's Knowledge tools (knowledge/tools.ts), read as the chat's
// agent acting for its person: only the collections the agent was granted
// to read that the person may read too, checked again on every call
// (knowledge/access.ts). Every read but the catalog is recorded in the
// audit log there, and puts the chat in restricted mode when it read a
// sensitive collection. Here it is also recorded with the chat, which
// every later model request carries as provenance.

/** Knowledge, as a chat's code calls it. */
export class KnowledgeApi
  extends WorkerEntrypoint<Env, AgentScope>
  implements KnowledgeTools
{
  /** Runs one read as the chat's agent, after the run's check. */
  async #asAgent<T>(run: (reader: Reader) => Promise<T>): Promise<T> {
    const scope = this.ctx.props;
    await requireOpenRun(this.env, scope);
    return await readAsDelegate(
      this.env,
      chatAuthority(scope),
      chatContext(scope),
      undefined,
      run
    );
  }

  /** Hands over what a read returned once the chat has recorded its sources. */
  async #recorded<T extends { provenance: Provenance }>(result: T): Promise<T> {
    await recordSources(
      this.env,
      this.ctx.props,
      result.provenance.collectionIds
    );
    return result;
  }

  /**
   * The catalog names what may be read, and holds nothing of a sensitive
   * collection (knowledge/tools.ts): no source to record with the chat.
   * Knowledge doesn't record it; the call is, as every call of the chat's.
   */
  async catalog(): Promise<KnowledgeCatalog> {
    const listed = await this.#asAgent(
      async (reader) => await catalog(this.env, reader)
    );
    await auditAgentCall(this.env, this.ctx.props, {
      method: "knowledge.catalog",
      detail: {
        collections: listed.collections.length,
        skills: listed.skills.length,
      },
    });
    return listed;
  }

  async search(query: unknown, options?: unknown): Promise<SearchResults> {
    return await this.#recorded(
      await this.#asAgent(
        async (reader) => await search(this.env, reader, query, options)
      )
    );
  }

  async read(documentId: unknown, options?: unknown): Promise<KnowledgeRead> {
    return await this.#recorded(
      await this.#asAgent(
        async (reader) => await read(this.env, reader, documentId, options)
      )
    );
  }

  async follow(documentId: unknown): Promise<FollowResult> {
    return await this.#recorded(
      await this.#asAgent(
        async (reader) => await follow(this.env, reader, documentId)
      )
    );
  }
}

/** The types `env.knowledge` returns, as the model reads them. */
const knowledgeTypes = `/** Where what a read returned came from. */
interface Provenance {
  collectionIds: string[];
  /** Some of it is from a sensitive collection. */
  sensitive: boolean;
  /** Some of it is restricted: this chat now asks the person before acting outside Grasp. */
  restricted: boolean;
}

/** A document in Knowledge, without its text. */
interface KnowledgeDocument {
  id: string;
  collectionId: string;
  path: string;
  title: string;
  /** \`doc\`, \`skill\`, \`memory\`, \`decision\`, \`file\`, or a Playbook record type. */
  type: string;
  /** When to use it. */
  description: string;
  owner: string;
  tags: string[];
  /** YYYY-MM-DD, if set. */
  reviewDate: string | null;
  currentVersion: number;
  updatedAt: string;
}

/** A section a search matched. */
interface KnowledgeHit {
  documentId: string;
  collectionId: string;
  path: string;
  title: string;
  type: string;
  description: string;
  /** The section's place in its document, from 0: read it with \`read(documentId, { section })\`. */
  section: number;
  headings: string[];
  snippet: string;
}`;

/** What the model reads of `env.knowledge`. */
const knowledgeDeclaration = `/**
 * The company's Knowledge: the collections this chat may read, and their
 * documents. Search, then read what you need, and cite the documents you
 * answer from by title and path. Every read is recorded.
 */
knowledge: {
  /** The collections this chat may read, and the skills in them, cut to fit (\`truncated\` says so). */
  catalog(): Promise<{
    collections: { id: string; name: string; description: string; sensitive: boolean }[];
    skills: { documentId: string; collectionId: string; name: string; description: string }[];
    truncated: boolean;
  }>;
  /** Sections that match \`query\`, best first: 20, or \`limit\` up to 50. */
  search(
    query: string,
    options?: { collectionId?: string; type?: string; limit?: number }
  ): Promise<{ hits: KnowledgeHit[]; provenance: Provenance }>;
  /** A whole document, or one section of it, at its current version. */
  read(
    documentId: string,
    options?: { section?: number }
  ): Promise<KnowledgeDocument & {
    /** The section read, or null for the whole document. */
    section: { position: number; headings: string[] } | null;
    text: string;
    provenance: Provenance;
  }>;
  /** Where a document leads: its [[links]], the documents that link to it, and for a skill, the files in its folder. */
  follow(documentId: string): Promise<{
    links: { path: string; label: string | null; documentId: string | null; title: string | null }[];
    backlinks: { documentId: string; collectionId: string; path: string; title: string; label: string | null }[];
    files: { documentId: string; path: string; title: string; type: string; description: string }[];
    truncated: boolean;
    provenance: Provenance;
  }>;
};`;

/** `env.knowledge`. */
export const knowledgeApi: AgentApi = {
  name: "knowledge",
  types: knowledgeTypes,
  declaration: knowledgeDeclaration,
  stub: (scope) => exports.KnowledgeApi({ props: scope }),
};
