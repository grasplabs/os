import { sso } from "@better-auth/sso";
import { roleSchema } from "@grasp-os/shared";
import type { AuditEntry } from "@grasp-os/shared/audit";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import {
  APIError,
  createAuthMiddleware,
  getSessionFromCtx,
} from "better-auth/api";
import { betterAuth } from "better-auth/minimal";
import { organization } from "better-auth/plugins/organization";
import { defaultAc } from "better-auth/plugins/organization/access";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { audit } from "../audit.ts";
import {
  accounts,
  invitations,
  memberRemovals,
  members,
  organizations,
  sessions,
  ssoProviders,
  teamMembers,
  teams,
  users,
  verifications,
} from "../db/core/schema.ts";
import { errorFields, log } from "../log.ts";
import { checkClaims } from "./claims.ts";
import { oidcProviders, providerIds, staffWindowOpen } from "./config.ts";
import type { AuthEnv, SignInConfig } from "./config.ts";

/** Better Auth's routes, under core's API. */
export const authBasePath = "/api/auth";

/** The deployment's one organization, created on the first sign-in. */
export const organizationId = "organization";

const hour = 60 * 60 * 1000;
/**
 * Sessions end after this and are never extended: people sign in with their
 * IdP again, which re-checks them there (an offboarded person keeps access
 * for at most this long without a revocation).
 */
const sessionMs = 12 * hour;
/** Staff sessions end sooner, and never after the staff window closes. */
const staffSessionMs = hour;

/**
 * Roles as the organization plugin checks them. Admins manage members and
 * teams; builders and users manage nothing here. Admin is also the plugin's
 * creator role, which the plugin allows everything it offers; the route
 * allowlist (`routes.ts`) decides what that is.
 */
const roles = {
  admin: defaultAc.newRole({
    member: ["update", "delete"],
    team: ["create", "update", "delete"],
  }),
  builder: defaultAc.newRole({}),
  user: defaultAc.newRole({}),
};

const schema = {
  users,
  sessions,
  accounts,
  verifications,
  organizations,
  members,
  invitations,
  teams,
  teamMembers,
  ssoProviders,
};

/** Better Auth's log lines, message only: arguments can hold tokens or claims. */
const authLogger = {
  level: "warn" as const,
  log: (level: "debug" | "info" | "warn" | "error", message: string) => {
    log[level === "error" ? "error" : "warn"]("auth", { message });
  },
};

const isRemoved = async (env: Env, userId: string): Promise<boolean> => {
  const [removal] = await drizzle(env.DB)
    .select({ userId: memberRemovals.userId })
    .from(memberRemovals)
    .where(
      and(
        eq(memberRemovals.organizationId, organizationId),
        eq(memberRemovals.userId, userId)
      )
    );
  return removal !== undefined;
};

/**
 * Makes someone signing in from the client's IdP a member of the deployment's
 * organization, creating it on the first sign-in, unless an admin removed
 * them. Runs on every sign-in, so a membership whose creation failed is
 * created next time; an existing one, and its role, is kept. Returns whether
 * they are a member.
 *
 * The removal check is part of the insert itself, one statement: a removal
 * records its marker before it deletes the membership, so an insert racing
 * it either lands first and is deleted, or sees the marker and inserts
 * nothing.
 */
const ensureMember = async (
  env: Env,
  config: SignInConfig,
  userId: string
): Promise<boolean> => {
  const db = drizzle(env.DB);
  const [user] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId));
  // Config emails are lowercased when parsed; Better Auth lowercases the IdP's.
  const role =
    user && config.admins.includes(user.email.toLowerCase()) ? "admin" : "user";
  const now = new Date();
  await db
    .insert(organizations)
    .values({
      id: organizationId,
      name: "Organization",
      slug: organizationId,
      createdAt: now,
    })
    .onConflictDoNothing();
  await db.run(sql`
    INSERT INTO ${members} (id, organization_id, user_id, role, created_at)
    SELECT ${crypto.randomUUID()}, ${organizationId}, ${userId}, ${role}, ${now.getTime()}
    WHERE NOT EXISTS (
      SELECT 1 FROM ${memberRemovals}
      WHERE organization_id = ${organizationId} AND user_id = ${userId}
    )
    ON CONFLICT DO NOTHING`);
  return !(await isRemoved(env, userId));
};

