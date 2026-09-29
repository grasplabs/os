/**
 * The deployment config every deploy derives for a client's core, before
 * its settings (src/deploy/deploy.ts, where a setting of the same name
 * replaces it): `MODEL_GATEWAY`, naming the AI Gateway the deploy's
 * resources step ensures in the client's account (src/deploy/resources.ts)
 * with the models a new deployment allows, and `SIGN_IN`, from the
 * client's record. Derived
 * on every deploy, so rollouts keep them.
 */
import {
  defaultGatewayModels,
  signInConfigSchema,
  unreachableAdmins,
} from "@grasp-os/shared/deployment-config";
import type { SignInConfig } from "@grasp-os/shared/deployment-config";
import { z } from "zod";

import { DeployError } from "./errors.ts";

/**
 * The AI Gateway in every client's account: one per account, so one name
 * serves them all, and a run that ensures it again finds it.
 */
export const clientGatewayId = "grasp-os";

const { domains, admins } = signInConfigSchema.shape;
const { hostedDomain } = signInConfigSchema.shape.google.unwrap().shape;

/**
 * Why a client's sign-in can't leave it with an admin: the code its issue
 * carries (`params.code`), which the new-client form and a deploy report.
 */
export const adminUnreachable = "admin_unreachable";

/**
 * How a client's people sign in, as its record keeps it: its own Entra
 * tenant, its Google Workspace (by its primary domain), or both; the email
 * domains they sign in with, and who gets the admin role on joining.
 *
 * Refused (`admin_unreachable`) without a first admin, and with one whose
 * email isn't in the email domains: core signs in only those, whichever
 * IdP they come from, so the client would have no admin who can ever
 * sign in. The same check for the form, the server functions and every
 * deploy.
 */
export const clientSignInSchema = z
  .object({
    domains,
    admins,
    entraTenantId: z.guid().optional(),
    googleHostedDomain: hostedDomain.optional(),
  })
  .refine(
    ({ entraTenantId, googleHostedDomain }) =>
      entraTenantId !== undefined || googleHostedDomain !== undefined,
    {
      message: "An Entra tenant or a Google Workspace",
      path: ["entraTenantId"],
    }
  )
  .superRefine((signIn, context) => {
    if (signIn.admins.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["admins"],
        params: { code: adminUnreachable },
        message:
          "Name at least one first admin, with an email in the email domains.",
      });
      return;
    }
    const unreachable = unreachableAdmins(signIn);
    if (unreachable.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["admins"],
        params: { code: adminUnreachable },
        message: `${unreachable.join(", ")} can't sign in: every first admin's email must be in the email domains (${signIn.domains.join(", ")}).`,
      });
    }
  });

/**
 * Why `signIn` isn't a client's sign-in, in words; null when it is.
 */
export const signInProblem = (signIn: unknown): string | null => {
  const parsed = clientSignInSchema.safeParse(signIn);
  if (parsed.success) {
    return null;
  }
  const [issue] = parsed.error.issues;
  return issue?.message ?? "The sign-in isn't complete.";
};
export type ClientSignIn = z.input<typeof clientSignInSchema>;

/**
 * Grasp's multi-tenant OAuth apps' client ids (not secret: their secrets
 * are shared secrets, src/deploy/context.ts). Unset while the console has
 * none for that IdP.
 */
export interface SignInApps {
  entraClientId?: string;
  googleClientId?: string;
}

/**
 * Client `clientId`'s `SIGN_IN`, from its record's `signIn` (JSON), at
 * `https://<clientId>.<domain>`; undefined for a client without one.
 * Refused (`sign_in_incomplete`) when the record doesn't parse (its
 * message says `admin_unreachable` when no first admin could sign in), or
 * it names an IdP the console has no app id for, so no deploy leaves its
 * people unable to sign in unnoticed.
 */
const signInOf = (
  clientId: string,
  signIn: string | null,
  domain: string,
  apps: SignInApps
): SignInConfig | undefined => {
  if (signIn === null) {
    return undefined;
  }
  const incomplete = (why: string): DeployError =>
    new DeployError("sign_in_incomplete", `${clientId}'s sign-in: ${why}`);
  let parsed: unknown = undefined;
  try {
    parsed = JSON.parse(signIn);
  } catch {
    // Not JSON: refused below, as a record that doesn't parse.
  }
  const record = clientSignInSchema.safeParse(parsed);
  if (!record.success) {
    // Named by its code, never its emails: a deploy's error is audited.
    const unreachable = record.error.issues.some(
      (issue) =>
        issue.code === "custom" && issue.params?.code === adminUnreachable
    );
    throw incomplete(
      unreachable
        ? `${adminUnreachable}: no first admin can sign in`
        : "its record doesn't parse"
    );
  }
  const { entraTenantId, googleHostedDomain } = record.data;
  if (entraTenantId !== undefined && apps.entraClientId === undefined) {
    throw incomplete("ENTRA_CLIENT_ID isn't set on the console");
  }
  if (googleHostedDomain !== undefined && apps.googleClientId === undefined) {
    throw incomplete("GOOGLE_CLIENT_ID isn't set on the console");
  }
  const config = signInConfigSchema.safeParse({
    origin: `https://${clientId}.${domain}`,
    domains: record.data.domains,
    admins: record.data.admins,
    ...(entraTenantId === undefined
      ? {}
      : { entra: { tenantId: entraTenantId, clientId: apps.entraClientId } }),
    ...(googleHostedDomain === undefined
      ? {}
      : {
          google: {
            hostedDomain: googleHostedDomain,
            clientId: apps.googleClientId,
          },
        }),
  });
  if (!config.success) {
    throw incomplete("core wouldn't take it");
  }
  return config.data;
};

/** What a client's derived core config is made from. */
export interface CoreConfigInputs {
  clientId: string;
  /** Its record's sign-in, JSON; null when it has none. */
  signIn: string | null;
  /** The domain clients are served under. */
  domain: string;
  apps: SignInApps;
}

/**
 * The deployment config vars a deploy derives for a client's core:
 * `MODEL_GATEWAY` always, `SIGN_IN` when its record has sign-in.
 */
export const derivedCoreConfig = ({
  clientId,
  signIn,
  domain,
  apps,
}: CoreConfigInputs): Record<string, unknown> => {
  const config = signInOf(clientId, signIn, domain, apps);
  return {
    MODEL_GATEWAY: { gateway: clientGatewayId, models: defaultGatewayModels },
    ...(config === undefined ? {} : { SIGN_IN: config }),
  };
};
