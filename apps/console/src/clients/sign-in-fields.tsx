/**
 * A client's sign-in as a form asks for it, for the new-client form and
 * the client's settings: the fields, and reading them back.
 */
import { Input } from "@grasp-os/ui/components/input";
import type { ReactNode } from "react";

import { signInProblem } from "../deploy/core-config.ts";
import type { ClientSignInRecord } from "../deploy/core-config.ts";
import { InvalidFieldError } from "../use-action.ts";

/** A form field with its label and what it's for. */
export const Field = ({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: ReactNode;
}) => (
  <label className="flex flex-col gap-1 text-sm">
    <span className="font-medium">{label}</span>
    {children}
    <span className="text-muted-foreground">{hint}</span>
  </label>
);

/** The form's text field `name`, trimmed. */
export const textOf = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
};

const listSeparator = /[\s,]+/u;

/** The form's list field `name`: its entries, split on commas and spaces. */
const listOf = (form: FormData, name: string): string[] =>
  textOf(form, name)
    .split(listSeparator)
    .filter((entry) => entry !== "");

/** The client's sign-in, as the form says it, or why it can't be one. */
export const signInOf = (form: FormData): ClientSignInRecord => {
  const entraTenantId = textOf(form, "entraTenantId");
  const googleHostedDomain = textOf(form, "googleHostedDomain");
  if (entraTenantId === "" && googleHostedDomain === "") {
    throw new InvalidFieldError(
      "Give the client's Entra tenant id, its Google Workspace domain, or both."
    );
  }
  const signIn = {
    domains: listOf(form, "domains"),
    admins: listOf(form, "admins"),
    ...(entraTenantId === "" ? {} : { entraTenantId }),
    ...(googleHostedDomain === "" ? {} : { googleHostedDomain }),
  };
  // The server's own check (a first admin who can sign in, among others),
  // said before anything is sent.
  const problem = signInProblem(signIn);
  if (problem !== null) {
    throw new InvalidFieldError(problem);
  }
  return signIn;
};

/** The sign-in fields, filled with `current` when there is one. */
export const SignInFields = ({
  current,
}: {
  current: ClientSignInRecord | null;
}) => (
  <>
    <Field
      label="Entra tenant id"
      hint="The client's Microsoft Entra tenant, if its people sign in with Microsoft."
    >
      <Input name="entraTenantId" defaultValue={current?.entraTenantId} />
    </Field>
    <Field
      label="Google Workspace domain"
      hint="The client's Workspace primary domain, if its people sign in with Google."
    >
      <Input
        name="googleHostedDomain"
        defaultValue={current?.googleHostedDomain}
      />
    </Field>
    <Field
      label="Email domains"
      hint="The domains its people sign in with, exactly, separated by commas."
    >
      <Input
        name="domains"
        required
        defaultValue={current?.domains.join(", ")}
      />
    </Field>
    <Field
      label="Admins"
      hint="Emails that get the admin role when they first sign in, separated by commas: at least one, each in the email domains."
    >
      <Input name="admins" required defaultValue={current?.admins.join(", ")} />
    </Field>
  </>
);