/**
 * The session a sign-in through `providerId` gets, or `false` for none.
 * Staff sessions are marked and cut short; everyone else's opens in the
 * deployment's organization, as a member.
 */
const startSession = async <T extends { expiresAt: Date; userId: string }>(
  env: Env,
  config: SignInConfig,
  session: T,
  providerId: string | undefined
) => {
  const now = Date.now();
  if (providerId === providerIds.staff && config.staff) {
    if (!staffWindowOpen(config, now)) {
      return false;
    }
    const expiresAt = Math.min(
      now + staffSessionMs,
      Date.parse(config.staff.until)
    );
    return {
      data: { ...session, staff: true, expiresAt: new Date(expiresAt) },
    };
  }
  const fromClient =
    providerId === providerIds.entra || providerId === providerIds.google;
  if (!(fromClient && (await ensureMember(env, config, session.userId)))) {
    // Sessions come only from an SSO callback, for members.
    return false;
  }
  return {
    data: { ...session, staff: false, activeOrganizationId: organizationId },
  };
};

const idTokenClaimsSchema = z.looseObject({ oid: z.string().optional() });

/** The `oid` claim of an ID token the SSO plugin verified in this request. */
const oidOf = (idToken: unknown): string | null => {
  const payload = typeof idToken === "string" ? idToken.split(".")[1] : "";
  if (payload === undefined || payload === "") {
    return null;
  }
  try {
    const json = atob(payload.replaceAll("-", "+").replaceAll("_", "/"));
    return idTokenClaimsSchema.parse(JSON.parse(json)).oid ?? null;
  } catch {
    return null;
  }
};

/**
 * What is kept of an account from a sign-in: no IdP tokens (core never
 * holds provider tokens, R1), only the Entra object id taken from the ID
 * token before it is dropped.
 */
const withoutTokens = <T extends Record<string, unknown>>(account: T) => ({
  data: {
    ...account,
    ...(account.idToken === undefined ? {} : { oid: oidOf(account.idToken) }),
    accessToken: null,
    refreshToken: null,
    idToken: null,
  },
});

/** The ids a member or team change names; nothing else is recorded. */
const changeSchema = z.looseObject({
  memberId: z.string().optional(),
  memberIdOrEmail: z.string().optional(),
  teamId: z.string().optional(),
  userId: z.string().optional(),
  role: z.union([z.string(), z.array(z.string())]).optional(),
});
const returnedSchema = z.looseObject({
  id: z.string().optional(),
  member: z.looseObject({ id: z.string(), userId: z.string() }).optional(),
});

type Change = z.infer<typeof changeSchema>;
type Returned = z.infer<typeof returnedSchema>;

/**
 * The member and team changes that are audited (R16): what each records,
 * from the request and what the route returned. Identifiers and role names
 * only.
 */
const auditedChanges: Record<
  string,
  (
    change: Change,
    returned: Returned,
    previousRole: string | undefined
  ) => Pick<AuditEntry, "action" | "target" | "detail">
