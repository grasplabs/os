import type {
  App,
  AppExports,
  AppFiles,
  AppVersion,
} from "@grasp-os/shared/apps";
import type { Permission } from "@grasp-os/shared/permissions";
import { WorkerEntrypoint, exports } from "cloudflare:workers";

import { asPerson } from "./agent-person.ts";
import type { AgentApi, AgentScope } from "./agent-scope.ts";
import { appExports, listApps, listVersions, readFiles } from "./apps.ts";
import { appsCollectionEnabled } from "./knowledge/access.ts";
import { appsCollectionId } from "./knowledge/app-entries.ts";

// Apps for a chat's code: `await env.apps.list()`. What the chat's person
// sees of Apps themselves (agent-person.ts), once the agent may read the
// Apps collection, where agents find the Apps that already exist before
// anyone builds another (knowledge/apps-collection.ts): the Apps the
// person has a role in, and the files and versions of those they build.
// Every call is audited as the chat's agent acting for them.

/** Whether the agent may read the Apps collection, and so look into Apps. */
const readsApps =
  (env: Env) =>
  (permissions: Permission[]): boolean =>
    // While the Apps collection is off, nobody reads it (knowledge/access.ts).
    appsCollectionEnabled(env) &&
    permissions.some(
      ({ object, actions }) =>
        object.type === "collection" &&
        object.collectionId === appsCollectionId &&
        actions.includes("read")
    );

/** Apps, as a chat's code reads them. */
export class AppsApi extends WorkerEntrypoint<Env, AgentScope> {
  /** The Apps the person has a role in, oldest first. */
  async list(): Promise<App[]> {
    return await asPerson(this.env, this.ctx.props, {
      feature: "apps",
      allowed: readsApps(this.env),
      method: "apps.list",
      read: async (person) => await listApps(this.env, person),
      detail: (listed) => ({ apps: listed.length }),
    });
  }

  /** An App's files at `version`, or its working copy: for its builders. */
  async files(app: unknown, version?: unknown): Promise<AppFiles> {
    return await asPerson(this.env, this.ctx.props, {
      feature: "apps",
      allowed: readsApps(this.env),
      method: "apps.files",
      read: async (person) => await readFiles(this.env, person, app, version),
      detail: (files) => ({
        app: typeof app === "string" ? app : null,
        version: typeof version === "number" ? version : null,
        files: Object.keys(files).length,
      }),
    });
  }

  /**
   * What an App's current version exports to other Apps (the methods they
   * may call under a permission an admin grants): for anyone with a role
   * in it. Read only: nothing here asks for or calls one.
   */
  async exports(
    app: unknown
  ): Promise<{ version: number | null; exports: AppExports }> {
    return await asPerson(this.env, this.ctx.props, {
      feature: "apps",
      allowed: readsApps(this.env),
      method: "apps.exports",
      read: async (person) => await appExports(this.env, person, app),
      detail: (found) => ({
        app: typeof app === "string" ? app : null,
        version: found.version,
        exports: Object.keys(found.exports).length,
      }),
    });
  }

  /** An App's versions, newest first: for its builders. */
  async versions(app: unknown, before?: unknown): Promise<AppVersion[]> {
    return await asPerson(this.env, this.ctx.props, {
      feature: "apps",
      allowed: readsApps(this.env),
      method: "apps.versions",
      read: async (person) => await listVersions(this.env, person, app, before),
      detail: (listed) => ({
        app: typeof app === "string" ? app : null,
        versions: listed.length,
      }),
    });
  }
}

/** What the model reads of `env.apps`. */
const appsDeclaration = `/**
 * The company's Apps that the person has a role in, and the code of those
 * they build. Before suggesting a new App, look for one that already does
 * it: search the Apps collection in Knowledge, then list them here.
 */
apps: {
  /** The Apps the person has a role in, oldest first. */
  list(): Promise<{
    id: string;
    name: string;
    description: string;
    owner: string;
    /** The version that runs; null until one is made current. */
    currentVersion: number | null;
    pendingVersion: number | null;
    createdAt: string;
  }[]>;
  /** An App's files by path, at \`version\`, or its working copy without one. Only for Apps the person builds. */
  files(app: string, version?: number): Promise<Record<string, string>>;
  /**
   * The methods an App's current version lets other Apps call, by name, as
   * its \`app/exports.json\` declares them: whether each only reads or also
   * writes the App's data, and the JSON Schemas of its input and answer.
   * Another App calls one only once an admin grants it a permission on
   * this App's exports. Any App the person has a role in.
   */
  exports(app: string): Promise<{
    /** The current version; null (and no exports) while it has none. */
    version: number | null;
    exports: Record<string, {
      access: "read" | "write";
      description: string;
      input: Record<string, unknown>;
      output: Record<string, unknown>;
    }>;
  }>;
  /** An App's versions, newest first, at most 100 before \`before\`. Only for Apps the person builds. */
  versions(app: string, before?: number): Promise<{
    version: number;
    parent: number | null;
    files: number;
    author: string;
    message: string;
    createdAt: string;
  }[]>;
};`;

/** `env.apps`. */
export const appsApi: AgentApi = {
  name: "apps",
  declaration: appsDeclaration,
  stub: (scope) => exports.AppsApi({ props: scope }),
};
