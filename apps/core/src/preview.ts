import { appErrors } from "@grasp-os/shared/apps";
import { deadline, whenAborted } from "@grasp-os/shared/deadline";
import type { AppId, ChatId } from "@grasp-os/shared/ids";

import { callTimeoutMs, invokeServer, requireAppMethod } from "./app.ts";
import type { AppAnswer } from "./app.ts";
import { draftFiles } from "./apps.ts";
import { previewBindings } from "./preview-bindings.ts";
import { sandbox } from "./sandbox.ts";
import { buildFailed, buildServer } from "./screens.ts";
import type { Draft } from "./workspace.ts";

// A chat's preview of its draft of an App: the draft's screens, in the
// person's side panel, calling the draft's server code, which runs here
// as a facet of the chat's Workspace object (never of the App's own
// object, whose storage is the App's data). Only the chat's own person
// reaches it, and only while they build the App (chats-rpc.ts).
//
// A preview has no side effects and reads no real data. Its code runs in
// the App sandbox (sandbox.ts: no network, no importable env), with an env
// of preview stubs (preview-bindings.ts, which says what each binding does
// in a preview), and a SQLite database of its own: empty at first, and
// dropped with the facet whenever the draft changes, the chat's draft is
// dropped or proposed, or the chat is deleted. After a restart of the
// object no preview is known, so the next call starts one afresh, its
// database dropped first.

/** The facet a chat's preview of App `app` runs in. */
const facetName = (chatId: ChatId, app: string): string =>
  `preview:${chatId}:${app}`;

/**
 * The draft's server code, as `draft` has it at its revision, as the
 * class its facet runs: loaded unnamed, never kept, as a draft's code
 * changes with each write.
 */
const loadPreview = async (
  env: Env,
  app: AppId,
  draft: Draft
): Promise<DurableObjectClass> => {
  const files = Object.fromEntries(await draftFiles(env, app, draft));
  const build = await buildServer(env, files);
  if (!build.ok) {
    throw appErrors.create("app.build_failed", buildFailed(null, build));
  }
  const bindings = await previewBindings(env, app);
  return env.LOADER.get(null, () => ({
    ...sandbox,
    mainModule: build.mainModule,
    modules: build.modules,
    env: bindings,
  })).getDurableObjectClass("App");
};

/** The previews of one Workspace object's chats (workspace.ts). */
export class Previews {
  readonly #ctx: DurableObjectState;
  readonly #env: Env;

  /**
   * What each preview's facet runs, by facet name: the draft's revision,
   * and its class once loaded. In memory: after a restart none is known
   * (see above).
   */
  readonly #running = new Map<
    string,
    { revision: number; loaded: Promise<DurableObjectClass> }
  >();

  constructor(ctx: DurableObjectState, env: Env) {
    this.#ctx = ctx;
    this.#env = env;
  }

  /**
   * Calls `method` of the server code of `draft`, the chat's draft of
   * `app` at its revision, with `args`, for `personId`, whom the chat is
   * theirs: answers as an App's call does (`App.call`), with `app.failed`
   * for an error of the draft's code, and `app.timed_out` for a call that
   * isn't answered in time.
   */
  async call(
    chatId: ChatId,
    personId: string,
    app: AppId,
    draft: Draft,
    method: string,
    args: unknown[]
  ): Promise<AppAnswer> {
    requireAppMethod(method);
    const limit = deadline(callTimeoutMs(this.#env));
    try {
      // Starting the code counts against the call's time, as for an App.
      const facet = await Promise.race([
        this.#facet(chatId, app, draft),
        whenAborted(limit.signal),
      ]);
      return await Promise.race([
        invokeServer(
          facet,
          // The stubs of a preview act for no one: the token names nothing.
          { userId: personId, mode: "interactive", token: crypto.randomUUID() },
          args,
          { app, version: null, method }
        ),
        whenAborted(limit.signal),
      ]);
    } catch (error) {
      if (limit.signal.aborted) {
        throw appErrors.create("app.timed_out", { version: null, method });
      }
      throw error;
    } finally {
      limit.clear();
    }
  }

  /**
   * The facet previewing `draft`: the one running, while it runs the
   * draft's revision; otherwise a new one, the old one stopped and its
   * database dropped first. One that failed to load is forgotten, so the
   * next call loads it again; one replaced while it loaded (the draft
   * changed meanwhile) is `app.preview_outdated`.
   */
  async #facet(chatId: ChatId, app: AppId, draft: Draft): Promise<Fetcher> {
    const name = facetName(chatId, app);
    let running = this.#running.get(name);
    if (running?.revision !== draft.revision) {
      this.drop(chatId, app);
      running = {
        revision: draft.revision,
        loaded: loadPreview(this.#env, app, draft),
      };
      this.#running.set(name, running);
    }
    let loaded: DurableObjectClass;
    try {
      loaded = await running.loaded;
    } catch (error) {
      if (this.#running.get(name) === running) {
        this.#running.delete(name);
      }
      throw error;
    }
    if (this.#running.get(name) !== running) {
      throw appErrors.create("app.preview_outdated");
    }
    return this.#ctx.facets.get(name, () => ({ class: loaded, id: name }));
  }

  /** Stops the chat's preview of `app`, if one runs, and drops its database. */
  drop(chatId: ChatId, app: string): void {
    const name = facetName(chatId, app);
    this.#running.delete(name);
    this.#ctx.facets.abort(name, new Error("The preview ended."));
    this.#ctx.facets.delete(name);
  }
}
