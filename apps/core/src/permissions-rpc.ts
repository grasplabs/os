import type {
  Permission,
  PermissionRequest,
  PermissionsApi,
  PermissionSubjectInput,
} from "@grasp-os/shared/permissions";
import { RpcTarget } from "capnweb";

import { appsReadableBy } from "./app-access.ts";
import { appFor, appsListedFor } from "./apps.ts";
import { featureEnabled } from "./features.ts";
import {
  grantPermission,
  listPermissions,
  requestPermission,
  revokePermission,
} from "./permissions.ts";
import { withPerson } from "./session-check.ts";
import type { SessionCheck } from "./session-check.ts";

/**
 * A signed-in person's `permissions`. Each method takes what the client
 * sent as it is: the permission functions validate it, and check the
 * person's role, on every call.
 */
export class PermissionsRpc extends RpcTarget implements PermissionsApi {
  readonly #env: Env;
  readonly #check: SessionCheck;

  constructor(env: Env, check: SessionCheck) {
    super();
    this.#env = env;
    this.#check = check;
  }

  async request(request: PermissionRequest): Promise<Permission> {
    return await withPerson(
      this.#check,
      async (person) =>
        await requestPermission(
          this.#env,
          person,
          request,
          async (app, role) => {
            // While sharing is off, requestPermission's own checks, as before.
            if (featureEnabled(this.#env, "app_sharing")) {
              await appFor(this.#env, person, app, role);
            }
          }
        )
    );
  }

  async grant(id: string): Promise<Permission> {
    return await withPerson(
      this.#check,
      async (person) => await grantPermission(this.#env, person, id)
    );
  }

  async revoke(id: string): Promise<Permission> {
    return await withPerson(
      this.#check,
      async (person) => await revokePermission(this.#env, person, id)
    );
  }

  async list(subject?: PermissionSubjectInput): Promise<Permission[]> {
    return await withPerson(this.#check, async (person) => {
      const listed = await listPermissions(
        this.#env,
        person,
        subject,
        appsListedFor(this.#env, person)
      );
      if (!featureEnabled(this.#env, "app_sharing")) {
        return listed;
      }
      // Of the Apps open to them, only those they may open now: one that
      // read what they can't read (app.unreadable) shows none of its
      // permissions either. Each App named is checked once.
      const named = listed.flatMap(({ subject: of, object }) => [
        ...(of.type === "app" ? [of.appId] : []),
        ...(object.type === "workflow" ? [object.appId] : []),
      ]);
      const readable = await appsReadableBy(this.#env, person, [
        ...new Set(named),
      ]);
      return listed.filter(
        ({ subject: of, object }) =>
          (of.type !== "app" || readable.has(of.appId)) &&
          (object.type !== "workflow" || readable.has(object.appId))
      );
    });
  }
}