> = {
  "/organization/update-member-role": (change, _returned, previousRole) => ({
    action: "member.role.updated",
    target: { type: "member", id: change.memberId ?? "unknown" },
    detail: {
      previousRole: previousRole ?? null,
      role: [change.role ?? []].flat().join(","),
    },
  }),
  "/organization/remove-member": (_change, returned) => ({
    action: "member.removed",
    target: { type: "member", id: returned.member?.id ?? "unknown" },
    detail: { userId: returned.member?.userId ?? null },
  }),
  "/organization/create-team": (_change, returned) => ({
    action: "team.created",
    target: { type: "team", id: returned.id ?? "unknown" },
  }),
  "/organization/update-team": (change) => ({
    action: "team.updated",
    target: { type: "team", id: change.teamId ?? "unknown" },
  }),
  "/organization/remove-team": (change) => ({
    action: "team.deleted",
    target: { type: "team", id: change.teamId ?? "unknown" },
  }),
  "/organization/add-team-member": (change) => ({
    action: "team.member.added",
    target: { type: "team", id: change.teamId ?? "unknown" },
    detail: { userId: change.userId ?? null },
  }),
  "/organization/remove-team-member": (change) => ({
    action: "team.member.removed",
    target: { type: "team", id: change.teamId ?? "unknown" },
    detail: { userId: change.userId ?? null },
  }),
};

/**
 * Sends an event to the audit log. The change it records has already
 * happened, so a failure is logged rather than turned into a failed request.
 */
const record = async (env: Env, entry: AuditEntry): Promise<void> => {
  try {
    await audit(env).log(entry);
  } catch (error) {
    log.error("audit.failed", { action: entry.action, ...errorFields(error) });
  }
};

/** A member's role before a change, from the request's before hook to its after hook. */
const previousRoles = new WeakMap<object, string>();

