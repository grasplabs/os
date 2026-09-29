import { Button } from "@grasp-os/ui/components/button";
import { Input } from "@grasp-os/ui/components/input";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { clientIdProblem } from "../../provision/client-id.ts";
import {
  fetchNewClientOptions,
  startClient,
} from "../../provision/functions.ts";
import { useProvisionAction } from "../../provision/use-action.ts";
import { InvalidFieldError } from "../../use-action.ts";

/** A form field with its label and what it's for. */
const Field = ({
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
const textOf = (form: FormData, name: string): string => {
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
const signInOf = (form: FormData) => {
  const entraTenantId = textOf(form, "entraTenantId");
  const googleHostedDomain = textOf(form, "googleHostedDomain");
  if (entraTenantId === "" && googleHostedDomain === "") {
    throw new InvalidFieldError(
      "Give the client's Entra tenant id, its Google Workspace domain, or both."
    );
  }
  return {
    domains: listOf(form, "domains"),
    admins: listOf(form, "admins"),
    ...(entraTenantId === "" ? {} : { entraTenantId }),
    ...(googleHostedDomain === "" ? {} : { googleHostedDomain }),
  };
};

const NewClient = () => {
  const { releases } = Route.useLoaderData();
  const navigate = useNavigate();
  const { busy, failure, run } = useProvisionAction();
  const start = (form: FormData) => {
    const accountId = textOf(form, "accountId");
    const clientId = textOf(form, "clientId");
    void run(async () => {
      // The server's own rule, said before anything is sent.
      const problem = clientIdProblem(clientId);
      if (problem !== null) {
        throw new InvalidFieldError(problem);
      }
      const result = await startClient({
        data: {
          clientId,
          name: textOf(form, "name"),
          releaseId: textOf(form, "releaseId"),
          ring: Number(textOf(form, "ring")),
          signIn: signInOf(form),
          ...(accountId === "" ? {} : { accountId }),
        },
      });
      if (result.clientId !== null) {
        await navigate({
          to: "/clients/$clientId",
          params: { clientId: result.clientId },
        });
      }
      return result;
    });
  };
  const [newest] = releases;
  return (
    <main className="flex max-w-xl flex-col gap-6 p-6">
      <h1 className="text-2xl font-medium">New client</h1>
      {newest === undefined ? (
        <p className="text-muted-foreground">
          No release is imported yet, so there is nothing to deploy.
        </p>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            start(new FormData(event.currentTarget));
          }}
          className="flex flex-col gap-4"
        >
          <Field
            label="Client id"
            hint="Its hostname: lowercase letters, digits and dashes. It can't change."
          >
            <Input name="clientId" required maxLength={50} />
          </Field>
          <Field label="Name" hint="The organisation, as staff know it.">
            <Input name="name" required maxLength={100} />
          </Field>
          <Field
            label="Cloudflare account id"
            hint="An account to adopt, with the deployer a member. Leave it empty to create one (partner accounts only)."
          >
            <Input name="accountId" pattern="[0-9a-f]{32}" />
          </Field>
          <Field label="Release" hint="The release it starts on.">
            <Input
              name="releaseId"
              list="release-ids"
              required
              defaultValue={newest.id}
            />
            <datalist id="release-ids">
              {releases.map((release) => (
                <option key={release.id} value={release.id}>
                  {release.notes}
                </option>
              ))}
            </datalist>
          </Field>
          <Field label="Ring" hint="When rollouts reach it: ring 0 first.">
            <Input
              name="ring"
              type="number"
              min={0}
              required
              defaultValue={1}
            />
          </Field>
          <Field
            label="Entra tenant id"
            hint="The client's Microsoft Entra tenant, if its people sign in with Microsoft."
          >
            <Input name="entraTenantId" />
          </Field>
          <Field
            label="Google Workspace domain"
            hint="The client's Workspace primary domain, if its people sign in with Google."
          >
            <Input name="googleHostedDomain" />
          </Field>
          <Field
            label="Email domains"
            hint="The domains its people sign in with, exactly, separated by commas."
          >
            <Input name="domains" required />
          </Field>
          <Field
            label="Admins"
            hint="Emails that get the admin role when they first sign in, separated by commas."
          >
            <Input name="admins" />
          </Field>
          <div className="flex items-center gap-4">
            <Button type="submit" disabled={busy}>
              Start provisioning
            </Button>
            {failure === null ? null : (
              <p role="alert" className="text-destructive text-sm">
                {failure}
              </p>
            )}
          </div>
        </form>
      )}
    </main>
  );
};

export const Route = createFileRoute("/clients/new")({
  loader: async () => await fetchNewClientOptions(),
  component: NewClient,
});