const createAuth = (env: AuthEnv, config: SignInConfig) => {
  const db = drizzle(env.DB);
  return betterAuth({
    appName: "Grasp",
    // The deployment's own address from its config, never the request's:
    // core is reached on its workers.dev address through the router.
    baseURL: config.origin,
    basePath: authBasePath,
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, {
      provider: "sqlite",
      usePlural: true,
      schema,
    }),
    // One door out (R13): nothing leaves core but the sign-in itself.
    telemetry: { enabled: false },
    logger: authLogger,
    // Better Auth limits by client IP, but behind the router every request
    // arrives from the router's address, so its limits would throttle the
    // whole deployment as one client (and its store is per isolate). Rate
    // limits on sign-in belong where the client's IP is known: the router.
    rateLimit: { enabled: false },
    session: {
      expiresIn: sessionMs / 1000,
      disableSessionRefresh: true,
      additionalFields: {
        staff: { type: "boolean", defaultValue: false, input: false },
      },
    },
    // Never link an IdP account to an existing user by email.
    account: {
      accountLinking: { enabled: false },
      additionalFields: {
        oid: { type: "string", required: false, input: false },
      },
    },
    advanced: {
      // Host-only cookies (`__Host-`): no Domain, so no other client's
      // hostname under the product domain can read or plant them.
      useSecureCookies: false,
      cookiePrefix: "__Host-grasp",
      defaultCookieAttributes: {
        secure: true,
        httpOnly: true,
        sameSite: "lax",
        path: "/",
      },
    },
    // Failed sign-ins land on the frontend with `?error=<code>`.
    onAPIError: { errorURL: "/" },
    user: {
      // Runs with the verified ID token's claims before a user or account
      // is created or linked, and again on every sign-in.
      validateUserInfo: ({ source }) => {
        const provider = source.sso?.providerId;
        const refusal =
          source.method === "sso-oidc" && provider !== undefined
            ? checkClaims(
                config,
                provider,
                source.sso?.profile ?? {},
                Date.now()
              )
            : "method_not_allowed";
        if (refusal !== undefined) {
          log.warn("auth.refused", { provider, refusal });
        }
        return refusal === undefined ? undefined : { error: refusal };
      },
    },
    databaseHooks: {
      // Sign-in needs no IdP tokens after the claims are checked, so none
      // are kept: core never holds provider tokens (R1).
      // Better Auth's hooks must return promises, even with nothing to await.
      account: {
        create: {
          // oxlint-disable-next-line require-await
          before: async (account) => withoutTokens(account),
        },
        update: {
          // oxlint-disable-next-line require-await
          before: async (account) => withoutTokens(account),
        },
      },
      session: {
        create: {
          before: async (session, context) =>
            await startSession(
              env,
              config,
              session,
              context?.params?.providerId
            ),
          after: async (session) => {
            if (session.staff === true) {
              await record(env, {
                actor: { type: "staff", userId: session.userId },
                action: "staff.session.started",
                target: { type: "session", id: session.id },
                detail: { expiresAt: session.expiresAt.toISOString() },
              });
            }
          },
        },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (context) => {
        if (!context.path.startsWith("/organization/")) {
          return;
        }
        // A removed person's membership row may outlive the removal if
        // deleting it failed; the organization plugin would still trust it.
        const caller = await getSessionFromCtx(context);
        if (caller && (await isRemoved(env, caller.user.id))) {
          throw new APIError("FORBIDDEN", { message: "Not a member." });
        }
        if (context.path !== "/organization/update-member-role") {
          return;
        }
        const { memberId } = changeSchema.parse(context.body);
        const [member] = await db
          .select({ role: members.role })
          .from(members)
          .where(eq(members.id, memberId ?? ""));
        if (member) {
          previousRoles.set(context.context, member.role);
        }
      }),
      after: createAuthMiddleware(async (context) => {
        const describe = auditedChanges[context.path];
        const { returned } = context.context;
        if (describe === undefined || returned instanceof Error) {
          return;
        }
        const actor = await getSessionFromCtx(context);
        if (!actor) {
          return;
        }
        await record(env, {
          actor: { type: "person", userId: actor.user.id },
          ...describe(
            changeSchema.parse(context.body ?? {}),
            returnedSchema.safeParse(returned).data ?? {},
            previousRoles.get(context.context)
          ),
        });
      }),
    },
    plugins: [
      organization({
        roles,
        creatorRole: "admin",
        allowUserToCreateOrganization: false,
        disableOrganizationDeletion: true,
        teams: { enabled: true },
        organizationHooks: {
          // The plugin also accepts its own default roles (owner, member)
          // and lists of roles; a member has exactly one of ours.
          // oxlint-disable-next-line require-await
          beforeUpdateMemberRole: async ({ newRole }) => {
            if (!roleSchema.safeParse(newRole).success) {
              throw new APIError("BAD_REQUEST", { message: "Unknown role." });
            }
          },
          // Recorded before the membership goes, so signing in again can't
          // bring it back even if the removal itself fails halfway.
          beforeRemoveMember: async ({ member }) => {
            await db
              .insert(memberRemovals)
              .values({
                organizationId,
                userId: member.userId,
                removedAt: new Date(),
              })
              .onConflictDoNothing();
          },
        },
      }),
      sso({
        // Providers come only from deployment config, never from the
        // database: registering one in-product is off.
        defaultSSO: oidcProviders(env, config, Date.now()).map((provider) => ({
          providerId: provider.providerId,
          domain: config.domains[0] ?? "",
          oidcConfig: {
            issuer: provider.issuer,
            clientId: provider.clientId,
            clientSecret: provider.clientSecret,
            pkce: true,
            // The plugin's type requires it, but with every endpoint below
            // set it never fetches it.
            discoveryEndpoint: `${provider.issuer}/.well-known/openid-configuration`,
            authorizationEndpoint: provider.authorizationEndpoint,
            tokenEndpoint: provider.tokenEndpoint,
            jwksEndpoint: provider.jwksEndpoint,
            tokenEndpointAuthentication: "client_secret_post",
            scopes: ["openid", "email", "profile"],
          },
        })),
        providersLimit: 0,
      }),
    ],
  });
};

export type Auth = ReturnType<typeof createAuth>;

/**
 * Better Auth for this deployment, or `undefined` while sign-in isn't
 * configured. Fails closed: without the secret or the config nobody is
 * signed in.
 */
export const authFor = (
  env: AuthEnv,
  config: SignInConfig | undefined
): Auth | undefined =>
  config && env.BETTER_AUTH_SECRET ? createAuth(env, config) : undefined;
